import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ModelRouteReason,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { isComplexity, isPhase, isThinkingLevel, isTier } from "../routing/state";
import type { CandidateIdentity, ComplexityBand, RetryHint, TierName, WorkPhase } from "../routing/types";
import type { FailureClass } from "../routing/failure";
import type { BoundHit, FallbackStage } from "../routing/fallback";

/**
 * Durable route decision log (06-fallback-diagnostics.md §3.4/§4.2, F6.2).
 *
 * One compact, schema-version-1 `CustomEntry` on the session branch for every
 * route invocation that produces a decision — selected, terminal bounded
 * failure, or aborted. The record is evidence only, never a second route
 * state: appending happens after the decision is made, an append failure only
 * increments a health counter, and the routing result passes through
 * unchanged. The payload is redacted by construction: enums, identities,
 * counters, and stage codes only — no transcript, raw provider error,
 * credential, header, path, or extension-supplied timestamp (Pi owns the
 * session entry's own metadata).
 *
 * The module is pure over inputs it can verify and touches Pi only through
 * the two seams the SDK sanctions for this purpose: `appendEntry` (custom
 * entries never enter LLM context) and the branch reader. It imports routing
 * and shared *types* plus the tier/phase vocabulary helpers; routing never
 * imports diag, so the dependency direction stays one-way.
 */

/** Exact custom type of one route-decision record on the session branch. */
export const ROUTE_DECISION_ENTRY = "pi-tier-scheduler.route-decision";

/** Schema version of the route-log payload this package writes and accepts. */
export const ROUTE_LOG_SCHEMA_VERSION = 1 as const;

/** What the recorded route invocation produced. */
export type RouteLogOutcome = "selected" | "exhausted" | "aborted";

/** Sanitized provenance of the attempt that failed, when one is known. */
export type RouteLogFailed = {
  candidate: CandidateIdentity;
  tier: TierName | null;
  failureClass: FailureClass;
  retryHint: RetryHint;
};

/** Frozen version-1 payload (06-fallback-diagnostics.md §3.4). */
export type RouteLogEntry = {
  schemaVersion: typeof ROUTE_LOG_SCHEMA_VERSION;
  requestReason: ModelRouteReason;
  outcome: RouteLogOutcome;
  reasonCode: string;
  phase?: WorkPhase;
  complexity?: ComplexityBand;
  requestedTier?: TierName;
  selectedTier?: TierName;
  selectedCandidate?: CandidateIdentity;
  selectedThinking?: ModelThinkingLevel;
  attempt: number;
  maxAttempts: number;
  tierSwitches: number;
  maxTierSwitches: number;
  failed?: RouteLogFailed;
  /** Fallback segments the policy visited, deduplicated, at most eight. */
  fallbackPath: readonly FallbackStage[];
  /** Bounds and skips that limited the search, at most four. */
  boundHits: readonly BoundHit[];
  stateStatus: "valid" | "recovered" | "absent";
};

/** Result of scanning one branch for the newest usable record. */
export type RouteLogReadResult = {
  latest?: RouteLogEntry;
  malformedCount: number;
};

/** Write/read/health surface the extension assembles per session. */
export type RouteLogSink = {
  append(entry: RouteLogEntry): void;
  latest(): RouteLogEntry | undefined;
  health(): {
    writeFailures: number;
    malformedEntries: number;
  };
};

const REQUEST_REASONS: readonly ModelRouteReason[] = ["user", "continuation", "retry", "direct"];
const OUTCOMES: readonly RouteLogOutcome[] = ["selected", "exhausted", "aborted"];
const STATE_STATUSES: readonly RouteLogEntry["stateStatus"][] = ["valid", "recovered", "absent"];
const FALLBACK_STAGES: readonly FallbackStage[] = [
  "same_provider",
  "same_tier",
  "escalate_tier",
  "degrade_tier",
  "skip_provider",
  "capability_rejected",
];
const BOUND_HITS: readonly BoundHit[] = [
  "attempt_limit",
  "tier_switch_limit",
  "candidate_exhausted",
  "provider_skipped",
];
const FAILURE_CLASSES: readonly FailureClass[] = [
  "aborted",
  "context_overflow",
  "output_limit",
  "authentication",
  "quota_exhausted",
  "rate_limited",
  "transient",
  "invalid_request",
  "provider_error",
  "unknown",
];
const RETRY_HINTS: readonly RetryHint[] = ["context_overflow", "transient", "permanent", "unknown"];

