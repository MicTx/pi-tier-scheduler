import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

import type { TierName } from "../config/types";
import { THINKING_LEVEL_ORDER } from "./constants";
import { clampRequestedThinking, deriveCapabilities } from "./capabilities";
import type {
  CandidateEvaluation,
  CandidateFailure,
  InvalidTaskConstraint,
  ModelCapabilities,
  NormalizedTaskConstraints,
  ResolvedCandidate,
  ResolvedTier,
  TaskConstraints,
  TierPolicy,
  TierSelection,
} from "./types";

const TIER_POLICIES: Readonly<Record<TierName, TierPolicy>> = Object.freeze({
  brain: Object.freeze({ preferredThinking: "high", minimumThinking: "medium", requiresReasoning: true }),
  pillar: Object.freeze({ preferredThinking: "medium", minimumThinking: "low", requiresReasoning: false }),
  crowd: Object.freeze({ preferredThinking: "low", minimumThinking: "off", requiresReasoning: false }),
});

export function getTierPolicy(tier: TierName): TierPolicy {
  return TIER_POLICIES[tier];
}

function levelIndex(level: ModelThinkingLevel): number {
  return THINKING_LEVEL_ORDER.indexOf(level);
}

function higherLevel(left: ModelThinkingLevel, right: ModelThinkingLevel): ModelThinkingLevel {
  return levelIndex(left) > levelIndex(right) ? left : right;
}

function requestedForTier(tier: TierName, requested: ModelThinkingLevel | undefined): ModelThinkingLevel {
  const policy = getTierPolicy(tier);
  const initial = requested ?? policy.preferredThinking;
  return levelIndex(initial) < levelIndex(policy.minimumThinking) ? policy.minimumThinking : initial;
}

function hasValidMetadata(capabilities: ModelCapabilities): boolean {
  return (
    Number.isFinite(capabilities.contextWindow) &&
    capabilities.contextWindow > 0 &&
    Number.isFinite(capabilities.maxTokens) &&
    capabilities.maxTokens > 0
  );
}

export function buildTierConstraints(
  tier: TierName,
  task: TaskConstraints,
): NormalizedTaskConstraints | InvalidTaskConstraint {
  if (
    (task.minimumContextWindow !== undefined &&
      (!Number.isFinite(task.minimumContextWindow) || task.minimumContextWindow < 0)) ||
    (task.minimumOutputTokens !== undefined &&
      (!Number.isFinite(task.minimumOutputTokens) || task.minimumOutputTokens < 0))
  ) {
    return { invalid: true };
  }

  const policy = getTierPolicy(tier);
  return {
    requiredInput: task.requiredInput,
    minimumContextWindow: task.minimumContextWindow,
    minimumOutputTokens: task.minimumOutputTokens,
    requiresReasoning: policy.requiresReasoning || (task.requiresReasoning ?? false),
    minimumThinkingLevel: higherLevel(policy.minimumThinking, task.minimumThinkingLevel ?? policy.minimumThinking),
  };
}

export function evaluateCandidate(
  candidate: ResolvedCandidate,
  requested: ModelThinkingLevel,
  constraints: NormalizedTaskConstraints,
): CandidateEvaluation {
  const capabilities = deriveCapabilities(candidate.model);
  const metadataValid = hasValidMetadata(capabilities);
  const failures: CandidateFailure[] = [];
  const tierRequested = requestedForTier(candidate.tier, requested);
  const thinking = clampRequestedThinking(candidate.model, tierRequested);

  if (!metadataValid) {
    failures.push({ code: "invalid_model_capability", detail: "metadata" });
  }
  if (constraints.requiredInput !== undefined && !capabilities.input.includes(constraints.requiredInput)) {
    failures.push({ code: "input_unsupported", detail: "required_input" });
  }
  if (
    metadataValid &&
    constraints.minimumContextWindow !== undefined &&
    capabilities.contextWindow < constraints.minimumContextWindow
  ) {
    failures.push({ code: "context_too_small", detail: "context_window" });
  }
  if (
    metadataValid &&
    constraints.minimumOutputTokens !== undefined &&
    capabilities.maxTokens < constraints.minimumOutputTokens
  ) {
    failures.push({ code: "output_limit_too_small", detail: "max_tokens" });
  }
  if (constraints.requiresReasoning && !capabilities.reasoning) {
    failures.push({ code: "reasoning_unsupported", detail: "reasoning" });
  }
  if (levelIndex(thinking.effective) < levelIndex(constraints.minimumThinkingLevel)) {
    failures.push({ code: "thinking_below_minimum", detail: "thinking" });
  }

  if (failures.length > 0) {
    return {
      eligible: false,
      candidate,
      capabilities: metadataValid ? capabilities : undefined,
      failures,
    };
  }

  return {
    eligible: true,
    candidate,
    capabilities,
    thinking,
  };
}

export function selectFirstEligible(
  tier: ResolvedTier,
  requested: ModelThinkingLevel | undefined,
  task: TaskConstraints,
): TierSelection {
  const requestedThinking = requestedForTier(tier.tier, requested);
  const constraints = buildTierConstraints(tier.tier, task);
  const evaluations: CandidateEvaluation[] = [];
  let selected: Extract<CandidateEvaluation, { eligible: true }> | undefined;

  for (const candidate of tier.candidates) {
    let evaluation: CandidateEvaluation;
    if ("invalid" in constraints) {
      const capabilities = deriveCapabilities(candidate.model);
      evaluation = {
        eligible: false,
        candidate,
        capabilities: hasValidMetadata(capabilities) ? capabilities : undefined,
        failures: [{ code: "invalid_task_constraint" }],
      };
    } else {
      evaluation = evaluateCandidate(candidate, requestedThinking, constraints);
    }
    evaluations.push(evaluation);
    if (evaluation.eligible && selected === undefined) {
      selected = evaluation;
    }
  }

  return {
    tier: tier.tier,
    requestedThinking,
    selected,
    evaluations,
    exhausted: selected === undefined,
  };
}
