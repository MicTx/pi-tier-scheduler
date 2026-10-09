import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRouteReason } from "@earendil-works/pi-coding-agent";

import { MAX_ATTEMPTS_PER_REQUEST, MAX_TIER_SWITCHES } from "../config/constants";
import type { EffectiveConfig, TierName } from "../config/types";
import { selectFirstEligible, type CatalogResolution, type ResolvedCandidate, type TaskConstraints, type TierSelection } from "../catalog";
import type { AttemptedCandidate, CandidateIdentity, RetryHint, RouterState } from "./types";
import { addAttemptedCandidate, hasAttemptedCandidate, sameCandidate } from "./retry";
import { classifyFailure, type FailureAssessment, type FailureClass } from "./failure";
import { RoutingError } from "./retry";

/**
 * Bounded fallback policy core (06-fallback-diagnostics.md §3.2/§3.3, §4.1, F6.1).
 *
 * Pure and finite: one assessment plus a fresh Phase 3 catalog snapshot in,
 * one selection or one structured terminal out. There is no sleep, no
 * backoff timer, no recursive `route()` call, no provider probe, and no
 * second retry loop — every retry leg Pi schedules consumes the same finite
 * budget carried in the serialized state. A failed `(provider, id)` identity
 * is never eligible again in the same user turn.
 */

/** Search segments the policy visited, in order; deduplicated and capped at eight. */
export type FallbackStage =
  | "same_provider"
  | "same_tier"
  | "escalate_tier"
  | "degrade_tier"
  | "skip_provider"
  | "capability_rejected";

/** Bounds and skips that limited a terminal search (§3.3); capped at four. */
export type BoundHit = "attempt_limit" | "tier_switch_limit" | "candidate_exhausted" | "provider_skipped";

/** JSON-safe failure context a RoutingError carries for the F6.2 log sink. */
export type RouteFailureContext = {
  requestReason: ModelRouteReason;
  failed?: AttemptedCandidate;
  failureClass?: FailureClass;
  retryHint?: RetryHint;
  attempted: readonly AttemptedCandidate[];
  attempts: number;
  maxAttempts: number;
  tierSwitches: number;
  maxTierSwitches: number;
  boundHits: readonly BoundHit[];
};

/** Inputs the adapter assembles per retry leg; the catalog is snapshotted once. */
export type FallbackRequest = {
  requestReason: ModelRouteReason;
  failed: AttemptedCandidate;
  assessment: FailureAssessment;
  /** Sanitized router state; `undefined` when no usable state exists. */
  state: RouterState | undefined;
  catalog: CatalogResolution;
  constraints: TaskConstraints;
  config: EffectiveConfig;
  /** Thinking level the fresh selection clamps against (Phase 3 policy). */
  requestedThinking: ModelThinkingLevel;
};

/** Result of one bounded fallback search: data only, never a provider call. */
export type FallbackSelection = {
  selected: TierSelection | undefined;
  selectedTier: TierName | null;
  selectedCandidate: CandidateIdentity | null;
  selectedThinking: ModelThinkingLevel | null;
  attempted: readonly AttemptedCandidate[];
  attempts: number;
  tierSwitches: number;
  path: readonly FallbackStage[];
  boundHits: readonly BoundHit[];
  terminalCode?: "no_eligible_physical_model" | "route_limit_exceeded";
};

/** Message mirrors of the Phase 4 error texts (identical code + message). */
const NO_CANDIDATE_MESSAGE = "No eligible physical model is available for ts/auto";
const LIMIT_MESSAGE = "The configured routing retry limit was reached";

/**
 * Phase 4 `RoutingError` subclass carrying the safe failure context for the
 * F6.2 log sink. Same code, same message text as the identically-coded Phase 4
 * errors — only the JSON-safe context rides along.
 */
export class RouteFallbackError extends RoutingError {
  readonly routeFailure: RouteFailureContext;

  constructor(
    code: "no_eligible_physical_model" | "route_limit_exceeded",
    message: string,
    routeFailure: RouteFailureContext,
  ) {
    super(code, message);
    this.name = "RouteFallbackError";
    this.routeFailure = routeFailure;
  }
}

/**
 * Extract the failure context from a caught routing error; undefined for
 * foreign errors. Reads the structural slot the adapter mounts on the Phase 4
 * error classes (same code and message) and the `RouteFallbackError` subclass
 * — both carry the identical JSON-safe context shape.
 */
