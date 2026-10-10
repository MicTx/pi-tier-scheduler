import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { LoadResult, TierName } from "../../src/config/types";
import type {
  CatalogDiagnostic,
  CatalogResolution,
  PhysicalChatModel,
  ResolvedCandidate,
  ResolvedTier,
} from "../../src/catalog";
import type { RouteLogEntry } from "../../src/diag/route-log";
import {
  buildDoctorReport,
  collectDoctorSnapshot,
  renderDoctorReport,
  type DoctorContext,
  type DoctorSnapshot,
  type RouterStateInspection,
} from "../../src/diag/doctor";
import { inspectCompatibility } from "../../src/diag/compatibility";

/**
 * F6.3 doctor tests (06-fallback-diagnostics.md §7.3 hooks 1–3):
 * the healthy matrix (hook 1), the per-check degradation matrix with stable
 * codes and no raw text (hook 2), severity aggregation, render stability, and
 * the collection contract — fail-soft reads, runtime-config-only sourcing,
 * `getProviderAuthStatus()`-only credential discipline (hook 3), label
 * dropping, entry counting, and zero side effects.
 */

/** Marker that must never appear in any report or rendered line. */
const SECRET = "sk-test-secret-marker";
const PATH_MARKER = "/home/u/.pi/agent/tier-scheduler.json";