/** Hard cap on `fallbackPath` after deduplication (06 §3.4). */
const FALLBACK_PATH_CAP = 8;
/** Hard cap on `boundHits` (06 §3.4). */
const BOUND_HITS_CAP = 4;
/** Identity fields are configured values; hostile longer strings are rejected. */
const IDENTITY_MAX_LENGTH = 200;
/**
 * `reasonCode` is an extension-owned code, not free text: lowercase snake_case
 * only. A malformed or oversized string means the record is not ours and is
 * rejected rather than trimmed into something that looks valid.
 */
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]*$/;
const REASON_CODE_MAX_LENGTH = 64;

/** Exactly the keys a version-1 record may carry; anything else is foreign. */
const ENTRY_KEYS = [
  "schemaVersion",
  "requestReason",
  "outcome",
  "reasonCode",
  "phase",
  "complexity",
  "requestedTier",
  "selectedTier",
  "selectedCandidate",
  "selectedThinking",
  "attempt",
  "maxAttempts",
  "tierSwitches",
  "maxTierSwitches",
  "failed",
  "fallbackPath",
  "boundHits",
  "stateStatus",
] as const satisfies readonly (keyof RouteLogEntry)[];

const FAILED_KEYS = ["candidate", "tier", "failureClass", "retryHint"] as const satisfies readonly
  (keyof RouteLogFailed)[];

/** Fields every version-1 record must carry; the rest of the whitelist is optional. */
const REQUIRED_KEYS = [
  "schemaVersion",
  "requestReason",
  "outcome",
  "reasonCode",
  "attempt",
  "maxAttempts",
  "tierSwitches",
  "maxTierSwitches",
  "fallbackPath",
  "boundHits",
  "stateStatus",
] as const satisfies readonly (keyof RouteLogEntry)[];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  if (own.length !== keys.length) return false;
  return keys.every((key) => own.includes(key));
}

/**
 * Whitelist check for the record's own keys: every key must be a known field,
 * and every required field must be present. Optional fields may be absent —
 * or present with an `undefined` value, which the clone drops — but a foreign
 * key (a smuggled transcript, credential, or path) always rejects the record.
 */
function hasWhitelistedKeys(value: Record<string, unknown>): boolean {
  const own = Object.keys(value);
  return own.every((key) => ENTRY_KEYS.includes(key as (typeof ENTRY_KEYS)[number]))
    && REQUIRED_KEYS.every((key) => own.includes(key));
}

function isMember<T extends string>(value: unknown, vocabulary: readonly T[]): value is T {
  return typeof value === "string" && vocabulary.includes(value as T);
}

function isIdentity(value: unknown): value is CandidateIdentity {
  if (!isPlainObject(value) || !hasExactlyKeys(value, ["provider", "id"])) return false;
  const { provider, id } = value;
  return (
    typeof provider === "string" &&
    provider !== "" &&
    provider.length <= IDENTITY_MAX_LENGTH &&
    typeof id === "string" &&
    id !== "" &&
    id.length <= IDENTITY_MAX_LENGTH
  );
}

/**
 * Counter clamp: a usable number becomes a non-negative integer bounded by the
 * safe-integer range; anything else (NaN, Infinity, non-number) clamps to 0.
 * The validator clamps rather than rejects so a hostile counter cannot bloat a
 * record while a slightly out-of-range value still leaves usable evidence.
 */
function clampCounter(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const floored = Math.floor(value);
  if (floored < 0) return 0;
  return floored > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : floored;
}

