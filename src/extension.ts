import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";

import { defaultConfig } from "./config/defaults";
import {
  loadEffectiveConfig,
  readConfigLayerForEdit,
  saveConfigFile,
} from "./config/index";
import type { EffectiveConfig, LoadResult, ThinkingBias } from "./config/types";
import {
  classifyFailure,
  createVirtualModelRegistration,
  inspectRouteFailure,
  readLatestRouterControl,
  routeRequest,
  RoutingError,
} from "./routing";
import type { TierName } from "./routing";
import type { AutoModelRoute } from "./routing/virtual-model";
import { TS_VIRTUAL_MODEL_ID, TS_VIRTUAL_PROVIDER } from "./routing/virtual-model";
import type { RouteDecision, RouteRequest, RouterState } from "./routing/types";
import {
  appendRouteLog,
  createRouteLogSink,
  renderRouteLogEntry,
  ROUTE_DECISION_ENTRY,
  ROUTE_LOG_SCHEMA_VERSION,
  validateRouteLogEntry,
  type RouteLogEntry,
  type RouteLogFailed,
  type RouteLogSink,
} from "./diag/route-log";
import type { DoctorApiSurface, DoctorReport } from "./diag/doctor";
import type { LastDispatchSummary } from "./commands/types";
import { TIER_BIAS } from "./commands/control";
import { COMMAND_NAME } from "./shared/constants";
import { completeArguments, dispatch, type TsDispatchDependencies } from "./commands/dispatch";
import {
  breathingFooterText,
  clearFooterStatus,
  FOOTER_BREATH_FRAMES,
  FOOTER_STATUS_KEY,
  refreshFooterStatus,
  type FooterDispatch,
  type FooterStatusContext,
} from "./ui/status";
import { respond } from "./ui/respond";

/**
 * Host run mode ("tui" | "rpc" | "json" | "print"). Derived from the
 * SDK's ExtensionContext because the package root does not re-export
 * the named ExtensionMode union.
 */
export type SessionMode = ExtensionContext["mode"];

/**
 * /ts command family (docs/plans/01-scaffold.md §3, F1.2) plus the F5.1
 * runtime seam: the session_start config load, the branch-latest dispatch
 * summary recorded by the route adapter, and the command dependency
 * assembly (05-commands.md §3.2/§3.3, 04-routing.md §2.4). F6.2 adds the
 * route-decision log: one per-session `RouteLogSink` over `appendEntry`
 * plus the runtime diagnostics the sink feeds (06-fallback-diagnostics.md
 * §3.4/§4.2/§4.4).
 *
 * This module owns the extension lifecycle: command registration, the
 * session_start/session_shutdown handlers, and the runtime state they
 * maintain. Subcommand bodies arrive in phases 5–7; the structure
 * registered here does not change.
 */

/** Fixed response once the session has shut down (§3 rule 3). */
export const SHUTDOWN_NOTICE = "tier-scheduler is shutting down";

/** Live runtime snapshot for the current module instance (§5.1). */
export interface SessionRuntimeState {
  /** Epoch ms of the most recent session_start. */
  startedAt: number;
  /** Host mode of the most recent session_start (tui/rpc/json/print). */
  mode: SessionMode;
  /** Number of session_start events this module instance has seen. */
  startCount: number;
  /** Epoch ms of session_shutdown; null while the runtime is live (§5.3). */
  shutdownAt: number | null;
  /**
   * Phase 2 load result once the session_start load completed; undefined
   * while the load is in flight (or never ran), which routes on the
   * built-in defaults and renders the fixed not-loaded status line.
   */
  configLoad: LoadResult | undefined;
  /**
   * Latest physical dispatch summary recorded by the route adapter;
   * undefined before the first successful route of this runtime.
   */
  lastDispatch: LastDispatchSummary | undefined;
  /**
   * F6.3: the report of the latest successful `/ts doctor` run — a bounded,
   * redacted snapshot for tests and later consumers, never a second source
   * of routing truth. Reset with the runtime at session_start and released
   * at shutdown like the other per-runtime snapshots (spec §2.2/§4.4).
   */
  lastDoctor?: DoctorReport;
  /**
   * F7.1 config-runtime seam: the revision of the current `configLoad`
   * snapshot. Absent until the first post-save reload; `applyConfigReload`
   * maintains it as (previous ?? 1) + 1, so the externally observed value
   * starts at 1 and increments once per successful reload (07 §5.1). Being
   * optional keeps lifecycle `toEqual` snapshots stable (F6.3 precedent).
   */
  configRevision?: number;
  /**
   * F7.1 flow mutex: true while the TUI configuration wizard is active, so
   * a second init/config is rejected without a nested dialog (07 §3.4).
   * Absent means false; a fresh session starts with no flow.
   */
  flowActive?: boolean;
  /**
   * F6.2 route-decision log failures this session: every record the sink
   * could not persist (schema-invalid payload or a throwing `appendEntry`).
   * The sink owns the live count; this field mirrors it after each append
   * so `/ts doctor` (F6.3) and tests read one runtime number. Reset with
   * the runtime at session_start; kept across shutdown like `startCount`.
   */
  routeLogWriteFailures: number;
  /**
   * Per-session route-log sink; assembled at session_start from the live
   * Pi API and branch reader, undefined before the first start.
   */
  routeLog: RouteLogSink | undefined;
  /**
   * F7.2: true once a footer `setStatus` landed in this runtime — the
   * idempotence guard for the shutdown clear (07 §3.8). Absent means false;
   * optional so lifecycle `toEqual` snapshots stay stable (F6.3 precedent).
   */
  footerStatusSet?: boolean;
  /**
   * F7.2: a save succeeded but its reload did not — `/ts status` and
   * `/ts doctor` report it; the next successful reload clears it
   * (07 §3.7). Absent means false.
   */
  reloadPending?: boolean;
}

