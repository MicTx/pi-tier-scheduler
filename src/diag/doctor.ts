/**
 * `/ts doctor` — read-only diagnostics (06-fallback-diagnostics.md §3.5/§4.3,
 * §5.5/§5.6, §6.5, F6.3).
 *
 * Three separable layers:
 * - `collectDoctorSnapshot` — thin, fail-soft collection: the runtime config
 *   load (never a re-parse), a fresh Phase 3 catalog resolution, provider-auth
 *   presence through `getProviderAuthStatus()` only, branch router/control
 *   state through the Phase 4 sanitizer, route-log health, and the
 *   compatibility probe. Expected failures map to stable finding inputs;
 *   nothing here writes a file, appends a branch entry, refreshes a model,
 *   or reads a credential value.
 * - `buildDoctorReport` / `renderDoctorReport` — pure assembly and rendering:
 *   six checks in the frozen order, machine-readable reasons (stable codes,
 *   counts, identities — no raw error text, paths, or credential labels).
 * - `handleDoctor` — the only command face: zero-argument validation, one
 *   collection, one assembly, one mode-safe response, one runtime record.
 *
 * Zero-side-effect invariant (§3.6 #9): running doctor changes no model
 * selection, thinking level, override, config, router state, or branch entry,
 * and the same snapshot always assembles the same report.
 */