function parseFailed(value: unknown): RouteLogFailed | undefined {
  if (!isPlainObject(value) || !hasExactlyKeys(value, FAILED_KEYS)) return undefined;
  if (!isIdentity(value.candidate)) return undefined;
  const { tier } = value;
  if (tier !== null && !isTier(tier)) return undefined;
  if (!isMember(value.failureClass, FAILURE_CLASSES)) return undefined;
  if (!isMember(value.retryHint, RETRY_HINTS)) return undefined;
  return {
    candidate: { provider: value.candidate.provider, id: value.candidate.id },
    tier,
    failureClass: value.failureClass,
    retryHint: value.retryHint,
  };
}

/**
 * Validate one untrusted payload against the version-1 schema and return a
 * clean clone that carries exactly the whitelisted fields (§3.4 step 1 —
 * validate and cap before calling Pi; §4.2 — append validates/clones so a
 * caller cannot mutate a record after it is handed over). Returns `undefined`
 * for anything the schema does not own: wrong version, foreign keys, values
 * outside the enum vocabularies, malformed identities, or a `failed` block
 * that is present but not exactly the sanctioned shape.
 *
 * Deliberate capping (not rejection) per the frozen contract: counters clamp
 * to non-negative integers, `fallbackPath` deduplicates and caps at eight,
 * `boundHits` caps at four. Vocabulary violations reject; length violations
 * cap.
 */
export function validateRouteLogEntry(value: unknown): RouteLogEntry | undefined {
  if (!isPlainObject(value) || !hasWhitelistedKeys(value)) return undefined;
  if (value.schemaVersion !== ROUTE_LOG_SCHEMA_VERSION) return undefined;
  if (!isMember(value.requestReason, REQUEST_REASONS)) return undefined;
  if (!isMember(value.outcome, OUTCOMES)) return undefined;
  if (
    typeof value.reasonCode !== "string" ||
    value.reasonCode === "" ||
    value.reasonCode.length > REASON_CODE_MAX_LENGTH ||
    !REASON_CODE_PATTERN.test(value.reasonCode)
  ) {
    return undefined;
  }
  if (value.phase !== undefined && !isPhase(value.phase)) return undefined;
  if (value.complexity !== undefined && !isComplexity(value.complexity)) return undefined;
  if (value.requestedTier !== undefined && !isTier(value.requestedTier)) return undefined;
  if (value.selectedTier !== undefined && !isTier(value.selectedTier)) return undefined;
  if (value.selectedCandidate !== undefined && !isIdentity(value.selectedCandidate)) return undefined;
  if (value.selectedThinking !== undefined && !isThinkingLevel(value.selectedThinking)) return undefined;
  const failed =
    value.failed === undefined ? undefined : parseFailed(value.failed);
  if (value.failed !== undefined && failed === undefined) return undefined;
  if (!Array.isArray(value.fallbackPath)) return undefined;
  for (const stage of value.fallbackPath) {
    if (!isMember(stage, FALLBACK_STAGES)) return undefined;
  }
  if (!Array.isArray(value.boundHits)) return undefined;
  for (const hit of value.boundHits) {
    if (!isMember(hit, BOUND_HITS)) return undefined;
  }
  if (!isMember(value.stateStatus, STATE_STATUSES)) return undefined;

  return {
    schemaVersion: ROUTE_LOG_SCHEMA_VERSION,
    requestReason: value.requestReason,
    outcome: value.outcome,
    reasonCode: value.reasonCode,
    ...(value.phase !== undefined ? { phase: value.phase } : {}),
    ...(value.complexity !== undefined ? { complexity: value.complexity } : {}),
    ...(value.requestedTier !== undefined ? { requestedTier: value.requestedTier } : {}),
    ...(value.selectedTier !== undefined ? { selectedTier: value.selectedTier } : {}),
    ...(value.selectedCandidate !== undefined
      ? { selectedCandidate: { provider: value.selectedCandidate.provider, id: value.selectedCandidate.id } }
      : {}),
    ...(value.selectedThinking !== undefined ? { selectedThinking: value.selectedThinking } : {}),
    attempt: clampCounter(value.attempt),
    maxAttempts: clampCounter(value.maxAttempts),
    tierSwitches: clampCounter(value.tierSwitches),
    maxTierSwitches: clampCounter(value.maxTierSwitches),
    ...(failed !== undefined ? { failed } : {}),
    fallbackPath: [...new Set(value.fallbackPath as readonly FallbackStage[])].slice(0, FALLBACK_PATH_CAP),
    boundHits: (value.boundHits as readonly BoundHit[]).slice(0, BOUND_HITS_CAP),
    stateStatus: value.stateStatus,
  };
}