// Module-scoped by design (§3 rule 2): state dies with the module
// instance, so a reload starts from a clean runtime and no state crosses
// module instances. The lifecycle tests reset the module registry to
// exercise exactly that guarantee.
let runtimeState: SessionRuntimeState | null = null;

/**
 * Control mutation queue tail (05-commands.md §3.7): one serialized chain per
 * module instance. Each queued operation runs after the previous one
 * settles — success or failure — so commands serialize in arrival order and
 * a failed mutation never poisons the tail; the caller still sees its own
 * outcome. `handleSessionStart` resets it with the runtime; the existing
 * shutdown intercept in `handleTsCommand` guarantees no new mutation starts
 * after shutdown.
 */
let controlTail: Promise<unknown> = Promise.resolve();

/**
 * Serialize one control mutation behind the queue tail (§3.7). Never rejects
 * the tail itself: a rejected operation maps the tail back to a resolved
 * promise so later commands still run, while the caller receives the
 * operation's own result or rejection unswallowed.
 */
export function enqueueControlMutation<T>(operation: () => Promise<T>): Promise<T> {
  const run = controlTail.then(operation);
  controlTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Reset the queue with the runtime: a new session starts a fresh chain. */
function resetControlTail(): void {
  controlTail = Promise.resolve();
}

/**
 * Config save queue tail (07 §3.7/§4.3, F7.1 spec §2.2): one serialized
 * chain per module instance for the save+reload composite, mirroring the
 * control-queue pattern — operations run strictly one after another, a
 * failure never poisons the tail, and a new session_start resets it.
 */
let configSaveTail: Promise<unknown> = Promise.resolve();

/** Serialize one config save+reload operation behind the queue tail. */
export function enqueueConfigSave<T>(operation: () => Promise<T>): Promise<T> {
  const run = configSaveTail.then(operation);
  configSaveTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Reset the config queue with the runtime: a new session starts fresh. */
function resetConfigSaveTail(): void {
  configSaveTail = Promise.resolve();
}

/** Accessor for the current module instance's runtime state. */
export function getRuntimeState(): SessionRuntimeState | null {
  return runtimeState;
}

/**
 * Pure create-or-revive step for session_start: keeps the module
 * instance's startCount, records the newest start time and mode, and
 * always clears shutdownAt plus the per-runtime config/dispatch snapshots
 * and the route-log diagnostics — a new session starts with no inherited
 * load, dispatch, or log-failure count.
 */
export function ensureSessionState(
  existing: SessionRuntimeState | null,
  mode: SessionMode,
  now: number,
): SessionRuntimeState {
  return {
    startedAt: now,
    mode,
    startCount: (existing?.startCount ?? 0) + 1,
    shutdownAt: null,
    configLoad: undefined,
    lastDispatch: undefined,
    lastDoctor: undefined,
    routeLogWriteFailures: 0,
    routeLog: undefined,
  };
}

/**
 * Pure shutdown marker: idempotent — once shutdownAt is set, later
 * calls leave the state unchanged. The first mark also releases the
 * per-runtime snapshots so shut-down state never serves stale config or
 * dispatch data. The route-log diagnostics follow the `startCount`
 * pattern instead: they are facts about this runtime instance, not
 * snapshots of external data, and the adapter never appends after
 * shutdown.
 */
export function markSessionShutdown(
  state: SessionRuntimeState,
  now: number,
): SessionRuntimeState {
  if (state.shutdownAt !== null) {
    return state;
  }
  return {
    ...state,
    shutdownAt: now,
    configLoad: undefined,
    lastDispatch: undefined,
    lastDoctor: undefined,
  };
}

/** Built-in defaults as an effective value: nothing participated, empty provenance. */
export function builtinEffectiveConfig(): EffectiveConfig {
  return { ...defaultConfig(), provenance: {} };
}

/**
 * Pure projection of one route decision into the bounded status summary
 * (05-commands.md §4.2). When the config load was not ready at route time,
 * the adapter-level `config_not_ready` annotation replaces the decision's
 * own reason code (04-routing.md §2.4); optional bound fields copy through
 * only when the decision carries them.
 */
export function summarizeDispatch(
  decision: RouteDecision,
  configReady: boolean,
): LastDispatchSummary {
  const summary: LastDispatchSummary = {
    model: { provider: decision.candidate.provider, id: decision.candidate.id },
    tier: decision.tier,
    thinkingLevel: decision.thinkingLevel,
    reasonCode: configReady ? decision.reason.code : "config_not_ready",
    selectedTier: decision.reason.selectedTier,
  };
  if (decision.reason.attempt !== undefined) summary.attempt = decision.reason.attempt;
  if (decision.reason.maxAttempts !== undefined) summary.maxAttempts = decision.reason.maxAttempts;
  if (decision.reason.tierSwitches !== undefined) summary.tierSwitches = decision.reason.tierSwitches;
  if (decision.reason.maxTierSwitches !== undefined) summary.maxTierSwitches = decision.reason.maxTierSwitches;
  return summary;
}

/** Record the latest dispatch on the live runtime; a shut-down runtime keeps none. */
function recordLastDispatch(
  decision: RouteDecision,
  configReady: boolean,
): void {
  const state = runtimeState;
  if (state === null || state.shutdownAt !== null) return;
  state.lastDispatch = summarizeDispatch(decision, configReady);
  // The footer learns the routed model the moment the decision lands; the
  // breathing dot (if a turn is in flight) keeps animating on top of it.
  refreshRuntimeFooter();
}

// ---------------------------------------------------------------------------
// F6.2 route-decision log: pure entry assembly + adapter wiring.
//
// The router (src/routing) stays untouched; its frozen surfaces —
// `RouteDecision.reason` and the `RouteFailureContext` mounted on terminal
// errors — already carry every field the log record needs, so assembly
// happens here, on the extension side of the seam (06 §6.4: routing never
// imports diag). `fallbackPath` is therefore empty in adapter-assembled
// records: the delivered context carries the bound hits, not the visited
// stages, and the schema keeps the capped field for surfaces that will
// carry it.
// ---------------------------------------------------------------------------

/** Reason codes whose decision state was recovered by the route boundary. */
const STATE_RECOVERY_CODES: ReadonlySet<string> = new Set(["state_recovered", "invalid_bias_recovered"]);

/**
 * Router-state provenance for one record (06 §3.4): "recovered" when the
 * route rebuilt a discarded state, "absent" when the request carried none
 * (first request of a turn, or every `direct` request), "valid" otherwise.
 */
function stateStatusOf(
  request: RouteRequest,
  reasonCode: string,
): RouteLogEntry["stateStatus"] {
  if (STATE_RECOVERY_CODES.has(reasonCode)) return "recovered";
  return request.state === undefined ? "absent" : "valid";
}

/**
 * The failed-attempt provenance for retry records: the failed physical
 * identity plus the stable failure class recomputed from the same failed
 * message the router classified (pure, deterministic, no raw text kept).
 * The tier stays `null` — resolving it would re-run routing's own tier
 * lookup, and the adapter does not duplicate that. Omitted entirely when
 * no failed identity exists.
 */
function failedBlockOf(request: RouteRequest): RouteLogFailed | undefined {
  const failedModel = request.failed?.model;
  if (request.reason !== "retry" || failedModel === undefined) return undefined;
  const assessment = classifyFailure(request.failed?.message ?? {});
  return {
    candidate: { provider: failedModel.provider, id: failedModel.id },
    tier: null,
    failureClass: assessment.failureClass,
    retryHint: assessment.retryHint,
  };
}

/**
 * Record for a successful dispatch (outcome "selected"): the decision's
 * own reason code, tiers, facts, and counters, with retry provenance when
 * the dispatch followed a failure (06 §3.4/§5.2).
 */
export function selectedRouteLogEntry(
  request: RouteRequest,
  decision: RouteDecision,
  config: EffectiveConfig,
): RouteLogEntry {
  const reason = decision.reason;
  const failed = failedBlockOf(request);
  return {
    schemaVersion: ROUTE_LOG_SCHEMA_VERSION,
    requestReason: request.reason,
    outcome: "selected",
    reasonCode: reason.code,
    phase: reason.phase,
    complexity: reason.complexity,
    requestedTier: reason.requestedTier,
    selectedTier: reason.selectedTier,
    selectedCandidate: { provider: decision.candidate.provider, id: decision.candidate.id },
    selectedThinking: decision.thinkingLevel,
    attempt: reason.attempt ?? decision.state?.attempts ?? 1,
    maxAttempts: reason.maxAttempts ?? config.retry.maxAttemptsPerRequest,
    tierSwitches: reason.tierSwitches ?? decision.state?.tierSwitches ?? 0,
    maxTierSwitches: reason.maxTierSwitches ?? config.retry.maxTierSwitches,
    ...(failed !== undefined ? { failed } : {}),
    fallbackPath: [],
    boundHits: [],
    stateStatus: stateStatusOf(request, reason.code),
  };
}

/**
 * Record for a terminal bounded failure (outcome "exhausted") that carries
 * the F6.1 safe context: counters and bound hits come from the context,
 * the reason code is the thrown error's own code, and incomplete provenance
 * is omitted rather than fabricated (06 §5.3).
 */
export function exhaustedRouteLogEntry(
  request: RouteRequest,
  error: RoutingError,
  context: NonNullable<ReturnType<typeof inspectRouteFailure>>,
  config: EffectiveConfig,
): RouteLogEntry {
  const failed =
    context.failed !== undefined && context.failureClass !== undefined && context.retryHint !== undefined
      ? {
          candidate: { provider: context.failed.provider, id: context.failed.id },
          tier: context.failed.tier,
          failureClass: context.failureClass,
          retryHint: context.retryHint,
        }
      : undefined;
  return {
    schemaVersion: ROUTE_LOG_SCHEMA_VERSION,
    requestReason: context.requestReason,
    outcome: "exhausted",
    reasonCode: error.code,
    attempt: context.attempts,
    maxAttempts: context.maxAttempts,
    tierSwitches: context.tierSwitches,
    maxTierSwitches: context.maxTierSwitches,
    ...(failed !== undefined ? { failed } : {}),
    fallbackPath: [],
    boundHits: [...context.boundHits],
    stateStatus: stateStatusOf(request, error.code),
  };
}

/**
 * Record for an aborted retry (outcome "aborted"): the branch state is
 * unchanged — an abort consumes no budget — so the counters mirror the
 * pre-abort state and the user-facing distinction lives only in this
 * outcome (06 §3.3: the Phase 4 error union stays frozen).
 */
export function abortedRouteLogEntry(
  request: RouteRequest,
  error: RoutingError,
  config: EffectiveConfig,
): RouteLogEntry {
  const failed = failedBlockOf(request);
  return {
    schemaVersion: ROUTE_LOG_SCHEMA_VERSION,
    requestReason: request.reason,
    outcome: "aborted",
    reasonCode: error.code,
    ...(failed !== undefined ? { failed } : {}),
    attempt: request.state?.attempts ?? 0,
    maxAttempts: config.retry.maxAttemptsPerRequest,
    tierSwitches: request.state?.tierSwitches ?? 0,
    maxTierSwitches: config.retry.maxTierSwitches,
    fallbackPath: [],
    boundHits: [],
    stateStatus: stateStatusOf(request, error.code),
  };
}

/**
 * Record for a terminal failure without the F6.1 context (outcome
 * "exhausted"): the fresh selection itself found no eligible candidate, or
 * a retry leg could not even name the failed identity. Counters fall back
 * to what the request carried; nothing is invented (06 §5.3).
 */
export function terminalRouteLogEntry(
  request: RouteRequest,
  error: RoutingError,
  config: EffectiveConfig,
): RouteLogEntry {
  return {
    schemaVersion: ROUTE_LOG_SCHEMA_VERSION,
    requestReason: request.reason,
    outcome: "exhausted",
    reasonCode: error.code,
    attempt:
      request.state?.attempts ?? (request.reason === "continuation" || request.reason === "retry" ? 0 : 1),
    maxAttempts: config.retry.maxAttemptsPerRequest,
    tierSwitches: request.state?.tierSwitches ?? 0,
    maxTierSwitches: config.retry.maxTierSwitches,
    fallbackPath: [],
    boundHits: [],
    stateStatus: stateStatusOf(request, error.code),
  };
}

/**
 * Mirror the sink's session write-failure count onto the runtime diagnostic
 * field after each append (06 §4.4): the sink stays the single source of
 * truth; this keeps the runtime number current for `/ts doctor` (F6.3)
 * and status consumers without a second counter.
 */
function syncRouteLogHealth(state: SessionRuntimeState): void {
  if (state.routeLog === undefined) return;
  state.routeLogWriteFailures = state.routeLog.health().writeFailures;
}

/** Append one record if a live runtime sink exists; never let logging change anything. */
function appendDecisionRecord(
  entry: RouteLogEntry | undefined,
  state: SessionRuntimeState,
): void {
  const sink = state.routeLog;
  if (entry === undefined || sink === undefined || state.shutdownAt !== null) return;
  appendRouteLog(entry, sink);
  syncRouteLogHealth(state);
}

/**
 * Assemble the record for a caught routing error and append it, then let
 * the error continue out unchanged — the log is evidence, never a handler
 * (06 §3.4 step 3). Foreign (non-RoutingError) throws are not routing
 * decisions and are not logged; `invalid_route_result` produced no decision
 * at all. A context-less retry whose failed message classifies as aborted
 * is the abort terminal; everything else is a context-less exhaustion.
 */
function logTerminalRouteDecision(
  request: RouteRequest,
  error: unknown,
  config: EffectiveConfig,
): void {
  const state = runtimeState;
  if (state === null || state.routeLog === undefined || state.shutdownAt !== null) return;
  if (!(error instanceof RoutingError)) return;
  const context = inspectRouteFailure(error);
  const entry =
    context !== undefined
      ? exhaustedRouteLogEntry(request, error, context, config)
      : error.code === "invalid_route_result"
        ? undefined
        : request.reason === "retry" && classifyFailure(request.failed?.message ?? {}).failureClass === "aborted"
          ? abortedRouteLogEntry(request, error, config)
          : terminalRouteLogEntry(request, error, config);
  appendDecisionRecord(entry, state);
}

/**
 * Route adapter for the ts/auto virtual model: reads the in-memory runtime
 * config (04-routing.md §2.4 — no factory-side or route-side config I/O),
 * falls back to the built-in defaults while the session_start load is not
 * ready, and records the bounded last-dispatch summary after every
 * successful route. F6.2: every decision — selected, terminal, or
 * aborted — also lands as one route-decision record on the branch; an
 * append failure only counts, and the routing result passes through
 * exactly as the router produced it.
 */
function createRuntimeRoute(): AutoModelRoute<RouterState> {
  return (request, ctx) => {
    const load = runtimeState?.configLoad;
    const config = load?.effective ?? builtinEffectiveConfig();
    let decision: RouteDecision;
    try {
      decision = routeRequest(request, ctx, { config });
    } catch (error) {
      logTerminalRouteDecision(request, error, config);
      throw error;
    }
    const state = runtimeState;
    if (state !== null && state.shutdownAt === null) {
      appendDecisionRecord(selectedRouteLogEntry(request, decision, config), state);
    }
    recordLastDispatch(decision, load !== undefined);
    return {
      model: decision.model,
      thinkingLevel: decision.thinkingLevel,
      state: decision.state,
    };
  };
}

/**
 * Per-session route-log sink assembly (06 §4.2): the Pi API owns the write
 * seam, and the branch supplier reads the live session branch defensively —
 * a context without a session manager (or a throwing reader) yields an
 * empty branch, so health reads degrade to "no records" instead of
 * breaking a route or command.
 */
function createSessionRouteLogSink(pi: ExtensionAPI, ctx: ExtensionContext): RouteLogSink {
  return createRouteLogSink(pi, () => {
    try {
      return ctx.sessionManager.getBranch();
    } catch {
      return [];
    }
  });
}

/**
 * Optional TUI entry renderer (06 §3.4/§6.4): one compact, redacted line for
 * valid records; malformed records keep the default rendering. Registered
 * only under the tui mode guard — persisted records and exports never
 * depend on it — and only when the host exposes the renderer API.
 */
function registerRouteLogRenderer(pi: ExtensionAPI): void {
  if (typeof pi.registerEntryRenderer !== "function") return;
  pi.registerEntryRenderer(ROUTE_DECISION_ENTRY, (entry) => {
    const record = validateRouteLogEntry((entry as { data?: unknown }).data);
    return record === undefined ? undefined : new Text(renderRouteLogEntry(record));
  });
}

/**
 * F7.1 atomic reload swap (07 §3.7): replace the live runtime's config
 * snapshot and bump the revision in one step, or refuse on a closed/dead
 * runtime. Never mutates the passed load; never touches router state,
 * manual control, or any model surface. F7.2: a successful swap also
 * clears a stale `reloadPending` mark and refreshes the TUI footer with
 * the (possibly new) effective bias (07 §5.6).
 */
function applyConfigReload(load: LoadResult): { applied: boolean; revision: number } {
  const state = runtimeState;
  if (state === null || state.shutdownAt !== null) {
    return { applied: false, revision: state?.configRevision ?? 1 };
  }
  state.configLoad = load;
  state.configRevision = (state.configRevision ?? 1) + 1;
  state.reloadPending = false;
  refreshRuntimeFooter();
  return { applied: true, revision: state.configRevision };
}

/** Fail-soft branch read: a broken session manager reads as no control. */
function branchEntriesOf(
  ctx: Pick<ExtensionContext | ExtensionCommandContext, "sessionManager">,
): SessionEntry[] {
  try {
    return ctx.sessionManager.getBranch();
  } catch {
    return [];
  }
}

/**
 * The footer refresh inputs from live runtime state (07 §3.8): the branch
 * manual override plus the effective bias — `TIER_BIAS` for a manual tier,
 * the effective `policy.defaultBias` (built-in defaults while no load is
 * ready) for automatic routing. No second copy of any state.
 */
function footerInputOf(
  state: SessionRuntimeState,
  ctx: Pick<ExtensionContext | ExtensionCommandContext, "sessionManager">,
): { manualOverride: TierName | null; bias: ThinkingBias; dispatch?: FooterDispatch } {
  const override = readLatestRouterControl(branchEntriesOf(ctx)).manualOverride;
  const bias =
    override !== null
      ? TIER_BIAS[override]
      : (state.configLoad?.effective.policy.defaultBias ?? defaultConfig().policy.defaultBias);
  const last = state.lastDispatch;
  return {
    manualOverride: override,
    bias,
    dispatch:
      last === undefined
        ? undefined
        : { modelId: last.model.id, thinkingLevel: last.thinkingLevel },
  };
}

/**
 * Refresh the footer from any context carrying mode/ui/sessionManager —
 * command contexts and lifecycle event contexts both fit. A dead runtime,
 * a non-TUI mode, or a throwing `setStatus` makes it a bounded no-op; a
 * successful write sets the runtime's idempotence flag (07 §3.8).
 */
function refreshFooterFrom(
  ctx: Pick<ExtensionContext | ExtensionCommandContext, "mode" | "ui" | "sessionManager">,
): void {
  const state = runtimeState;
  if (state === null) return;
  const input = footerInputOf(state, ctx);
  if (
    refreshFooterStatus(
      { mode: ctx.mode as FooterStatusContext["mode"], ui: ctx.ui },
      { ...input, live: state.shutdownAt === null },
    )
  ) {
    state.footerStatusSet = true;
  }
}

/** Footer refresh for surfaces without a live context (post-save reload). */
function refreshRuntimeFooter(): void {
  if (footerSink === null) return;
  refreshFooterFrom(footerSink);
}

/**
 * The session's footer sink: the mode/ui/branch slice captured at
 * session_start so post-save reloads and the shutdown clear can reach the
 * same status bar that displayed the text (07 §3.8). Replaced on every
 * session_start — a new session owns its own status key.
 */
let footerSink: Pick<ExtensionContext, "mode" | "ui" | "sessionManager"> | null = null;

/** Breathing-dot cadence (ms) while a turn is in flight. */
const FOOTER_BREATH_INTERVAL_MS = 700;

/** The active-turn footer animator; TUI-only, one interval per runtime. */
let footerBreathTimer: ReturnType<typeof setInterval> | undefined;

function writeBreathingFooter(frame: string): void {
  const sink = footerSink;
  const state = runtimeState;
  if (sink === null || state === null || state.shutdownAt !== null) return;
  if ((sink.mode as FooterStatusContext["mode"]) !== "tui") return;
  const input = footerInputOf(state, sink);
  try {
    sink.ui.setStatus(
      FOOTER_STATUS_KEY,
      breathingFooterText(frame, input.manualOverride, input.bias, input.dispatch),
    );
    state.footerStatusSet = true;
  } catch {
    // A failing setStatus never breaks the animator or the route path.
  }
}

function startFooterBreathing(): void {
  if (footerBreathTimer !== undefined || footerSink === null) return;
  if ((footerSink.mode as FooterStatusContext["mode"]) !== "tui") return;
  let index = 0;
  footerBreathTimer = setInterval(() => {
    const state = runtimeState;
    if (state === null || state.shutdownAt !== null) {
      stopFooterBreathing();
      return;
    }
    writeBreathingFooter(FOOTER_BREATH_FRAMES[index % FOOTER_BREATH_FRAMES.length]!);
    index += 1;
  }, FOOTER_BREATH_INTERVAL_MS);
}

function stopFooterBreathing(refresh = true): void {
  if (footerBreathTimer !== undefined) {
    clearInterval(footerBreathTimer);
    footerBreathTimer = undefined;
  }
  // On shutdown the clear below owns the status bar — no final write.
  if (refresh) refreshRuntimeFooter();
}

/** Extension entry point: registration only — no side effects, no noise. */
export default function extension(pi: ExtensionAPI): void {
  const virtualModel = createVirtualModelRegistration(pi, createRuntimeRoute());
  virtualModel.ensureRegistered();

  const deps: TsDispatchDependencies = {
    getThinkingLevel: (): ThinkingLevel => pi.getThinkingLevel(),
    getConfig: () => runtimeState?.configLoad,
    getLastDispatch: () => runtimeState?.lastDispatch,
    getRouteLogHealth: (): { writeFailures: number } => ({
      // The sink owns the live count (F6.2); the runtime mirror covers the
      // rare window before a sink exists.
      writeFailures:
        runtimeState?.routeLog?.health().writeFailures
        ?? runtimeState?.routeLogWriteFailures
        ?? 0,
    }),
    getDoctorApi: (): DoctorApiSurface => ({
      // The peer-resolved host VERSION — the authoritative runtime version,
      // never a bundled copy — plus presence probes for the pi-side faces
      // (spec §2.4); the ctx-side faces are probed from the command context
      // the collector already holds.
      runtimeVersion: VERSION,
      apiProbes: {
        registerVirtualModel: () => typeof pi.registerVirtualModel === "function",
        registerCommand: () => typeof pi.registerCommand === "function",
        appendEntry: () => typeof pi.appendEntry === "function",
      },
    }),
    recordDoctorReport: (report: DoctorReport): void => {
      if (runtimeState !== null && runtimeState.shutdownAt === null) {
        runtimeState.lastDoctor = report;
      }
    },
    pi: {
      setModel: (model) => pi.setModel(model),
      setThinkingLevel: (level) => pi.setThinkingLevel(level),
      appendEntry: (customType, data) => pi.appendEntry(customType, data),
    },
    enqueueControlMutation,
    // F7.1 config-command dependencies (07 §6.2; spec §2.4): the Phase 2
    // seams and runtime accessors, assembled here so commands never import
    // the extension or hold a raw fs module.
    respond: respond,
    readConfigLayerForEdit: (input) => readConfigLayerForEdit(input),
    loadConfig: (input) => loadEffectiveConfig(input),
    saveConfigFile: (targetPath, layer, options) => saveConfigFile(targetPath, layer, options),
    isRuntimeClosed: () => runtimeState === null || runtimeState.shutdownAt !== null,
    isFlowActive: () => runtimeState?.flowActive === true,
    setFlowActive: (active) => {
      if (runtimeState !== null) runtimeState.flowActive = active;
    },
    getConfigRevision: () => runtimeState?.configRevision ?? 1,
    applyConfigReload: applyConfigReload,
    enqueueConfigSave: enqueueConfigSave,
    // F7.2 config-command dependencies (07 §6.2; spec §2.4): the branch
    // override read behind the view's session line, the footer refresh the
    // dispatcher calls after control/config successes, and the pending
    // accessor a failed post-save reload sets.
    getManualOverride: (ctx) => readLatestRouterControl(branchEntriesOf(ctx)).manualOverride,
    refreshFooter: (ctx) => refreshFooterFrom(ctx),
    setReloadPending: (pending) => {
      if (runtimeState !== null && runtimeState.shutdownAt === null) {
        runtimeState.reloadPending = pending;
      }
    },
  };

  pi.registerCommand(COMMAND_NAME, {
    description: "model switching and routing control (pi-tier-scheduler)",
    getArgumentCompletions: completeArguments,
    handler: (args, ctx) => handleTsCommand(args, ctx, deps),
  });
  pi.on("session_start", (event, ctx) => {
    virtualModel.ensureRegistered();
    resetControlTail();
    resetConfigSaveTail();
    if (ctx.mode === "tui") registerRouteLogRenderer(pi);
    handleSessionStart(event, ctx, createSessionRouteLogSink(pi, ctx));
  });
  // F7.2 footer refresh on selection events (07 §3.8/§5.6): model changes
  // involving ts/auto and any thinking-level change re-derive the bounded
  // footer text; the refresh itself is a no-op outside a live TUI.
  pi.on("model_select", (event) => {
    const selection = event as {
      model?: { provider?: string; id?: string } | undefined;
      previousModel?: { provider?: string; id?: string } | undefined;
    };
    const isTsAuto = (model: { provider?: string; id?: string } | undefined): boolean =>
      model?.provider === TS_VIRTUAL_PROVIDER && model?.id === TS_VIRTUAL_MODEL_ID;
    if (isTsAuto(selection.model) || isTsAuto(selection.previousModel)) {
      refreshRuntimeFooter();
    }
  });
  pi.on("thinking_level_select", () => {
    refreshRuntimeFooter();
  });
  // The breathing dot: a turn in flight animates the footer's leading dot
  // through ˙·•●•·; the turn ending settles it back to the static line.
  pi.on("turn_start", () => {
    startFooterBreathing();
  });
  pi.on("turn_end", () => {
    stopFooterBreathing();
  });
  pi.on("session_shutdown", (event, ctx) => {
    stopFooterBreathing(false);
    virtualModel.unregister();
    handleSessionShutdown(event, ctx);
  });
}

function handleTsCommand(
  args: string,
  ctx: ExtensionCommandContext,
  deps: TsDispatchDependencies,
): Promise<void> {
  if (runtimeState?.shutdownAt != null) {
    respond(ctx, SHUTDOWN_NOTICE);
    return Promise.resolve();
  }
  return dispatch(args, ctx, deps);
}

function handleSessionStart(
  _event: SessionStartEvent,
  ctx: ExtensionContext,
  routeLog: RouteLogSink,
): void {
  // Silent by design (§5.1): startup must not emit output in any mode.
  runtimeState = ensureSessionState(runtimeState, ctx.mode, Date.now());
  runtimeState.routeLog = routeLog;
  // F7.2: this session owns the footer status key from here on — capture
  // the sink for later refreshes/clears and show the initial text in TUI.
  footerSink =
    typeof ctx.ui?.setStatus === "function" && ctx.sessionManager !== undefined
      ? (ctx as Pick<ExtensionContext, "mode" | "ui" | "sessionManager">)
      : null;
  refreshRuntimeFooter();
  // Fire-and-forget load: routing that arrives before the load completes
  // uses the built-in defaults and records `config_not_ready`; the load
  // result lands only on this exact runtime instance while it is live.
  void loadRuntimeConfig(ctx, runtimeState);
}

async function loadRuntimeConfig(
  ctx: ExtensionContext,
  state: SessionRuntimeState,
): Promise<void> {
  if (typeof ctx.cwd !== "string" || ctx.cwd === "") {
    return; // No usable working directory: routes stay on built-in defaults.
  }
  let load: LoadResult;
  try {
    load = await loadEffectiveConfig({ cwd: ctx.cwd });
  } catch {
    return; // Unreadable environment: status renders not-loaded; defaults keep routing safe.
  }
  if (runtimeState === state && state.shutdownAt === null) {
    state.configLoad = load;
  }
}

function handleSessionShutdown(
  _event: SessionShutdownEvent,
  _ctx: ExtensionContext,
): void {
  if (runtimeState === null) {
    return; // Shutdown without a prior start: nothing to mark.
  }
  // F7.2: clear the footer key exactly once, guarded by the runtime's
  // idempotence flag; a session that never set it (non-TUI) clears
  // nothing (07 §3.8). The sink dies with the runtime afterwards.
  if (runtimeState.shutdownAt === null && footerSink !== null) {
    if (clearFooterStatus(
      { mode: footerSink.mode as FooterStatusContext["mode"], ui: footerSink.ui },
      runtimeState.footerStatusSet === true,
    )) {
      runtimeState.footerStatusSet = false;
    }
  }
  footerSink = null;
  runtimeState = markSessionShutdown(runtimeState, Date.now());
}
