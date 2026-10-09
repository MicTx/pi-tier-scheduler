import { describe, expect, it } from "vitest";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";

import {
  clampRequestedThinking,
  deriveCapabilities,
  type PhysicalChatModel,
} from "../../src/catalog";

function fakeModel(
  overrides: Partial<PhysicalChatModel> = {},
): PhysicalChatModel {
  return {
    id: "model",
    name: "provider/model",
    api: "openai-completions",
    provider: "provider",
    baseUrl: "https://api.example.test/v1",
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    reasoning: true,
    contextWindow: 128_000,
    maxTokens: 16_384,
    ...overrides,
  };
}

describe("deriveCapabilities", () => {
  it("copies capability fields and does not share mutable arrays", () => {
    const model = Object.freeze(
      fakeModel({
        input: Object.freeze(["text", "image"]) as unknown as PhysicalChatModel["input"],
        thinkingLevelMap: Object.freeze({ high: "high-budget" }),
      }),
    );
    const before = structuredClone(model);

    const capabilities = deriveCapabilities(model);

    expect(capabilities.input).toEqual(["text", "image"]);
    expect(capabilities.reasoning).toBe(true);
    expect(capabilities.supportedThinkingLevels).toEqual(getSupportedThinkingLevels(model));
    expect(capabilities.contextWindow).toBe(128_000);
    expect(capabilities.maxTokens).toBe(16_384);
    expect(capabilities.input).not.toBe(model.input);
    expect(capabilities.supportedThinkingLevels).not.toBe(getSupportedThinkingLevels(model));
    expect(model).toEqual(before);
  });

  it("exposes only off for non-reasoning models", () => {
    const model = fakeModel({ reasoning: false, thinkingLevelMap: { high: "high-budget" } });
    expect(deriveCapabilities(model).supportedThinkingLevels).toEqual(["off"]);
  });
});

describe("clampRequestedThinking", () => {
  const levels: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

  it("matches the SDK for null entries, explicit extended levels, and every request", () => {
    const model = fakeModel({
      thinkingLevelMap: {
        low: null,
        medium: null,
        high: null,
        xhigh: "xhigh-budget",
        max: "max-budget",
      },
    });

    for (const requested of levels) {
      const result = clampRequestedThinking(model, requested);
      expect(result.effective).toBe(clampThinkingLevel(model, requested));
      expect(result.clamped).toBe(result.effective !== requested);
    }
    expect(deriveCapabilities(model).supportedThinkingLevels).toEqual(["off", "minimal", "xhigh", "max"]);
  });

  it("searches upward before downward and falls back to off when none is supported", () => {
    const upward = fakeModel({ thinkingLevelMap: { low: null, medium: "medium-budget" } });
    expect(clampRequestedThinking(upward, "low")).toEqual({
      requested: "low",
      effective: "medium",
      clamped: true,
    });

    const downward = fakeModel({ thinkingLevelMap: { high: null, xhigh: null, max: null } });
    expect(clampRequestedThinking(downward, "high").effective).toBe("medium");

    const none = fakeModel({
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: null,
        medium: null,
        high: null,
        xhigh: null,
        max: null,
      },
    });
    expect(getSupportedThinkingLevels(none)).toEqual([]);
    expect(clampRequestedThinking(none, "max")).toEqual({
      requested: "max",
      effective: "off",
      clamped: true,
    });
  });

  it("does not mutate the model or rewrite the request", () => {
    const model = Object.freeze(fakeModel({ thinkingLevelMap: Object.freeze({ medium: null }) }));
    const before = structuredClone(model);

    const result = clampRequestedThinking(model, "medium");

    expect(result.requested).toBe("medium");
    expect(model).toEqual(before);
  });
});