import type {
  ExtensionCommandContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { defaultConfig } from "../config/defaults";
import type { EffectiveConfig, LoadResult, TierName } from "../config/types";
import { CATALOG_TIER_ORDER, resolveCatalog } from "../catalog";
import type { CatalogResolution } from "../catalog/types";
import {
  readLatestRouterControl,
  sanitizeRouterState,
} from "../routing";
import { TS_VIRTUAL_MODEL_ID, TS_VIRTUAL_PROVIDER } from "../routing/virtual-model";
import { respond } from "../ui/respond";
import type { RespondSeverity } from "../ui/respond";

import {
  inspectCompatibility,
  type CompatibilitySnapshot,
  type PiApiName,
  type RequiredApiName,
} from "./compatibility";
import {
  readLatestRouteLog,
  ROUTE_DECISION_ENTRY,
  validateRouteLogEntry,
  type RouteLogReadResult,
} from "./route-log";

// ---------------------------------------------------------------------------
// Frozen report types (06 §3.5/§4.3)
// ---------------------------------------------------------------------------

export type DoctorSeverity = "pass" | "warning" | "error";

export type DoctorCheckCode =
  | "config"
  | "catalog"
  | "credentials"
  | "router_state"
  | "route_log"
  | "compatibility";

export type DoctorFinding = {
  code: string;
  severity: DoctorSeverity;
  summary: string;
  details: readonly string[];
};

export type DoctorReport = {
  schemaVersion: 1;
  severity: DoctorSeverity;
  checks: readonly DoctorFinding[];
  generatedFrom: "session";
};

/** Router-state inspection result (06 §4.3, frozen shape). */
export type RouterStateInspection = {
  status: "valid" | "recovered" | "invalid" | "absent";
  schemaVersion?: number;
  attempts: number;
  maxAttempts: number;
  tierSwitches: number;
  maxTierSwitches: number;
  issueCodes: readonly string[];
};

/** Safe source vocabulary of Pi's `AuthStatus`; the free-text label is dropped. */
export type AuthSource =
  | "stored"
  | "runtime"
  | "environment"
  | "fallback"
  | "models_json_key"
  | "models_json_command";

export type CredentialProviderStatus = {
  provider: string;
  status: "configured" | "missing" | "unknown";
  source?: AuthSource;
};

/**
 * Doctor snapshot (06 §4.3). Two documented deviations from the phase-doc
 * block, both forced by the F6.3 spec:
 * - `config` is relaxed to optional for the load-race case (spec §2.2): the
 *   config check must warn `config_not_loaded` when the runtime load has not
 *   completed, never fabricate a pass — the same relaxation `/ts status`
 *   already carries.
 * - `routeLog` adds `entryCount`, the doctor-owned count of valid
 *   route-decision records on the branch (reusing the F6.2 validator, no
 *   route-log change): the §3.5 canonical render line carries `entries=N`,
 *   which the reader's frozen `{latest, malformedCount}` shape cannot express.
 */
export type DoctorSnapshot = {
  config: LoadResult | undefined;
  catalog: CatalogResolution;
  credentialProviders: readonly CredentialProviderStatus[];
  router: RouterStateInspection;
  routeLog: RouteLogReadResult & { writeFailures: number; entryCount: number };
  compatibility: CompatibilitySnapshot;
};

/**
 * The pi-surface the wiring supplies: the host `VERSION` (the package's
 * peer-resolved import — never a bunded copy) plus presence probes for the
 * three `ExtensionAPI` faces. The ctx-side faces are probed from the command
 * context `DoctorContext` already carries, so no whole `ExtensionAPI` ever
 * reaches this module.
 */
export type DoctorApiSurface = {
  runtimeVersion: string | undefined;
  apiProbes: Readonly<Record<PiApiName, () => boolean>>;
};

/** Narrow dependencies collection reads (spec §2.4). */
export type DoctorContext = {
  ctx: Pick<ExtensionCommandContext, "modelRegistry" | "sessionManager">;
  apiProbes: DoctorApiSurface["apiProbes"];
  runtimeVersion: string | undefined;
  getConfig(): LoadResult | undefined;
  getRouteLogHealth(): { writeFailures: number };
};

/** Dependencies the command face threads through from dispatch wiring. */
export type DoctorDependencies = {
  getConfig(): LoadResult | undefined;
  getRouteLogHealth(): { writeFailures: number };
  getDoctorApi(): DoctorApiSurface;
  recordDoctorReport(report: DoctorReport): void;
};

/** Hard cap on detail lines per finding (spec §2.4). */
const DETAILS_CAP = 4;

/** Six-check display labels (§3.5 canonical block). */
const CHECK_LABELS: Readonly<Record<string, string>> = {
  config: "config",
  catalog: "catalog",
  credentials: "credentials",
  router_state: "router state",
  route_log: "route log",
  compatibility: "compatibility",
};

const SEVERITY_RANK: Readonly<Record<DoctorSeverity, number>> = {
  pass: 0,
  warning: 1,
  error: 2,
};

function capDetails(details: readonly string[]): readonly string[] {
  return details.slice(0, DETAILS_CAP);
}

function maxSeverity(severities: readonly DoctorSeverity[]): DoctorSeverity {
  let worst: DoctorSeverity = "pass";
  for (const severity of severities) {
    if (SEVERITY_RANK[severity] > SEVERITY_RANK[worst]) worst = severity;
  }
  return worst;
}

/** Built-in defaults as the effective view doctor falls back to (spec §2.2). */
function builtinDefaults(): EffectiveConfig {
  return { ...defaultConfig(), provenance: {} };
}

/** Branch read is fail-soft (same rule as status): a broken manager reads empty. */
function branchEntriesOf(
  ctx: DoctorContext["ctx"],
): SessionEntry[] {
  try {
    return ctx.sessionManager.getBranch();
  } catch {
    return [];
  }
}

function isAuthSource(value: unknown): value is AuthSource {
  return (
    value === "stored" ||
    value === "runtime" ||
    value === "environment" ||
    value === "fallback" ||
    value === "models_json_key" ||
    value === "models_json_command"
  );
}

/**
 * Distinct providers referenced by configured candidates, in deterministic
 * tier-then-authored order. Auth presence uses `getProviderAuthStatus()`
 * exclusively: `configured`/`missing` map through, a throw or a foreign
 * shape maps to `unknown`, the source enum passes through when it is one of
 * the safe values, and the free-text label never survives collection.
 */
function collectCredentialProviders(
  effective: EffectiveConfig,
  registry: DoctorContext["ctx"]["modelRegistry"],
): CredentialProviderStatus[] {
  const seen = new Set<string>();
  const providers: string[] = [];
  for (const tier of CATALOG_TIER_ORDER) {
    for (const ref of effective.tiers[tier].candidates) {
      if (seen.has(ref.provider)) continue;
      seen.add(ref.provider);
      providers.push(ref.provider);
    }
  }
  return providers.map((provider): CredentialProviderStatus => {
    let status: { configured?: unknown; source?: unknown } | undefined;
    try {
      status = registry?.getProviderAuthStatus(provider);
    } catch {
      status = undefined;
    }
    if (status !== null && typeof status === "object") {
      if (status.configured === true) {
        const configured: CredentialProviderStatus = { provider, status: "configured" };
        if (isAuthSource(status.source)) configured.source = status.source;
        return configured;
      }
      if (status.configured === false) return { provider, status: "missing" };
    }
    return { provider, status: "unknown" };
  });
}

/**
 * Latest `pi.virtual-model-state` payload for `ts/auto` on this branch,
 * scanning newest-first past unrelated or malformed entries. The SDK owns the
 * custom type; `state` is untrusted and only ever handed to the Phase 4
 * sanitizer.
 */
function latestTsAutoState(
  branch: readonly SessionEntry[],
): unknown {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry.type !== "custom" || entry.customType !== "pi.virtual-model-state") continue;
    const data: unknown = (entry as { data?: unknown }).data;
    if (
      typeof data !== "object" ||
      data === null ||
      (data as Record<string, unknown>).provider !== TS_VIRTUAL_PROVIDER ||
      (data as Record<string, unknown>).modelId !== TS_VIRTUAL_MODEL_ID
    ) {
      continue;
    }
    return (data as Record<string, unknown>).state;
  }
  return undefined;
}