/**
 * Scan one branch from the newest entry for the newest valid version-1 record
 * (§3.4): unrelated custom types are skipped silently, corrupt or
 * future-version route-decision entries newer than the first valid record
 * count into `malformedCount`, and the scan stops at the first valid record —
 * older damage stays invisible by contract. The reader never parses arbitrary
 * custom entries and never exposes malformed payload text. Fork correctness is
 * inherent: the caller passes the branch it lives on, so a sibling branch's
 * records are never visible here.
 */
export function readLatestRouteLog(branch: readonly SessionEntry[]): RouteLogReadResult {
  let malformedCount = 0;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry.type !== "custom" || entry.customType !== ROUTE_DECISION_ENTRY) continue;
    const record = validateRouteLogEntry(entry.data);
    if (record !== undefined) return { latest: record, malformedCount };
    malformedCount += 1;
  }
  return { malformedCount };
}

/**
 * Assemble the per-session sink (§4.2). `append` validates and clones before
 * calling Pi, so later mutation of the caller's object cannot reach the
 * persisted record, and every failure mode — a schema-invalid record or a
 * throwing `appendEntry` — only increments the health counter: logging never
 * changes the route result and never throws. `latest`/`health` are rebuilt
 * from the branch on every read, so a fork or reload sees exactly its own
 * branch with no cached cross-branch state; only the write-failure counter is
 * volatile and it resets with a fresh sink at session_start.
 */
export function createRouteLogSink(
  pi: Pick<ExtensionAPI, "appendEntry">,
  branch: () => readonly SessionEntry[],
): RouteLogSink {
  let writeFailures = 0;
  return {
    append(entry: RouteLogEntry): void {
      const record = validateRouteLogEntry(entry);
      if (record === undefined) {
        // The adapter built a record the schema does not own: not writable,
        // surfaced through health instead of failing the route.
        writeFailures += 1;
        return;
      }
      try {
        pi.appendEntry(ROUTE_DECISION_ENTRY, record);
      } catch {
        // §3.4 step 3: keep the route result, count, and never rethrow.
        writeFailures += 1;
      }
    },
    latest(): RouteLogEntry | undefined {
      return readLatestRouteLog(branch()).latest;
    },
    health(): { writeFailures: number; malformedEntries: number } {
      return {
        writeFailures,
        malformedEntries: readLatestRouteLog(branch()).malformedCount,
      };
    },
  };
}

/**
 * The three-step append contract (§3.4) as the adapter-facing seam: the record
 * is validated and capped before Pi is touched, the append runs inside the
 * sink's try/catch, and a failure is counted instead of propagated — the
 * caller's routing result is returned or thrown exactly as it was. The sink
 * owns the mechanics; this function is the stable name the adapter and tests
 * code against.
 */
export function appendRouteLog(entry: RouteLogEntry, sink: RouteLogSink): void {
  sink.append(entry);
}

/**
 * One compact, stable line for the optional TUI renderer and exports, e.g.
 * `route retry_same_tier: anthropic/sonnet (attempt 2/3)`. Only fields that
 * are already part of the validated record are rendered; outcome suffixes
 * distinguish terminals and aborts, and no free text ever reaches the line.
 */
export function renderRouteLogEntry(entry: RouteLogEntry): string {
  const target =
    entry.selectedCandidate !== undefined
      ? `${entry.selectedCandidate.provider}/${entry.selectedCandidate.id}`
      : entry.outcome === "aborted"
        ? "aborted"
        : "no candidate";
  return `route ${entry.reasonCode}: ${target} (attempt ${entry.attempt}/${entry.maxAttempts})`;
}
