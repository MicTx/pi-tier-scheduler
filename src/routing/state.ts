/**
 * Branch-aware router-state boundary (04-routing.md §2.3, §3.9).
 *
 * Every state entering the router passes `sanitizeRouterState` first. The
 * result is valid by construction: known schema, plain JSON values, enum
 * fields inside their unions, counters inside the absolute ceilings from
 * `src/config/constants.ts`, and the attempted list capped at the absolute
 * attempt limit. Anything else is recovered field-by-field to a safe default
 * and reported through `recovered`, so stale data in a session file can never
 * make `route()` throw, persist an unbounded payload, or leak foreign keys
 * back onto the session branch.
 *
 * The sanitizer is pure: it never mutates its input, keeps the caller's
 * object reference when every field is valid (so unchanged states round-trip
 * without redundant branch entries), and reconstructs otherwise. The router
 * owns selection policy; this module owns state shape and recovery only.
 */
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

import { MAX_ATTEMPTS_PER_REQUEST, MAX_TIER_SWITCHES } from "../config/constants";
import type { ThinkingBias } from "../config/types";
import { THINKING_LEVEL_ORDER } from "../catalog/constants";

import { normalizeBias } from "./bias";
import type {
  AttemptedCandidate,
  CandidateIdentity,
  ComplexityBand,
  RouterState,
  StateRecoveryResult,
  TierName,
  WorkPhase,
} from "./types";

/** Schema version of the persisted router state this package writes. */
export const STATE_SCHEMA_VERSION = 1;

/**
 * Every field of the persisted state, in one place. A recovered state is
 * rebuilt from exactly these keys, so shape drift (missing or unknown keys)
 * is treated as stale data and recovered, never passed through.
 */
const STATE_KEYS = [
  "schemaVersion",
  "turn",
  "phase",
  "complexity",
  "bias",
  "manualOverride",
  "sticky",
  "attempts",
  "tierSwitches",
  "attempted",
  "activeTier",
  "activeCandidate",
  "activeThinking",
] as const satisfies readonly (keyof RouterState)[];

/** Tier vocabulary in deterministic walk order; owned by Phase 2 as a type. */
export const VALID_TIERS: readonly TierName[] = ["brain", "pillar", "crowd"];

const VALID_PHASES: readonly WorkPhase[] = [
  "planning",
  "implementation",
  "verification",
  "conversation",
  "unknown",
];

const VALID_COMPLEXITIES: readonly ComplexityBand[] = ["low", "standard", "high"];

export function isTier(value: unknown): value is TierName {
  return typeof value === "string" && VALID_TIERS.includes(value as TierName);
}

export function isPhase(value: unknown): value is WorkPhase {
  return typeof value === "string" && VALID_PHASES.includes(value as WorkPhase);
}

export function isComplexity(value: unknown): value is ComplexityBand {
  return typeof value === "string" && VALID_COMPLEXITIES.includes(value as ComplexityBand);
}

export function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return typeof value === "string" && THINKING_LEVEL_ORDER.includes(value as ModelThinkingLevel);
}

/**
 * Neutral recovery skeleton (04-routing.md §3.9): the fresh state a recovered
 * route starts from, before surviving fields are re-applied. Plain JSON only.
 */
export function makeRecoveredState(biasFallback: ThinkingBias): RouterState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    turn: 0,
    phase: "unknown",
    complexity: "standard",
    bias: biasFallback,
    manualOverride: null,
    sticky: false,
    attempts: 0,
    tierSwitches: 0,
    attempted: [],
    activeTier: null,
    activeCandidate: null,
    activeThinking: null,
  };
}

/** Counter guard: safe integer in [0, maximum]; anything else falls to 0. */
function sanitizeCounter(value: unknown, maximum: number): { value: number; recovered: boolean } {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return { value: 0, recovered: true };
  }
  if (value > maximum) return { value: maximum, recovered: true };
  return { value, recovered: false };
}

/**
 * Identity guard: a plain `{ provider, id }` of non-empty strings. Returns
 * `null` for anything else; callers distinguish "was already null" from
 * "malformed" with the recovered flag of the optional wrapper below.
 */
function sanitizeIdentity(value: unknown): CandidateIdentity | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { provider, id } = value as Record<string, unknown>;
  if (typeof provider !== "string" || provider === "") return null;
  if (typeof id !== "string" || id === "") return null;
  return { provider, id };
}

function sanitizeOptionalIdentity(
  value: unknown,
): { value: CandidateIdentity | null; recovered: boolean } {
  if (value === null) return { value: null, recovered: false };
  const identity = sanitizeIdentity(value);
  return identity === null ? { value: null, recovered: true } : { value: identity, recovered: false };
}

/**
 * Attempted-list guard: keeps well-formed `{ provider, id, tier }` entries in
 * order, drops malformed ones, and caps the list at the absolute attempt limit
 * (keeping the most recent). Any drop or truncation marks recovery.
 */