/**
 * Router-state inspection (spec §2.2): absent entry → `absent`; present state
 * runs the Phase 4 sanitizer — any recovered field (including a normalized
 * bias) → `recovered`, no usable state → `invalid`. Counters are then
 * defensively compared against the effective config caps (the sanitizer
 * clamps to the absolute code ceilings, so a cap breach can only mean the
 * effective config narrowed below persisted counters), and a recovered
 * control entry contributes its own issue code.
 */
function inspectRouterState(
  branch: readonly SessionEntry[],
  effective: EffectiveConfig,
): RouterStateInspection {
  const maxAttempts = effective.retry.maxAttemptsPerRequest;
  const maxTierSwitches = effective.retry.maxTierSwitches;
  const raw = latestTsAutoState(branch);
  if (raw === undefined) {
    return {
      status: "absent",
      attempts: 0,
      maxAttempts,
      tierSwitches: 0,
      maxTierSwitches,
      issueCodes: [],
    };
  }
  const sanitized = sanitizeRouterState(raw, effective.policy.defaultBias);
  if (sanitized.state === undefined) {
    return {
      status: "invalid",
      attempts: 0,
      maxAttempts,
      tierSwitches: 0,
      maxTierSwitches,
      issueCodes: ["state_invalid"],
    };
  }
  const recovered = sanitized.recovered || sanitized.biasRecovered;
  const issueCodes: string[] = recovered ? ["state_recovered"] : [];
  if (readLatestRouterControl(branch).recovered) {
    issueCodes.push("control_recovered");
  }
  const attempts = sanitized.state.attempts;
  const tierSwitches = sanitized.state.tierSwitches;
  if (attempts > maxAttempts) issueCodes.push("attempts_over_config_cap");
  if (tierSwitches > maxTierSwitches) issueCodes.push("tier_switches_over_config_cap");
  return {
    status: recovered ? "recovered" : "valid",
    schemaVersion: sanitized.state.schemaVersion,
    attempts,
    maxAttempts,
    tierSwitches,
    maxTierSwitches,
    issueCodes,
  };
}

/** Valid route-decision records on the branch (doctor-owned count, §3.5 render). */
function countRouteEntries(branch: readonly SessionEntry[]): number {
  let count = 0;
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== ROUTE_DECISION_ENTRY) continue;
    if (validateRouteLogEntry((entry as { data?: unknown }).data) !== undefined) {
      count += 1;
    }
  }
  return count;
}

