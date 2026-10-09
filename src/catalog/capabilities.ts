import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";

import type { PhysicalChatModel, ModelCapabilities, ThinkingClamp } from "./types";

/**
 * Copy the capability facts needed by policy evaluation. The SDK model remains
 * owned by the registry; neither it nor its nested input/map values are edited.
 */
export function deriveCapabilities(model: PhysicalChatModel): ModelCapabilities {
  return Object.freeze({
    input: Object.freeze([...model.input]),
    reasoning: model.reasoning,
    supportedThinkingLevels: Object.freeze([...getSupportedThinkingLevels(model)]),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  });
}

/**
 * Expose Pi's own clamp semantics before dispatch without changing the request
 * or the registry model.
 */
export function clampRequestedThinking(
  model: PhysicalChatModel,
  requested: ModelThinkingLevel,
): ThinkingClamp {
  const effective = clampThinkingLevel(model, requested);
  return Object.freeze({
    requested,
    effective,
    clamped: effective !== requested,
  });
}