export function inspectRouteFailure(error: unknown): RouteFailureContext | undefined {
  if (error instanceof RoutingError) {
    return (error as RoutingError & { routeFailure?: RouteFailureContext }).routeFailure;
  }
  return undefined;
}

/** Mirror of the Phase 4 `boundedLimit` so the code ceilings stay identical. */
function boundedLimit(value: number, maximum: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value))) : fallback;
}

function cleanCounter(value: number | undefined): number {
  return Number.isSafeInteger(value) && value !== undefined && value >= 0 ? value : 0;
}

/** TIER_RANK: crowd < pillar < brain (§3.2 — escalation is crowd → pillar → brain). */
const TIER_RANK: Readonly<Record<TierName, number>> = { brain: 2, pillar: 1, crowd: 0 };

/** Adjacent tier walk for non-capacity classes: failed tier, then pillar → brain → crowd. */
function adjacentTierOrder(failedTier: TierName): readonly TierName[] {
  return [failedTier, "pillar", "brain", "crowd"].filter(
    (tier, index, tiers) => tiers.indexOf(tier) === index,
  ) as TierName[];
}

/** Capacity tier walk: escalation first (§3.2 — context/capacity prefers escalation). */
function capacityTierOrder(failedTier: TierName): readonly TierName[] {
  return (["brain", "pillar", "crowd"] as const).filter((tier) => tier !== failedTier);
}

/**
 * Locate the failed candidate's resolved entry in the fresh catalog. The
 * failed model may have disappeared from the registry between attempts; a
 * missing entry means no capacity baseline is available and the search stays
 * on documented order instead of guessing a threshold.
 */