/**
 * Probe the required API surface: pi-side faces through the supplied probe
 * map (a throwing probe reads as absent), ctx-side faces from the command
 * context collection already holds.
 */
function probeApiSurface(ctor: DoctorContext): Record<RequiredApiName, boolean> {
  const present = {} as Record<RequiredApiName, boolean>;
  const piNames: readonly PiApiName[] = ["registerVirtualModel", "registerCommand", "appendEntry"];
  for (const name of piNames) {
    try {
      present[name] = ctor.apiProbes[name]() === true;
    } catch {
      present[name] = false;
    }
  }
  const registry = ctor.ctx.modelRegistry as
    | { find?: unknown; getAvailable?: unknown; getProviderAuthStatus?: unknown }
    | undefined;
  const sessionManager = ctor.ctx.sessionManager as { getBranch?: unknown } | undefined;
  present.session_branch_access = typeof sessionManager?.getBranch === "function";
  present.model_find = typeof registry?.find === "function";
  present.model_availability = typeof registry?.getAvailable === "function";
  present.provider_auth_status = typeof registry?.getProviderAuthStatus === "function";
  return present;
}

// ---------------------------------------------------------------------------
// Collection (thin, fail-soft)
// ---------------------------------------------------------------------------

/**
 * Assemble one snapshot from the narrow dependencies. Every read is expected
 * to be able to fail: a broken branch reads empty, a broken registry surfaces
 * through the catalog snapshot problems, a broken auth call reads `unknown`,
 * and the config check reports the runtime load exactly as it stands. The
 * catalog resolves against the effective config in force right now — the
 * runtime load, or the built-in defaults while that load is still in flight.
 */
export function collectDoctorSnapshot(ctor: DoctorContext): DoctorSnapshot {
  const config = ctor.getConfig();
  const effective = config?.effective ?? builtinDefaults();
  const branch = branchEntriesOf(ctor.ctx);
  const read = readLatestRouteLog(branch);
  return {
    config,
    catalog: resolveCatalog(effective, ctor.ctx.modelRegistry),
    credentialProviders: collectCredentialProviders(effective, ctor.ctx.modelRegistry),
    router: inspectRouterState(branch, effective),
    routeLog: {
      latest: read.latest,
      malformedCount: read.malformedCount,
      writeFailures: ctor.getRouteLogHealth().writeFailures,
      entryCount: countRouteEntries(branch),
    },
    compatibility: inspectCompatibility({
      runtimeVersion: ctor.runtimeVersion,
      apiPresent: probeApiSurface(ctor),
    }),
  };
}

// ---------------------------------------------------------------------------
// Pure report assembly
// ---------------------------------------------------------------------------

/** Distinct problem codes with counts, first-seen order, capped at four. */
function problemCodeSummary(problems: LoadResult["problems"]): string {
  const counts = new Map<string, number>();
  for (const problem of problems) {
    counts.set(problem.code, (counts.get(problem.code) ?? 0) + 1);
  }
  const parts = [...counts].slice(0, DETAILS_CAP).map(([code, count]) => `${code}(${count})`);
  return `problems: ${parts.join("; ")}`;
}

function configFinding(config: DoctorSnapshot["config"]): DoctorFinding {
  if (config === undefined) {
    return {
      code: "config",
      severity: "warning",
      summary: "not loaded (built-in defaults in effect)",
      details: ["config_not_loaded"],
    };
  }
  const problems = config.problems;
  const severity = maxSeverity(problems.map((problem) => problem.severity));
  const details: string[] = [];
  if (config.layers.user !== "loaded" || config.layers.project !== "loaded") {
    details.push(`sources: user=${config.layers.user}; project=${config.layers.project}`);
  }
  if (problems.length > 0) {
    details.push(problemCodeSummary(problems));
  }
  return {
    code: "config",
    severity,
    summary: `effective schema=${config.effective.schemaVersion}; problems=${problems.length}`,
    details: capDetails(details),
  };
}

