import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { TierName, ThinkingBias } from "../config/types";
import type { BiasNormalization } from "./types";

export const ROUTING_TIER_LADDER: readonly TierName[] = ["crowd", "pillar", "brain"];

const BIAS_LEVELS: readonly ThinkingBias[] = ["low", "medium", "high"];

function indexOfTier(tier: TierName): number {
  return ROUTING_TIER_LADDER.indexOf(tier);
}

function moveTier(tier: TierName, delta: number): TierName {
  const index = Math.max(0, Math.min(ROUTING_TIER_LADDER.length - 1, indexOfTier(tier) + delta));
  return ROUTING_TIER_LADDER[index]!;
}

export function tierForPhase(phase: import("./types").WorkPhase): TierName {
  switch (phase) {
    case "planning": return "brain";
    case "implementation":
    case "verification": return "pillar";
    case "conversation": return "crowd";
    case "unknown": return "pillar";
  }
}

export function adjustTierForComplexity(base: TierName, complexity: import("./types").ComplexityBand): TierName {
  if (complexity === "high") return moveTier(base, 1);
  if (complexity === "low") return moveTier(base, -1);
  return base;
}

export function adjustTierForBias(tier: TierName, bias: ThinkingBias): TierName {
  if (bias === "high") return moveTier(tier, 1);
  if (bias === "low") return moveTier(tier, -1);
  return tier;
}

export function normalizeBias(value: unknown, fallback: ThinkingBias = "medium"): BiasNormalization {
  if (BIAS_LEVELS.includes(value as ThinkingBias)) return { bias: value as ThinkingBias, recovered: false };
  if (BIAS_LEVELS.includes(fallback)) return { bias: fallback, recovered: value !== undefined };
  return { bias: "medium", recovered: true };
}

export function fallbackOrder(requested: TierName, manual = false): readonly TierName[] {
  if (manual) {
    return [requested, "pillar", "brain", "crowd"].filter((tier, index, tiers) => tiers.indexOf(tier) === index) as TierName[];
  }
  switch (requested) {
    case "brain": return ["brain", "pillar", "crowd"];
    case "pillar": return ["pillar", "brain", "crowd"];
    case "crowd": return ["crowd", "pillar", "brain"];
  }
}

export function thinkingForBias(bias: ThinkingBias): ModelThinkingLevel {
  return bias;
}