function sanitizeAttempted(value: unknown, cap: number): { value: AttemptedCandidate[]; recovered: boolean } {
  if (!Array.isArray(value)) return { value: [], recovered: true };
  let recovered = value.length > cap;
  const entries: AttemptedCandidate[] = [];
  for (const entry of value) {
    const identity = sanitizeIdentity(entry);
    const tier = identity === null ? undefined : (entry as Record<string, unknown>).tier;
    if (identity === null || !isTier(tier) || Object.keys(entry as object).length !== 3) {
      recovered = true;
      continue;
    }
    entries.push({ provider: identity.provider, id: identity.id, tier });
  }
  return { value: entries.slice(-cap), recovered };
}

/** Required enum guard: valid members pass; anything else falls to the default. */
function sanitizeEnum<T extends string>(
  value: unknown,
  valid: readonly T[],
  fallback: T,
): { value: T; recovered: boolean } {
  return valid.includes(value as T)
    ? { value: value as T, recovered: false }
    : { value: fallback, recovered: true };
}

/** Nullable enum guard: `null` is valid; other malformed values fall to null. */
function sanitizeNullableEnum<T extends string>(
  value: unknown,
  valid: readonly T[],
): { value: T | null; recovered: boolean } {
  if (value === null) return { value: null, recovered: false };
  return valid.includes(value as T)
    ? { value: value as T, recovered: false }
    : { value: null, recovered: true };
}

/** Boolean guard: only real booleans pass; anything else falls to false. */
function sanitizeBoolean(value: unknown): { value: boolean; recovered: boolean } {
  return typeof value === "boolean"
    ? { value, recovered: false }
    : { value: false, recovered: true };
}

/**
 * Route-boundary state sanitizer (04-routing.md §3.9).
 *
 * - absent input → no state, no recovery (first route, or a direct request);
 * - non-object input or an unknown schema version → no usable state, recovered;
 * - otherwise every field is validated independently; malformed fields fall
 *   to safe defaults and `recovered` goes true, valid fields survive;
 * - an invalid `bias` is normalized to `biasFallback` and reported separately
 *   through `biasRecovered` (the F4.2 `invalid_bias_recovered` signal) instead
 *   of counting as structural recovery;
 * - a fully valid state with the exact authored shape keeps the caller's
 *   object reference, so unchanged state round-trips without a new entry.
 */
export function sanitizeRouterState(input: unknown, biasFallback: ThinkingBias): StateRecoveryResult {
  if (input === undefined || input === null) {
    return { state: undefined, recovered: false, biasRecovered: false };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return { state: undefined, recovered: true, biasRecovered: false };
  }
  const raw = input as Record<string, unknown>;
  if (raw.schemaVersion !== STATE_SCHEMA_VERSION) {
    return { state: undefined, recovered: true, biasRecovered: false };
  }

  const turn = sanitizeCounter(raw.turn, Number.MAX_SAFE_INTEGER);
  const phase = sanitizeEnum(raw.phase, VALID_PHASES, "unknown");
  const complexity = sanitizeEnum(raw.complexity, VALID_COMPLEXITIES, "standard");
  const bias = normalizeBias(raw.bias, biasFallback);
  const manualOverride = sanitizeNullableEnum(raw.manualOverride, VALID_TIERS);
  const sticky = sanitizeBoolean(raw.sticky);
  const attempts = sanitizeCounter(raw.attempts, MAX_ATTEMPTS_PER_REQUEST);
  const tierSwitches = sanitizeCounter(raw.tierSwitches, MAX_TIER_SWITCHES);
  const attempted = sanitizeAttempted(raw.attempted, MAX_ATTEMPTS_PER_REQUEST);
  const activeTier = sanitizeNullableEnum(raw.activeTier, VALID_TIERS);
  const activeCandidate = sanitizeOptionalIdentity(raw.activeCandidate);
  const activeThinking = sanitizeNullableEnum(raw.activeThinking, THINKING_LEVEL_ORDER);

  const exactShape =
    Object.keys(raw).length === STATE_KEYS.length &&
    STATE_KEYS.every((key) => Object.hasOwn(raw, key));

  const recovered =
    turn.recovered ||
    phase.recovered ||
    complexity.recovered ||
    manualOverride.recovered ||
    sticky.recovered ||
    attempts.recovered ||
    tierSwitches.recovered ||
    attempted.recovered ||
    activeTier.recovered ||
    activeCandidate.recovered ||
    activeThinking.recovered ||
    !exactShape;

  if (!recovered && !bias.recovered) {
    return { state: input as RouterState, recovered: false, biasRecovered: false };
  }

  // Rebuild from the recovery skeleton, re-applying every surviving field.
  // Only sanitized values are copied, so unknown keys never pass through.
  const state: RouterState = {
    ...makeRecoveredState(bias.bias),
    turn: turn.value,
    phase: phase.value,
    complexity: complexity.value,
    bias: bias.bias,
    manualOverride: manualOverride.value,
    sticky: sticky.value,
    attempts: attempts.value,
    tierSwitches: tierSwitches.value,
    attempted: attempted.value,
    activeTier: activeTier.value,
    activeCandidate: activeCandidate.value,
    activeThinking: activeThinking.value,
  };
  return { state, recovered, biasRecovered: bias.recovered };
}
