import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { MAX_ATTEMPTS_PER_REQUEST, MAX_TIER_SWITCHES } from "../config/constants";
import type { RetryConfig, TierName } from "../config/types";
import { selectFirstEligible, type CatalogResolution, type ResolvedCandidate, type TaskConstraints } from "../catalog";
import type {
  AttemptedCandidate,
  CandidateIdentity,
  RetryHint,
  RetrySelection,
  RouterState,
  RoutingErrorCode,
} from "./types";

/** Provider text is only inspected locally and never crosses the route boundary. */
const FAILURE_TEXT_LIMIT = 512;

export class RoutingError extends Error {
  readonly code: RoutingErrorCode;

  constructor(code: RoutingErrorCode, message: string) {
    super(message);
    this.name = "RoutingError";
    this.code = code;
  }
}

export class RouteLimitExceeded extends RoutingError {
  constructor() {
    super("route_limit_exceeded", "The configured routing retry limit was reached");
    this.name = "RouteLimitExceeded";
  }
}

const physicalFailurePatterns = [
  /context[_ -]?length/i,
  /context window/i,
  /maximum context/i,
  /too many tokens/i,
  /token limit/i,
  /prompt too long/i,
  /input too long/i,
  /request too large/i,
  /exceed(?:ed)? the (?:maximum )?token/i,
];
const transientFailurePatterns = [
  /rate limit/i,
  /too many requests/i,
  /overload/i,
  /tim(?:e|ed)[ -]?out/i,
  /unavailable/i,
  /temporar(?:y|ily)/i,
  /\b429\b|\b5(?:00|02|03|04)\b/,
];
const permanentFailurePatterns = [
  /auth(?:entication|orization)/i,
  /unauthori[sz]ed/i,
  /permission denied/i,
  /forbidden/i,
  /invalid request/i,
  /bad request/i,
  /invalid api key/i,
  /api key/i,
];

function failureText(message: AssistantMessage): string {
  const stopReason = typeof message.stopReason === "string" ? message.stopReason : "";
  const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : "";
  return `${stopReason} ${errorMessage}`.slice(0, FAILURE_TEXT_LIMIT).toLowerCase();
}

/** Classify only the coarse, stable hint used by the finite retry policy. */
export function classifyRetryHint(message: AssistantMessage): RetryHint {
  const text = failureText(message);
  if (text.includes("length") || physicalFailurePatterns.some((pattern) => pattern.test(text))) {
    return "context_overflow";
  }
  if (transientFailurePatterns.some((pattern) => pattern.test(text))) return "transient";
  if (permanentFailurePatterns.some((pattern) => pattern.test(text))) return "permanent";
  return "unknown";
}

export function candidateIdentity(provider: string, id: string): CandidateIdentity {
  return { provider, id };
}

export function sameCandidate(left: CandidateIdentity | undefined, right: CandidateIdentity | undefined): boolean {
  return left !== undefined && right !== undefined && left.provider === right.provider && left.id === right.id;
}

export function candidateKey(candidate: CandidateIdentity): string {
  return `${candidate.provider}\0${candidate.id}`;
}

export function hasAttemptedCandidate(
  attempted: readonly AttemptedCandidate[],
  candidate: CandidateIdentity,
): boolean {
  return attempted.some((entry) => sameCandidate(entry, candidate));
}

export function addAttemptedCandidate(
  attempted: readonly AttemptedCandidate[],
  candidate: CandidateIdentity,
  tier: TierName,
  limit = MAX_ATTEMPTS_PER_REQUEST,
): AttemptedCandidate[] {
  const bounded = Math.max(0, limit);
  if (bounded === 0) return [];
  if (hasAttemptedCandidate(attempted, candidate)) return [...attempted].slice(-bounded);
  return [...attempted, { provider: candidate.provider, id: candidate.id, tier }].slice(-bounded);
}

export function retryTierOrder(hint: RetryHint, failedTier: TierName | null): readonly TierName[] {
  if (hint === "context_overflow") return ["brain", "pillar", "crowd"];
  const base = failedTier === null ? [] : [failedTier];
  return [...base, "pillar", "brain", "crowd"].filter(
    (tier, index, tiers) => tiers.indexOf(tier) === index,
  ) as TierName[];
}

function boundedLimit(value: number, maximum: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value))) : fallback;
}