function findFailedCandidate(
  catalog: CatalogResolution,
  failed: AttemptedCandidate,
): ResolvedCandidate | undefined {
  for (const tier of ["brain", "pillar", "crowd"] as const) {
    const found = catalog.tiers[tier].candidates.find((candidate) =>
      sameCandidate(candidate.ref, failed),
    );
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The one capability gate for capacity failures: strictly more than the failed model had. */
function capacityThreshold(
  assessment: FailureAssessment,
  failedCandidate: ResolvedCandidate | undefined,
): { contextWindow: number; maxTokens: number } | undefined {
  if (assessment.tierStrategy !== "capacity" || failedCandidate === undefined) return undefined;
  return {
    contextWindow: failedCandidate.model.contextWindow,
    maxTokens: failedCandidate.model.maxTokens,
  };
}

/**
 * Segment evaluation (§3.2 steps 4–7): filter the tier's candidates down to
 * the segment's scope (attempted / provider skips / capacity threshold),
 * then let Phase 3's pure capability evaluation pick the first eligible
 * candidate. Returns the selection plus the stage to record, or undefined
 * when the segment is empty or everything failed capability.
 */
function selectFromSegment(
  request: FallbackRequest,
  tier: TierName,
  candidates: readonly ResolvedCandidate[],
  options: { stage: FallbackStage; recordCapabilityRejected: boolean },
  path: FallbackStage[],
): TierSelection | undefined {
  if (candidates.length === 0) return undefined;
  const outcome = selectFirstEligible(
    { ...request.catalog.tiers[tier], candidates },
    request.requestedThinking,
    request.constraints,
  );
  if (outcome.selected !== undefined) {
    path.push(options.stage);
    return outcome;
  }
  // Candidates existed but capability rejected every one; the stage records
  // that the segment was visited and lost to capability, not to exhaustion.
  if (options.recordCapabilityRejected) path.push("capability_rejected");
  return undefined;
}

/**
 * The bounded fallback search (§3.2). Deterministic scope order per class:
 * - capacity (context_overflow / output_limit): failed provider with strictly
 *   more capacity, same tier; then other larger-capacity candidates in the
 *   same tier; then brain → pillar → crowd, capacity-filtered;
 * - authentication / quota: other providers in the failed tier, then adjacent
 *   tiers, always skipping the failed provider;
 * - rate_limited / transient / provider_error / unknown: untried same-provider
 *   candidate, then other same-tier candidates, then adjacent tiers;
 * - invalid_request: untried candidates in the failed tier (any provider),
 *   then adjacent tiers.
 */
export function chooseFallback(input: FallbackRequest): FallbackSelection {
  const { assessment, failed } = input;
  const maxAttempts = boundedLimit(
    input.config.retry.maxAttemptsPerRequest,
    MAX_ATTEMPTS_PER_REQUEST,
    1,
  );
  const maxTierSwitches = boundedLimit(
    input.config.retry.maxTierSwitches,
    MAX_TIER_SWITCHES,
    0,
  );

  // Step 1: cap the incoming counters. The state was sanitized at the route
  // boundary; this clamp keeps the code ceiling authoritative even if a
  // malformed future config path hands over an out-of-contract bound.
  const attemptsBefore = cleanCounter(input.state?.attempts);
  const tierSwitchesBefore = cleanCounter(input.state?.tierSwitches);
  const failedTier = failed.tier;
  const path: FallbackStage[] = [];
  const boundHits: BoundHit[] = [];
  const attemptedBase = (input.state?.attempted ?? []).slice(0, maxAttempts);

  // Step 2: count the failed attempt and stop at the attempt ceiling first.
  if (attemptsBefore >= maxAttempts) {
    return terminal(input, attemptedBase, attemptsBefore, tierSwitchesBefore, path, [
      ...boundHits,
      "attempt_limit",
    ]);
  }
  const attempts = attemptsBefore + 1;

  // Step 3: add the failed identity to the attempted set (provider+id keyed).
  const attempted = addAttemptedCandidate(attemptedBase, failed, failedTier, maxAttempts);

  // Step 4/5: build the exclusion filters for this search.
  const failedCandidate = findFailedCandidate(input.catalog, failed);
  const threshold = capacityThreshold(assessment, failedCandidate);
  const skipFailedProvider = assessment.skipProvider;

  const eligibleFor = (candidate: ResolvedCandidate): boolean => {
    if (hasAttemptedCandidate(attempted, candidate.ref)) return false;
    if (skipFailedProvider && candidate.ref.provider === failed.provider) return false;
    if (threshold !== undefined) {
      if (assessment.failureClass === "context_overflow" && candidate.model.contextWindow <= threshold.contextWindow) return false;
      if (assessment.failureClass === "output_limit" && candidate.model.maxTokens <= threshold.maxTokens) return false;
    }
    return true;
  };

  const tierCandidates = (tier: TierName): readonly ResolvedCandidate[] =>
    input.catalog.tiers[tier].candidates;

  const recordProviderSkip = (): void => {
    if (
      skipFailedProvider &&
      !boundHits.includes("provider_skipped") &&
      tierCandidates(failedTier).some(
        (candidate) =>
          candidate.ref.provider === failed.provider && !hasAttemptedCandidate(attempted, candidate.ref),
      )
    ) {
      boundHits.push("provider_skipped");
    }
  };

  const finish = (
    selection: TierSelection | undefined,
    selectedTier: TierName,
  ): FallbackSelection => {
    const chosen = selection?.selected;
    if (chosen === undefined) {
      // Defensive: every caller checks `selected !== undefined` first; the
      // selection must never be emitted without a chosen candidate.
      throw new RoutingError("invalid_route_result", "fallback selection produced no candidate");
    }
    // Step 8: the chosen identity is appended to the attempted set before the
    // result is emitted, so a later retry cannot select it again.
    const attemptedWithChosen = addAttemptedCandidate(
      attempted,
      chosen.candidate.ref,
      chosen.candidate.tier,
      maxAttempts,
    );
    const tierSwitches =
      selectedTier === failedTier ? tierSwitchesBefore : tierSwitchesBefore + 1;
    return {
      selected: selection,
      selectedTier,
      selectedCandidate: {
        provider: chosen.candidate.ref.provider,
        id: chosen.candidate.ref.id,
      },
      selectedThinking: chosen.thinking.effective,
      attempted: attemptedWithChosen,
      attempts,
      tierSwitches,
      path: [...new Set(path)].slice(0, 8),
      boundHits: boundHits.slice(0, 4),
    };
  };

  // Step 6/7: visit candidates in the assessment's scope order while
  // preserving authored order inside each tier. Same-tier segments first.
  const sameTierAll = tierCandidates(failedTier).filter(eligibleFor);
  const sameProvider = sameTierAll.filter((candidate) => candidate.ref.provider === failed.provider);
  const sameTierOthers = sameTierAll.filter((candidate) => candidate.ref.provider !== failed.provider);

  if (assessment.tierStrategy === "capacity") {
    // Capacity classes: strictly more capacity everywhere, same provider first,
    // then the other same-tier candidates — the eligibleFor filter already
    // enforces the strictly-larger threshold on every segment.
    const segment = selectFromSegment(input, failedTier, sameProvider, { stage: "same_provider", recordCapabilityRejected: false }, path)
      ?? selectFromSegment(input, failedTier, sameTierOthers, { stage: "same_tier", recordCapabilityRejected: true }, path);
    if (segment?.selected !== undefined) return finish(segment, failedTier);
  } else {
    // Non-capacity classes start in the failed tier: same-provider first when
    // the class allows it, then the other same-tier candidates.
    if (sameProvider.length > 0 && assessment.sameProviderFirst) {
      const segment = selectFromSegment(input, failedTier, sameProvider, { stage: "same_provider", recordCapabilityRejected: true }, path);
      if (segment?.selected !== undefined) return finish(segment, failedTier);
    }
    recordProviderSkip();
    if (sameTierOthers.length > 0) {
      const segment = selectFromSegment(input, failedTier, sameTierOthers, { stage: "same_tier", recordCapabilityRejected: true }, path);
      if (segment?.selected !== undefined) return finish(segment, failedTier);
    }
  }

  // Cross-tier segments while the switch budget allows. Capacity classes
  // escalate first (brain → pillar → crowd); the adjacent classes keep the
  // pillar-centered documented order. A blocked switch records
  // tier_switch_limit and terminates with route_limit_exceeded (§3.3).
  const crossTierOrder = assessment.tierStrategy === "capacity"
    ? capacityTierOrder(failedTier)
    : adjacentTierOrder(failedTier);
  let crossedBudget = false;
  for (const tier of crossTierOrder) {
    if (tier === failedTier) continue;
    if (tierSwitchesBefore >= maxTierSwitches) {
      crossedBudget = true;
      break;
    }
    const candidates = tierCandidates(tier).filter(eligibleFor);
    const stage: FallbackStage = TIER_RANK[tier] > TIER_RANK[failedTier] ? "escalate_tier" : "degrade_tier";
    const segment = selectFromSegment(input, tier, candidates, { stage, recordCapabilityRejected: true }, path);
    if (segment?.selected !== undefined) return finish(segment, tier);
  }
  if (crossedBudget) {
    boundHits.push("tier_switch_limit");
    return terminal(input, attempted, attempts, tierSwitchesBefore, path, boundHits);
  }

  // Step 9: the finite search is exhausted. A bound blocked every remaining
  // alternative → route_limit_exceeded; a purely empty/filtered catalog →
  // no_eligible_physical_model.
  recordProviderSkip();
  boundHits.push("candidate_exhausted");
  return terminal(input, attempted, attempts, tierSwitchesBefore, path, boundHits);
}

/** Terminal selection with the safe failure context attached (§3.3). */
function terminal(
  input: FallbackRequest,
  attempted: readonly AttemptedCandidate[],
  attempts: number,
  tierSwitches: number,
  path: readonly FallbackStage[],
  boundHits: readonly BoundHit[],
): FallbackSelection {
  const limitBlocked = boundHits.includes("attempt_limit") || boundHits.includes("tier_switch_limit");
  return {
    selected: undefined,
    selectedTier: null,
    selectedCandidate: null,
    selectedThinking: null,
    attempted,
    attempts,
    tierSwitches,
    path: [...new Set(path)].slice(0, 8),
    boundHits: boundHits.slice(0, 4),
    terminalCode: limitBlocked ? "route_limit_exceeded" : "no_eligible_physical_model",
  };
}

/** Convenience adapter error constructors: identical code and message to Phase 4. */
export const fallbackErrors = {
  noCandidate(context: RouteFailureContext): RouteFallbackError {
    return new RouteFallbackError("no_eligible_physical_model", NO_CANDIDATE_MESSAGE, context);
  },
  limitExceeded(context: RouteFailureContext): RouteFallbackError {
    return new RouteFallbackError("route_limit_exceeded", LIMIT_MESSAGE, context);
  },
} as const;

/** Build the safe failure context from a selection (codes and counters only). */
export function failureContextOf(input: FallbackRequest, selection: FallbackSelection): RouteFailureContext {
  return {
    requestReason: input.requestReason,
    failed: input.failed,
    failureClass: input.assessment.failureClass,
    retryHint: input.assessment.retryHint,
    attempted: selection.attempted,
    attempts: selection.attempts,
    maxAttempts: boundedLimit(input.config.retry.maxAttemptsPerRequest, MAX_ATTEMPTS_PER_REQUEST, 1),
    tierSwitches: selection.tierSwitches,
    maxTierSwitches: boundedLimit(input.config.retry.maxTierSwitches, MAX_TIER_SWITCHES, 0),
    boundHits: selection.boundHits,
  };
}