function catalogFinding(catalog: CatalogResolution): DoctorFinding {
  const tierCounts = CATALOG_TIER_ORDER.map(
    (tier) =>
      `${tier}=${catalog.tiers[tier].candidates.length}/${catalog.tiers[tier].configured.length}`,
  ).join("; ");
  const unavailable = catalog.diagnostics.filter(
    (diagnostic) => diagnostic.code === "candidate_not_available",
  ).length;
  const snapshotFailed = catalog.snapshotProblems.length > 0;
  const details: string[] = [];
  if (snapshotFailed) details.push("registry_snapshot_failed");
  for (const tier of CATALOG_TIER_ORDER) {
    const skipped = catalog.tiers[tier].skipped;
    if (skipped.length === 0) continue;
    const counts = new Map<string, number>();
    for (const diagnostic of skipped) {
      counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
    }
    const parts = [...counts].map(([code, count]) => `${code}(${count})`);
    details.push(`${tier}: ${parts.join("; ")}`);
  }
  const warning =
    CATALOG_TIER_ORDER.some(
      (tier) =>
        catalog.tiers[tier].candidates.length === 0 ||
        catalog.tiers[tier].skipped.length > 0,
    ) || details.length > (snapshotFailed ? 1 : 0);
  return {
    code: "catalog",
    severity: snapshotFailed ? "error" : warning ? "warning" : "pass",
    summary: `${tierCounts}; unavailable=${unavailable}`,
    details: capDetails(details),
  };
}

function credentialsFinding(
  providers: readonly CredentialProviderStatus[],
): DoctorFinding {
  const configured = providers.filter((entry) => entry.status === "configured").length;
  const missing = providers.filter((entry) => entry.status === "missing").length;
  const unknown = providers.filter((entry) => entry.status === "unknown").length;
  const details = providers
    .filter((entry) => entry.status !== "configured")
    .slice(0, DETAILS_CAP)
    .map((entry) =>
      entry.status === "missing"
        ? `provider_auth_missing: ${entry.provider}`
        : `provider_auth_unknown: ${entry.provider}`,
    );
  return {
    code: "credentials",
    severity: missing + unknown > 0 ? "warning" : "pass",
    summary: `configured=${configured}; missing=${missing}; unknown=${unknown}`,
    details,
  };
}

function routerStateFinding(router: RouterStateInspection): DoctorFinding {
  const counters = `attempts=${router.attempts}/${router.maxAttempts}; tier-switches=${router.tierSwitches}/${router.maxTierSwitches}`;
  const summary =
    router.status === "absent"
      ? `state=absent; ${counters}`
      : router.status === "invalid"
        ? `schema=unknown; ${counters}`
        : `schema=${router.schemaVersion ?? 1}; ${counters}`;
  const severity =
    router.status === "invalid"
      ? "error"
      : router.issueCodes.length > 0
        ? "warning"
        : "pass";
  return {
    code: "router_state",
    severity,
    summary,
    details: capDetails([...router.issueCodes]),
  };
}

function routeLogFinding(routeLog: DoctorSnapshot["routeLog"]): DoctorFinding {
  const details: string[] = [];
  if (routeLog.malformedCount > 0) details.push("route_log_malformed");
  if (routeLog.writeFailures > 0) details.push("route_log_write_failed");
  return {
    code: "route_log",
    severity: details.length > 0 ? "warning" : "pass",
    summary: `entries=${routeLog.entryCount}; malformed=${routeLog.malformedCount}; write-failures=${routeLog.writeFailures}`,
    details,
  };
}

function compatibilityFinding(
  compatibility: CompatibilitySnapshot,
): DoctorFinding {
  const version = compatibility.runtimeVersion ?? "unknown";
  if (compatibility.missingApis.length > 0) {
    return {
      code: "compatibility",
      severity: "error",
      summary: `Pi ${version}; missing APIs=${compatibility.missingApis.length}`,
      details: capDetails(["api_missing", ...compatibility.missingApis]),
    };
  }
  if (compatibility.versionStatus === "error") {
    return {
      code: "compatibility",
      severity: "error",
      summary: `Pi ${version}; below compatibility floor ${compatibility.minimumVersion}`,
      details: ["below_floor"],
    };
  }
  if (compatibility.versionStatus === "warning") {
    return {
      code: "compatibility",
      severity: "warning",
      summary: "Pi unknown; required API surface present",
      details: ["version_unknown"],
    };
  }
  return {
    code: "compatibility",
    severity: "pass",
    summary: `Pi ${version}; required API surface present`,
    details: [],
  };
}