function candidateOrder(
  candidates: readonly ResolvedCandidate[],
  failed: CandidateIdentity,
): readonly ResolvedCandidate[] {
  const failedIndex = candidates.find((entry) => sameCandidate(entry.ref, failed))?.configIndex;
  if (failedIndex === undefined) return candidates;
  return [...candidates].sort((left, right) => {
    const leftAfter = left.configIndex > failedIndex ? 0 : 1;
    const rightAfter = right.configIndex > failedIndex ? 0 : 1;
    return leftAfter - rightAfter || left.configIndex - right.configIndex;
  });
}

function selectFromTier(
  resolution: CatalogResolution,
  tier: TierName,
  attempted: readonly AttemptedCandidate[],
  failed: CandidateIdentity,
  requestedThinking: ModelThinkingLevel | undefined,
  task: TaskConstraints,
): { candidate: ResolvedCandidate; thinking: ModelThinkingLevel } | undefined {
  const ordered = tier === attempted.find((entry) => sameCandidate(entry, failed))?.tier
    ? candidateOrder(resolution.tiers[tier].candidates, failed)
    : resolution.tiers[tier].candidates;
  const candidates = ordered.filter((entry) => !hasAttemptedCandidate(attempted, entry.ref));
  if (candidates.length === 0) return undefined;
  const outcome = selectFirstEligible(
    { ...resolution.tiers[tier], candidates },
    requestedThinking,
    task,
  );
  return outcome.selected === undefined
    ? undefined
    : { candidate: outcome.selected.candidate, thinking: outcome.selected.thinking.effective };
}

/** Select one finite retry alternative without invoking routing recursively. */
export function selectRetryCandidate(
  resolution: CatalogResolution,
  state: RouterState | undefined,
  failed: { model: Model<Api> } | undefined,
  hint: RetryHint,
  task: TaskConstraints,
  limits: RetryConfig,
  requestedThinking?: ModelThinkingLevel,
  failedTier: TierName | null = state?.activeTier ?? null,
): RetrySelection {
  const failedIdentity = failed === undefined
    ? { provider: "", id: "" }
    : { provider: failed.model.provider, id: failed.model.id };
  const maxAttempts = boundedLimit(limits.maxAttemptsPerRequest, MAX_ATTEMPTS_PER_REQUEST, 1);
  const maxTierSwitches = boundedLimit(limits.maxTierSwitches, MAX_TIER_SWITCHES, 0);
  const currentAttempts = Math.max(1, Number.isFinite(state?.attempts) ? Math.floor(state!.attempts) : 1);
  if (currentAttempts >= maxAttempts) throw new RouteLimitExceeded();

  let attempted = [...(state?.attempted ?? [])].slice(0, maxAttempts);
  if (failedIdentity.provider !== "") {
    // Keep the failed identity excluded even when an injected/old state omitted its tier.
    attempted = addAttemptedCandidate(
      attempted,
      failedIdentity,
      failedTier ?? state?.activeTier ?? "pillar",
      maxAttempts,
    );
  }

  const sameTier = failedTier === null
    ? undefined
    : selectFromTier(resolution, failedTier, attempted, failedIdentity, requestedThinking, task);
  if (sameTier !== undefined) {
    return {
      hint,
      failed: failedIdentity,
      failedTier,
      selected: sameTier.candidate,
      selectedThinking: sameTier.thinking,
      sameTier: true,
      tierSwitches: state?.tierSwitches ?? 0,
      attempted: addAttemptedCandidate(attempted, sameTier.candidate.ref, sameTier.candidate.tier, maxAttempts),
    };
  }

  const currentSwitches = Math.max(0, Number.isFinite(state?.tierSwitches) ? Math.floor(state!.tierSwitches) : 0);
  for (const tier of retryTierOrder(hint, failedTier)) {
    if (tier === failedTier) continue;
    if (currentSwitches >= maxTierSwitches) break;
    const selection = selectFromTier(resolution, tier, attempted, failedIdentity, requestedThinking, task);
    if (selection === undefined) continue;
    return {
      hint,
      failed: failedIdentity,
      failedTier,
      selected: selection.candidate,
      selectedThinking: selection.thinking,
      sameTier: false,
      tierSwitches: currentSwitches + 1,
      attempted: addAttemptedCandidate(attempted, selection.candidate.ref, tier, maxAttempts),
    };
  }

  if (currentSwitches >= maxTierSwitches && retryTierOrder(hint, failedTier).some((tier) => tier !== failedTier)) {
    throw new RouteLimitExceeded();
  }
  return {
    hint,
    failed: failedIdentity,
    failedTier,
    selected: undefined,
    selectedThinking: undefined,
    sameTier: false,
    tierSwitches: currentSwitches,
    attempted,
  };
}

export type { RetryHint };