function fakeModel(provider: string, id: string): PhysicalChatModel {
  return {
    id,
    name: `${provider}/${id}`,
    api: "openai-completions",
    provider,
    baseUrl: "https://api.example.test/v1",
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    headers: { authorization: `Bearer ${SECRET}` },
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

function loadResult(overrides: Partial<LoadResult> = {}): LoadResult {
  return {
    effective: {
      schemaVersion: 1,
      tiers: {
        brain: { candidates: [{ provider: "acme", id: "brain-1" }] },
        pillar: { candidates: [{ provider: "acme", id: "pillar-1" }] },
        crowd: { candidates: [] },
      },
      policy: { defaultBias: "medium", sticky: true },
      retry: { maxAttemptsPerRequest: 3, maxTierSwitches: 2 },
      provenance: {},
    },
    problems: [],
    paths: { userPath: PATH_MARKER, projectPath: `/work${PATH_MARKER}` },
    layers: { user: "loaded", project: "loaded" },
    ...overrides,
  };
}

function resolvedTier(
  tier: TierName,
  refs: readonly { provider: string; id: string }[],
  skipped: readonly CatalogDiagnostic[] = [],
): ResolvedTier {
  return {
    tier,
    configured: refs.map((ref) => ({ provider: ref.provider, id: ref.id })),
    candidates: refs.map(
      (ref, index): ResolvedCandidate => ({
        tier,
        configIndex: index,
        ref: { provider: ref.provider, id: ref.id },
        key: `${ref.provider}\0${ref.id}`,
        model: fakeModel(ref.provider, ref.id),
      }),
    ),
    skipped,
  };
}

function catalogResolution(
  tiers: Partial<Record<TierName, ResolvedTier>> = {},
  snapshotProblems: CatalogResolution["snapshotProblems"] = [],
  diagnostics: readonly CatalogDiagnostic[] = [],
): CatalogResolution {
  return {
    tiers: {
      brain: tiers.brain ?? resolvedTier("brain", [{ provider: "acme", id: "brain-1" }]),
      pillar: tiers.pillar ?? resolvedTier("pillar", [{ provider: "acme", id: "pillar-1" }]),
      crowd: tiers.crowd ?? resolvedTier("crowd", []),
    },
    diagnostics,
    snapshotProblems,
  };
}

function routerInspection(overrides: Partial<RouterStateInspection> = {}): RouterStateInspection {
  return {
    status: "valid",
    schemaVersion: 1,
    attempts: 1,
    maxAttempts: 3,
    tierSwitches: 0,
    maxTierSwitches: 2,
    issueCodes: [],
    ...overrides,
  };
}

function routeLogEntry(attempt = 1): RouteLogEntry {
  return {
    schemaVersion: 1,
    requestReason: "user",
    outcome: "selected",
    reasonCode: "work_phase",
    selectedTier: "pillar",
    attempt,
    maxAttempts: 3,
    tierSwitches: 0,
    maxTierSwitches: 2,
    fallbackPath: [],
    boundHits: [],
    stateStatus: "valid",
  };
}

function healthySnapshot(): DoctorSnapshot {
  return {
    config: loadResult(),
    catalog: catalogResolution({
      crowd: resolvedTier("crowd", [{ provider: "acme", id: "crowd-1" }]),
    }),
    credentialProviders: [{ provider: "acme", status: "configured", source: "environment" }],
    router: routerInspection(),
    routeLog: { latest: routeLogEntry(), malformedCount: 0, writeFailures: 0, entryCount: 12 },
    compatibility: {
      runtimeVersion: "1.0.4",
      minimumVersion: "1.0.4",
      versionStatus: "pass",
      missingApis: [],
    },
  };
}

function findingOf(report: ReturnType<typeof buildDoctorReport>, code: string) {
  const finding = report.checks.find((check) => check.code === code);
  if (finding === undefined) throw new Error(`missing finding ${code}`);
  return finding;
}

// ---------------------------------------------------------------------------
// buildDoctorReport — healthy matrix (hook 1)
// ---------------------------------------------------------------------------

describe("buildDoctorReport — healthy snapshot", () => {
  it("reports pass for every check in the frozen order and pass overall", () => {
    const report = buildDoctorReport(healthySnapshot());
    expect(report.checks.map((check) => check.code)).toEqual([
      "config",
      "catalog",
      "credentials",
      "router_state",
      "route_log",
      "compatibility",
    ]);
    expect(report.checks.every((check) => check.severity === "pass")).toBe(true);
    expect(report.severity).toBe("pass");
    expect(report.schemaVersion).toBe(1);
    expect(report.generatedFrom).toBe("session");
  });

  it("renders the §3.5 canonical form for a healthy session", () => {
    const text = renderDoctorReport(buildDoctorReport(healthySnapshot()));
    expect(text).toBe(
      [
        "pi-tier-scheduler doctor",
        "",
        "pass:",
        "  config         effective schema=1; problems=0",
        "  catalog        brain=1/1; pillar=1/1; crowd=1/1; unavailable=0",
        "  credentials    configured=1; missing=0; unknown=0",
        "  router state   schema=1; attempts=1/3; tier-switches=0/2",
        "  route log      entries=12; malformed=0; write-failures=0",
        "  compatibility  Pi 1.0.4; required API surface present",
        "",
        "result: pass · 6 checks · 0 error · 0 warning · 6 pass",
      ].join("\n"),
    );
  });
});

// ---------------------------------------------------------------------------
// buildDoctorReport — per-check degradation matrix (hook 2)
// ---------------------------------------------------------------------------

describe("buildDoctorReport — config check", () => {
  it("warns config_not_loaded when the runtime load is not ready", () => {
    const snapshot = healthySnapshot();
    snapshot.config = undefined;
    const finding = findingOf(buildDoctorReport(snapshot), "config");
    expect(finding.severity).toBe("warning");
    expect(finding.summary).toBe("not loaded (built-in defaults in effect)");
    expect(finding.details).toEqual(["config_not_loaded"]);
  });

  it("errors on schema problems with error severity and lists stable codes only", () => {
    const snapshot = healthySnapshot();
    snapshot.config = loadResult({
      problems: [
        {
          source: "user",
          path: "retry.maxAttemptsPerRequest",
          severity: "error",
          code: "BOUNDS_EXCEEDED",
          message: `value exceeds ceiling at ${PATH_MARKER} (${SECRET})`,
        },
        {
          source: "project",
          path: "tiers.brain",
          severity: "warning",
          code: "TYPE_MISMATCH",
          message: `wrong type (${SECRET})`,
        },
      ],
      layers: { user: "invalid", project: "loaded" },
    });
    const report = buildDoctorReport(snapshot);
    const finding = findingOf(report, "config");
    expect(finding.severity).toBe("error");
    expect(finding.summary).toBe("effective schema=1; problems=2");
    expect(finding.details[0]).toBe("sources: user=invalid; project=loaded");
    expect(finding.details[1]).toBe("problems: BOUNDS_EXCEEDED(1); TYPE_MISMATCH(1)");
    expect(report.severity).toBe("error");
    // Redaction: raw problem messages, paths, and secrets never reach the report.
    const text = renderDoctorReport(report);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(PATH_MARKER);
  });

  it("passes with a missing-layer source label when no problems exist (§5.6)", () => {
    const snapshot = healthySnapshot();
    snapshot.config = loadResult({ layers: { user: "missing", project: "missing" } });
    const finding = findingOf(buildDoctorReport(snapshot), "config");
    expect(finding.severity).toBe("pass");
    expect(finding.details).toEqual(["sources: user=missing; project=missing"]);
  });
});

describe("buildDoctorReport — catalog check", () => {
  it("errors with registry_snapshot_failed when the registry snapshot failed", () => {
    const snapshot = healthySnapshot();
    snapshot.catalog = catalogResolution(
      {},
      [{ operation: "availability_snapshot" }],
      [{ tier: "brain", code: "registry_snapshot_failed", severity: "error", operation: "availability_snapshot" }],
    );
    const report = buildDoctorReport(snapshot);
    const finding = findingOf(report, "catalog");
    expect(finding.severity).toBe("error");
    expect(finding.details).toContain("registry_snapshot_failed");
    expect(report.severity).toBe("error");
  });

  it("warns on empty and exhausted tiers with the tier counts in the summary", () => {
    const snapshot = healthySnapshot();
    snapshot.catalog = catalogResolution({ crowd: resolvedTier("crowd", []) });
    const finding = findingOf(buildDoctorReport(snapshot), "catalog");
    expect(finding.severity).toBe("warning");
    expect(finding.summary).toBe("brain=1/1; pillar=1/1; crowd=0/0; unavailable=0");
  });

  it("warns on skipped candidates with per-tier detail lines", () => {
    const snapshot = healthySnapshot();
    const skipped: readonly CatalogDiagnostic[] = [
      {
        tier: "pillar",
        candidateIndex: 0,
        ref: { provider: "acme", id: "pillar-1" },
        code: "candidate_not_available",
        severity: "warning",
      },
      {
        tier: "brain",
        candidateIndex: 0,
        ref: { provider: "acme", id: "brain-1" },
        code: "candidate_not_found",
        severity: "warning",
      },
    ];
    snapshot.catalog = catalogResolution(
      {
        brain: resolvedTier("brain", []),
        pillar: resolvedTier("pillar", []),
      },
      [],
      skipped,
    );
    snapshot.catalog.tiers.brain.skipped = [skipped[1]!];
    snapshot.catalog.tiers.pillar.skipped = [skipped[0]!];
    snapshot.catalog.tiers.brain.configured = [{ provider: "acme", id: "brain-1" }];
    snapshot.catalog.tiers.pillar.configured = [{ provider: "acme", id: "pillar-1" }];
    const finding = findingOf(buildDoctorReport(snapshot), "catalog");
    expect(finding.severity).toBe("warning");
    expect(finding.summary).toBe("brain=0/1; pillar=0/1; crowd=0/0; unavailable=1");
    expect(finding.details).toEqual([
      "brain: candidate_not_found(1)",
      "pillar: candidate_not_available(1)",
    ]);
  });
});

describe("buildDoctorReport — credentials check", () => {
  it("warns with provider_auth_missing for missing providers", () => {
    const snapshot = healthySnapshot();
    snapshot.credentialProviders = [
      { provider: "acme", status: "configured" },
      { provider: "ghost", status: "missing" },
    ];
    const finding = findingOf(buildDoctorReport(snapshot), "credentials");
    expect(finding.severity).toBe("warning");
    expect(finding.summary).toBe("configured=1; missing=1; unknown=0");
    expect(finding.details).toEqual(["provider_auth_missing: ghost"]);
  });

  it("warns with provider_auth_unknown when the presence call failed", () => {
    const snapshot = healthySnapshot();
    snapshot.credentialProviders = [{ provider: "acme", status: "unknown" }];
    const finding = findingOf(buildDoctorReport(snapshot), "credentials");
    expect(finding.severity).toBe("warning");
    expect(finding.details).toEqual(["provider_auth_unknown: acme"]);
  });
});

describe("buildDoctorReport — router_state check", () => {
  it("passes on absent state as informational", () => {
    const snapshot = healthySnapshot();
    snapshot.router = routerInspection({
      status: "absent",
      schemaVersion: undefined,
      attempts: 0,
      tierSwitches: 0,
    });
    const finding = findingOf(buildDoctorReport(snapshot), "router_state");
    expect(finding.severity).toBe("pass");
    expect(finding.summary).toBe("state=absent; attempts=0/3; tier-switches=0/2");
  });

  it("warns with state_recovered for recovered state", () => {
    const snapshot = healthySnapshot();
    snapshot.router = routerInspection({ status: "recovered", issueCodes: ["state_recovered"] });
    const finding = findingOf(buildDoctorReport(snapshot), "router_state");
    expect(finding.severity).toBe("warning");
    expect(finding.summary).toBe("schema=1; attempts=1/3; tier-switches=0/2");
    expect(finding.details).toEqual(["state_recovered"]);
  });

  it("errors with state_invalid for irrecoverable state", () => {
    const snapshot = healthySnapshot();
    snapshot.router = routerInspection({
      status: "invalid",
      schemaVersion: undefined,
      attempts: 0,
      tierSwitches: 0,
      issueCodes: ["state_invalid"],
    });
    const finding = findingOf(buildDoctorReport(snapshot), "router_state");
    expect(finding.severity).toBe("error");
    expect(finding.summary).toBe("schema=unknown; attempts=0/3; tier-switches=0/2");
    expect(finding.details).toEqual(["state_invalid"]);
  });

  it("warns with control_recovered and over-cap codes", () => {
    const snapshot = healthySnapshot();
    snapshot.router = routerInspection({
      status: "valid",
      attempts: 4,
      tierSwitches: 3,
      issueCodes: ["control_recovered", "attempts_over_config_cap", "tier_switches_over_config_cap"],
    });
    const finding = findingOf(buildDoctorReport(snapshot), "router_state");
    expect(finding.severity).toBe("warning");
    expect(finding.details).toEqual([
      "control_recovered",
      "attempts_over_config_cap",
      "tier_switches_over_config_cap",
    ]);
  });
});

describe("buildDoctorReport — route_log check", () => {
  it("warns on malformed records and write failures", () => {
    const snapshot = healthySnapshot();
    snapshot.routeLog = {
      latest: routeLogEntry(),
      malformedCount: 2,
      writeFailures: 1,
      entryCount: 3,
    };
    const finding = findingOf(buildDoctorReport(snapshot), "route_log");
    expect(finding.severity).toBe("warning");
    expect(finding.summary).toBe("entries=3; malformed=2; write-failures=1");
    expect(finding.details).toEqual(["route_log_malformed", "route_log_write_failed"]);
  });

  it("passes on a clean empty log for a fresh session", () => {
    const snapshot = healthySnapshot();
    snapshot.routeLog = { malformedCount: 0, writeFailures: 0, entryCount: 0 };
    const finding = findingOf(buildDoctorReport(snapshot), "route_log");
    expect(finding.severity).toBe("pass");
    expect(finding.summary).toBe("entries=0; malformed=0; write-failures=0");
  });
});

describe("buildDoctorReport — compatibility check", () => {
  it("errors with below_floor for a below-floor version", () => {
    const snapshot = healthySnapshot();
    snapshot.compatibility = {
      runtimeVersion: "0.9.9",
      minimumVersion: "1.0.4",
      versionStatus: "error",
      missingApis: [],
    };
    const finding = findingOf(buildDoctorReport(snapshot), "compatibility");
    expect(finding.severity).toBe("error");
    expect(finding.summary).toBe("Pi 0.9.9; below compatibility floor 1.0.4");
    expect(finding.details).toEqual(["below_floor"]);
  });

  it("errors with api_missing and the missing face names", () => {
    const snapshot = healthySnapshot();
    snapshot.compatibility = {
      runtimeVersion: "1.0.4",
      minimumVersion: "1.0.4",
      versionStatus: "pass",
      missingApis: ["appendEntry", "provider_auth_status"],
    };
    const finding = findingOf(buildDoctorReport(snapshot), "compatibility");
    expect(finding.severity).toBe("error");
    expect(finding.summary).toBe("Pi 1.0.4; missing APIs=2");
    expect(finding.details).toEqual(["api_missing", "appendEntry", "provider_auth_status"]);
  });

  it("warns with version_unknown when the version cannot be verified", () => {
    const snapshot = healthySnapshot();
    snapshot.compatibility = {
      runtimeVersion: undefined,
      minimumVersion: "1.0.4",
      versionStatus: "warning",
      missingApis: [],
    };
    const finding = findingOf(buildDoctorReport(snapshot), "compatibility");
    expect(finding.severity).toBe("warning");
    expect(finding.summary).toBe("Pi unknown; required API surface present");
    expect(finding.details).toEqual(["version_unknown"]);
  });

  it("caps compatibility details at four lines", () => {
    const snapshot = healthySnapshot();
    snapshot.compatibility = {
      runtimeVersion: "1.0.4",
      minimumVersion: "1.0.4",
      versionStatus: "pass",
      missingApis: [
        "registerVirtualModel",
        "registerCommand",
        "appendEntry",
        "session_branch_access",
        "model_find",
        "model_availability",
        "provider_auth_status",
      ],
    };
    const finding = findingOf(buildDoctorReport(snapshot), "compatibility");
    expect(finding.details).toHaveLength(4);
    expect(finding.details[0]).toBe("api_missing");
  });
});

describe("buildDoctorReport — severity aggregation and stability", () => {
  it("takes the maximum severity across checks", () => {
    const errorCase = healthySnapshot();
    errorCase.compatibility = {
      runtimeVersion: "0.9.9",
      minimumVersion: "1.0.4",
      versionStatus: "error",
      missingApis: [],
    };
    expect(buildDoctorReport(errorCase).severity).toBe("error");

    const warningCase = healthySnapshot();
    warningCase.routeLog = { malformedCount: 1, writeFailures: 0, entryCount: 1 };
    const report = buildDoctorReport(warningCase);
    expect(report.severity).toBe("warning");
    expect(report.checks.every((check) => check.severity !== "error")).toBe(true);
  });

  it("produces byte-equal reports and renders for equal snapshots", () => {
    const first = buildDoctorReport(healthySnapshot());
    const second = buildDoctorReport(healthySnapshot());
    expect(first).toEqual(second);
    expect(renderDoctorReport(first)).toBe(renderDoctorReport(second));
  });

  it("renders detail lines indented under their check", () => {
    const snapshot = healthySnapshot();
    snapshot.credentialProviders = [{ provider: "ghost", status: "missing" }];
    const text = renderDoctorReport(buildDoctorReport(snapshot));
    const lines = text.split("\n");
    const credentialsIndex = lines.findIndex((line) => line.trim().startsWith("credentials"));
    expect(lines[credentialsIndex]).toBe("  credentials    configured=0; missing=1; unknown=0");
    expect(lines[credentialsIndex + 1]).toBe("    provider_auth_missing: ghost");
  });

  it("contains no ANSI or control sequences", () => {
    const text = renderDoctorReport(buildDoctorReport(healthySnapshot()));
    expect(text).not.toMatch(/\u001b\[/);
    expect(text).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
  });
});

// ---------------------------------------------------------------------------
// collectDoctorSnapshot — collection contract (hooks 1–3, spec §2.2)
// ---------------------------------------------------------------------------

function vmStateEntry(state: unknown): SessionEntry {
  return {
    type: "custom",
    customType: "pi.virtual-model-state",
    data: { provider: "ts", modelId: "auto", state },
  } as unknown as SessionEntry;
}

function routeEntry(entry: Partial<RouteLogEntry> = {}): SessionEntry {
  return {
    type: "custom",
    customType: "pi-tier-scheduler.route-decision",
    data: { ...routeLogEntry(), ...entry },
  } as unknown as SessionEntry;
}

function controlEntry(manualOverride: string | null): SessionEntry {
  return {
    type: "custom",
    customType: "pi-tier-scheduler.router-control",
    data: { schemaVersion: 1, manualOverride },
  } as unknown as SessionEntry;
}

function validRouterState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    turn: 1,
    phase: "implementation",
    complexity: "standard",
    bias: "medium",
    manualOverride: null,
    sticky: false,
    attempts: 1,
    tierSwitches: 0,
    attempted: [],
    activeTier: "pillar",
    activeCandidate: { provider: "acme", id: "pillar-1" },
    activeThinking: "medium",
    ...overrides,
  };
}

/**
 * Fake registry with the two catalog faces plus `getProviderAuthStatus`.
 * The credential-resolution faces exist as spies that fail the credential
 * discipline if doctor ever calls them (hook 3).
 */
function fakeRegistry(options: {
  available?: PhysicalChatModel[] | "throw";
  found?: Map<string, PhysicalChatModel | undefined>;
  auth?: Record<string, { configured: boolean; source?: string; label?: string } | "throw">;
} = {}) {
  const getApiKeyAndHeaders = vi.fn(() => {
    throw new Error("doctor must never resolve credentials");
  });
  const hasConfiguredAuth = vi.fn(() => {
    throw new Error("doctor must never call hasConfiguredAuth");
  });
  const refreshModels = vi.fn(() => {
    throw new Error("doctor must never refresh models");
  });
  const getProviderAuthStatus = vi.fn((provider: string) => {
    const status = options.auth?.[provider];
    if (status === "throw" || status === undefined) {
      throw new Error("no auth status for provider");
    }
    return { configured: status.configured, ...(status.source ? { source: status.source } : {}), ...(status.label ? { label: status.label } : {}) };
  });
  const registry = {
    find: (provider: string, id: string): Model<Api> | undefined => {
      if (options.found !== undefined) return options.found.get(`${provider}\0${id}`) as Model<Api> | undefined;
      return fakeModel(provider, id);
    },
    getAvailable: (): Model<Api>[] => {
      if (options.available === "throw") throw new Error(`registry snapshot failure ${SECRET}`);
      return (options.available ?? [fakeModel("acme", "brain-1"), fakeModel("acme", "pillar-1")]).map(
        (model) => model as Model<Api>,
      );
    },
    getProviderAuthStatus,
    getApiKeyAndHeaders,
    hasConfiguredAuth,
    refreshModels,
  };
  return {
    registry,
    getProviderAuthStatus,
    getApiKeyAndHeaders,
    hasConfiguredAuth,
    refreshModels,
  };
}

function doctorContext(options: {
  branch?: readonly SessionEntry[];
  registry?: ReturnType<typeof fakeRegistry>["registry"] | "omit";
  probes?: Partial<Record<string, () => boolean>>;
  runtimeVersion?: string | undefined;
  config?: LoadResult | undefined;
  writeFailures?: number;
} = {}): DoctorContext {
  const defaultRegistry = fakeRegistry({
    auth: { acme: { configured: true, source: "environment", label: `Bearer ${SECRET}` } },
  });
  const registry = options.registry === "omit" ? undefined : options.registry ?? defaultRegistry.registry;
  return {
    ctx: {
      modelRegistry: registry as never,
      sessionManager: {
        getBranch: () => [...(options.branch ?? [])],
      } as never,
    },
    apiProbes: {
      registerVirtualModel: () => true,
      registerCommand: () => true,
      appendEntry: () => true,
      ...options.probes,
    },
    runtimeVersion: options.runtimeVersion,
    getConfig: () => options.config,
    getRouteLogHealth: () => ({ writeFailures: options.writeFailures ?? 0 }),
  };
}

describe("collectDoctorSnapshot — healthy collection", () => {
  it("collects a fully passing snapshot end to end", () => {
    const ctor = doctorContext({
      config: loadResult(),
      runtimeVersion: "1.0.4",
      branch: [vmStateEntry(validRouterState()), routeEntry()],
    });
    const report = buildDoctorReport(collectDoctorSnapshot(ctor));
    expect(report.severity).toBe("warning"); // crowd tier is empty in the config fixture
    const catalog = findingOf(report, "catalog");
    expect(catalog.summary).toBe("brain=1/1; pillar=1/1; crowd=0/0; unavailable=0");
    expect(findingOf(report, "config").severity).toBe("pass");
    expect(findingOf(report, "credentials").severity).toBe("pass");
    expect(findingOf(report, "router_state").summary).toBe("schema=1; attempts=1/3; tier-switches=0/2");
    expect(findingOf(report, "route_log").summary).toBe("entries=1; malformed=0; write-failures=0");
    expect(findingOf(report, "compatibility").severity).toBe("pass");
  });

  it("keeps only the safe auth source and drops the free-text label (hook 3 redaction)", () => {
    const ctor = doctorContext({ config: loadResult() });
    const snapshot = collectDoctorSnapshot(ctor);
    expect(snapshot.credentialProviders).toEqual([
      { provider: "acme", status: "configured", source: "environment" },
    ]);
    const text = renderDoctorReport(buildDoctorReport(snapshot));
    expect(text).not.toContain(SECRET);
  });

  it("calls only getProviderAuthStatus on the registry for credential presence (hook 3)", () => {
    const fake = fakeRegistry({
      auth: {
        acme: { configured: true, source: "environment" },
        ghost: "throw",
      },
    });
    const ctor = doctorContext({ config: loadResult(), registry: fake.registry });
    const snapshot = collectDoctorSnapshot(ctor);
    expect(fake.getProviderAuthStatus).toHaveBeenCalledTimes(1);
    expect(fake.getApiKeyAndHeaders).not.toHaveBeenCalled();
    expect(fake.hasConfiguredAuth).not.toHaveBeenCalled();
    expect(fake.refreshModels).not.toHaveBeenCalled();
    expect(snapshot.credentialProviders).toEqual([{ provider: "acme", status: "configured", source: "environment" }]);
  });

  it("maps a missing provider to missing and a throwing provider to unknown", () => {
    const fake = fakeRegistry({
      auth: {
        acme: { configured: false },
        ghost: "throw",
      },
    });
    const config = loadResult();
    config.effective.tiers.pillar = { candidates: [{ provider: "ghost", id: "pillar-1" }] };
    const ctor = doctorContext({ config, registry: fake.registry });
    const finding = findingOf(buildDoctorReport(collectDoctorSnapshot(ctor)), "credentials");
    expect(finding.severity).toBe("warning");
    expect(finding.summary).toBe("configured=0; missing=1; unknown=1");
    expect(finding.details).toEqual(["provider_auth_missing: acme", "provider_auth_unknown: ghost"]);
  });

  it("drops a foreign auth source value", () => {
    const fake = fakeRegistry({
      auth: { acme: { configured: true, source: "not-a-real-source" } },
    });
    const ctor = doctorContext({ config: loadResult(), registry: fake.registry });
    const snapshot = collectDoctorSnapshot(ctor);
    expect(snapshot.credentialProviders).toEqual([{ provider: "acme", status: "configured" }]);
  });
});

describe("collectDoctorSnapshot — fail-soft and sourcing rules", () => {
  it("reads an empty branch when the session manager throws", () => {
    const ctor = doctorContext({ config: loadResult() });
    (ctor.ctx.sessionManager as { getBranch: () => SessionEntry[] }).getBranch = () => {
      throw new Error("session manager unavailable");
    };
    const snapshot = collectDoctorSnapshot(ctor);
    expect(snapshot.router.status).toBe("absent");
    expect(snapshot.routeLog.entryCount).toBe(0);
    expect(findingOf(buildDoctorReport(snapshot), "router_state").severity).toBe("pass");
  });

  it("surfaces a registry snapshot failure as the only catalog error", () => {
    const fake = fakeRegistry({ available: "throw" });
    const ctor = doctorContext({ config: loadResult(), registry: fake.registry });
    const finding = findingOf(buildDoctorReport(collectDoctorSnapshot(ctor)), "catalog");
    expect(finding.severity).toBe("error");
    expect(finding.details).toContain("registry_snapshot_failed");
    const text = renderDoctorReport(buildDoctorReport(collectDoctorSnapshot(ctor)));
    expect(text).not.toContain(SECRET);
  });

  it("resolves the catalog against the built-in defaults when config is not loaded", () => {
    const ctor = doctorContext({ config: undefined, runtimeVersion: "1.0.4" });
    const snapshot = collectDoctorSnapshot(ctor);
    const config = findingOf(buildDoctorReport(snapshot), "config");
    expect(config.severity).toBe("warning");
    expect(config.details).toEqual(["config_not_loaded"]);
    expect(findingOf(buildDoctorReport(snapshot), "catalog").summary).toBe(
      "brain=0/0; pillar=0/0; crowd=0/0; unavailable=0",
    );
    // Default caps stay in force for the router counters.
    expect(findingOf(buildDoctorReport(snapshot), "router_state").summary).toBe(
      "state=absent; attempts=0/3; tier-switches=0/2",
    );
  });

  it("counts valid route entries while the frozen reader reports latest and newer malformed", () => {
    const malformed = {
      type: "custom",
      customType: "pi-tier-scheduler.route-decision",
      data: { schemaVersion: 99, garbage: SECRET },
    } as unknown as SessionEntry;
    const ctor = doctorContext({
      config: loadResult(),
      branch: [routeEntry(), routeEntry({ attempt: 2 }), malformed],
    });
    const snapshot = collectDoctorSnapshot(ctor);
    expect(snapshot.routeLog.entryCount).toBe(2);
    expect(snapshot.routeLog.malformedCount).toBe(1);
    expect(snapshot.routeLog.latest?.attempt).toBe(2);
    const text = renderDoctorReport(buildDoctorReport(snapshot));
    expect(text).not.toContain(SECRET);
  });

  it("inspects the latest ts/auto virtual-model state through the Phase 4 sanitizer", () => {
    const ctor = doctorContext({
      config: loadResult(),
      branch: [vmStateEntry(validRouterState({ attempts: 2, tierSwitches: 1 }))],
    });
    const snapshot = collectDoctorSnapshot(ctor);
    expect(snapshot.router.status).toBe("valid");
    expect(snapshot.router.attempts).toBe(2);
    expect(snapshot.router.tierSwitches).toBe(1);
  });

  it("warns state_recovered for a stale state the sanitizer rebuilds", () => {
    const ctor = doctorContext({
      config: loadResult(),
      branch: [vmStateEntry(validRouterState({ phase: "mystery-phase" }))],
    });
    const snapshot = collectDoctorSnapshot(ctor);
    expect(snapshot.router.status).toBe("recovered");
    expect(snapshot.router.issueCodes).toEqual(["state_recovered"]);
  });

  it("errors state_invalid for an ts/auto state with an unknown schema", () => {
    const ctor = doctorContext({
      config: loadResult(),
      branch: [vmStateEntry({ schemaVersion: 42, junk: true })],
    });
    const snapshot = collectDoctorSnapshot(ctor);
    expect(snapshot.router.status).toBe("invalid");
    expect(snapshot.router.issueCodes).toEqual(["state_invalid"]);
  });

  it("skips virtual-model-state entries of other models and stays absent", () => {
    const foreign = {
      type: "custom",
      customType: "pi.virtual-model-state",
      data: { provider: "other", modelId: "auto", state: { schemaVersion: 1 } },
    } as unknown as SessionEntry;
    const ctor = doctorContext({ config: loadResult(), branch: [foreign] });
    expect(collectDoctorSnapshot(ctor).router.status).toBe("absent");
  });

  it("warns control_recovered when the latest control entry is malformed", () => {
    const malformedControl = {
      type: "custom",
      customType: "pi-tier-scheduler.router-control",
      data: { schemaVersion: 1, manualOverride: "weird" },
    } as unknown as SessionEntry;
    const ctor = doctorContext({
      config: loadResult(),
      branch: [controlEntry(null), malformedControl, vmStateEntry(validRouterState())],
    });
    const snapshot = collectDoctorSnapshot(ctor);
    expect(snapshot.router.issueCodes).toEqual(["control_recovered"]);
  });

  it("warns over-config-cap counters defensively against the effective config", () => {
    const narrowCaps = loadResult();
    narrowCaps.effective.retry = { maxAttemptsPerRequest: 1, maxTierSwitches: 0 };
    const ctor = doctorContext({
      config: narrowCaps,
      branch: [vmStateEntry(validRouterState({ attempts: 2, tierSwitches: 1 }))],
    });
    const snapshot = collectDoctorSnapshot(ctor);
    expect(snapshot.router.issueCodes).toEqual([
      "attempts_over_config_cap",
      "tier_switches_over_config_cap",
    ]);
  });
});

describe("collectDoctorSnapshot — compatibility probing", () => {
  it("reads the pi-side presence through the supplied probe map", () => {
    const ctor = doctorContext({
      config: loadResult(),
      runtimeVersion: "1.0.4",
      probes: { appendEntry: () => false },
    });
    const snapshot = collectDoctorSnapshot(ctor);
    expect(snapshot.compatibility.missingApis).toEqual(["appendEntry"]);
  });

  it("treats a throwing probe as an absent face", () => {
    const ctor = doctorContext({
      config: loadResult(),
      runtimeVersion: "1.0.4",
      probes: { registerCommand: (): boolean => {
        throw new Error("probe boom");
      } },
    });
    const snapshot = collectDoctorSnapshot(ctor);
    expect(snapshot.compatibility.missingApis).toEqual(["registerCommand"]);
  });

  it("probes the ctx-side faces from the command context", () => {
    const ctor = doctorContext({ config: loadResult(), runtimeVersion: "1.0.4", registry: "omit" });
    const snapshot = collectDoctorSnapshot(ctor);
    expect(snapshot.compatibility.missingApis).toEqual([
      "model_find",
      "model_availability",
      "provider_auth_status",
    ]);
  });

  it("flows the runtime version through to the snapshot", () => {
    const ctor = doctorContext({ config: loadResult(), runtimeVersion: "0.9.9" });
    const snapshot = collectDoctorSnapshot(ctor);
    expect(snapshot.compatibility.runtimeVersion).toBe("0.9.9");
    expect(snapshot.compatibility.versionStatus).toBe("error");
  });
});

describe("collectDoctorSnapshot — purity and zero side effects (hook 4)", () => {
  it("produces equal snapshots on repeated runs and never mutates the branch", () => {
    const branch = [vmStateEntry(validRouterState()), routeEntry(), controlEntry(null)];
    const frozen = structuredClone(branch);
    const ctor = doctorContext({ config: loadResult(), runtimeVersion: "1.0.4", branch });
    const first = collectDoctorSnapshot(ctor);
    const second = collectDoctorSnapshot(ctor);
    expect(first).toEqual(second);
    expect(branch).toEqual(frozen);
  });
});

beforeEach(() => {
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});