/**
 * Assemble the six-check report in the frozen order: config, catalog,
 * credentials, router_state, route_log, compatibility. `severity` is the
 * maximum of the findings. The report carries only stable codes, counts, and
 * identities — the builders above never interpolate raw errors or paths.
 */
export function buildDoctorReport(snapshot: DoctorSnapshot): DoctorReport {
  const checks: readonly DoctorFinding[] = [
    configFinding(snapshot.config),
    catalogFinding(snapshot.catalog),
    credentialsFinding(snapshot.credentialProviders),
    routerStateFinding(snapshot.router),
    routeLogFinding(snapshot.routeLog),
    compatibilityFinding(snapshot.compatibility),
  ];
  return {
    schemaVersion: 1,
    severity: maxSeverity(checks.map((check) => check.severity)),
    checks,
    generatedFrom: "session",
  };
}

// ---------------------------------------------------------------------------
// Pure rendering (§3.5 canonical block)
// ---------------------------------------------------------------------------

/**
 * Render the canonical plain-text form: header, `result:` line, then one
 * `<label>: <severity> (<summary>)` line per check in report order, with each
 * bounded detail as an indented follow-up line. Stable labels, no ANSI or
 * control sequences, no dynamic content beyond the already-bounded finding
 * fields.
 */
export function renderDoctorReport(report: DoctorReport): string {
  const labelWidth = Math.max(
    "check".length,
    ...report.checks.map((finding) => (CHECK_LABELS[finding.code] ?? finding.code).length),
  );
  const lines: string[] = [
    "pi-tier-scheduler doctor",
    `result: ${report.severity}`,
    "",
    `${"check".padEnd(labelWidth)}  status    summary`,
  ];
  for (const finding of report.checks) {
    const label = CHECK_LABELS[finding.code] ?? finding.code;
    lines.push(`${label.padEnd(labelWidth)}  ${finding.severity.padEnd(9)} ${finding.summary}`);
    for (const detail of finding.details) {
      lines.push(`  ${detail}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Command face (§5.5)
// ---------------------------------------------------------------------------

/**
 * Fixed usage error for trailing arguments, mirroring the parser's stable
 * error grammar (`invalid arguments for '<head>'; usage: ...`). The parser
 * keeps doctor's argument tail so Phase 6 owns this check; its
 * `SUPPORTED_FORMS` constant is module-private, so the fixed text lives here.
 */
export const DOCTOR_USAGE_ERROR = "invalid arguments for 'doctor'; usage: /ts doctor";

/** Report severity → response severity: `pass` maps to `info` (spec §2.2). */
export function severityForReport(severity: DoctorSeverity): RespondSeverity {
  return severity === "pass" ? "info" : severity;
}

/**
 * `/ts doctor` — the only command face (§5.5): zero-argument validation,
 * one collection, one pure assembly, one runtime record, one mode-safe
 * response. Read-only by construction: no `appendEntry`, no config write, no
 * model or thinking mutation, no dialog, and stdout is never written
 * directly — `respond` owns the channel split.
 */
export async function handleDoctor(
  args: string,
  ctx: ExtensionCommandContext,
  deps: DoctorDependencies,
): Promise<void> {
  if (args.trim() !== "") {
    respond(ctx, DOCTOR_USAGE_ERROR, "warning");
    return;
  }
  const api = deps.getDoctorApi();
  const snapshot = collectDoctorSnapshot({
    ctx,
    apiProbes: api.apiProbes,
    runtimeVersion: api.runtimeVersion,
    getConfig: () => deps.getConfig(),
    getRouteLogHealth: () => deps.getRouteLogHealth(),
  });
  const report = buildDoctorReport(snapshot);
  deps.recordDoctorReport(report);
  respond(ctx, renderDoctorReport(report), severityForReport(report.severity));
}
