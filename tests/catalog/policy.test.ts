import { describe, expect, it } from "vitest";

import {
  buildTierConstraints,
  evaluateCandidate,
  getTierPolicy,
  selectFirstEligible,
  type PhysicalChatModel,
  type ResolvedCandidate,
  type ResolvedTier,
  type TaskConstraints,
} from "../../src/catalog";
import type { TierName } from "../../src/config/types";

function fakeModel(
  provider: string,
  id: string,
  overrides: Partial<PhysicalChatModel> = {},
): PhysicalChatModel {
  return {
    id,
    name: `${provider}/${id}`,
    api: "openai-completions",
    provider,
    baseUrl: "https://api.example.test/v1",
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    reasoning: true,
    contextWindow: 128_000,
    maxTokens: 16_384,
    ...overrides,
  };
}

function candidate(
  tier: TierName,
  model: PhysicalChatModel,
  configIndex = 0,
): ResolvedCandidate {
  return {
    tier,
    configIndex,
    ref: { provider: model.provider, id: model.id },
    key: `${model.provider}\0${model.id}`,
    model,
  };
}

function tier(tierName: TierName, candidates: readonly ResolvedCandidate[]): ResolvedTier {
  return {
    tier: tierName,
    configured: candidates.map((item) => item.ref),
    candidates,
    skipped: [],
  };
}

function codes(result: ReturnType<typeof evaluateCandidate>): string[] {
  return result.eligible ? [] : result.failures.map((failure) => failure.code);
}

describe("fixed tier policy", () => {
  it("returns the documented policy table", () => {
    expect(getTierPolicy("brain")).toEqual({
      preferredThinking: "high",
      minimumThinking: "medium",
      requiresReasoning: true,
    });
    expect(getTierPolicy("pillar")).toEqual({
      preferredThinking: "medium",
      minimumThinking: "low",
      requiresReasoning: false,
    });
    expect(getTierPolicy("crowd")).toEqual({
      preferredThinking: "low",
      minimumThinking: "off",
      requiresReasoning: false,
    });
  });

  it("combines task requirements without weakening tier floors", () => {
    expect(buildTierConstraints("brain", { minimumThinkingLevel: "low" })).toEqual({
      minimumThinkingLevel: "medium",
      requiresReasoning: true,
    });
    expect(buildTierConstraints("pillar", { minimumThinkingLevel: "high", requiresReasoning: true })).toEqual({
      minimumThinkingLevel: "high",
      requiresReasoning: true,
    });
    expect(buildTierConstraints("crowd", { minimumContextWindow: 0, minimumOutputTokens: 0 })).toEqual({
      minimumContextWindow: 0,
      minimumOutputTokens: 0,
      requiresReasoning: false,
      minimumThinkingLevel: "off",
    });
  });
});

describe("buildTierConstraints invalid input", () => {
  it.each([
    ["NaN context", { minimumContextWindow: Number.NaN }],
    ["infinite context", { minimumContextWindow: Number.POSITIVE_INFINITY }],
    ["negative context", { minimumContextWindow: -1 }],
    ["NaN output", { minimumOutputTokens: Number.NaN }],
    ["infinite output", { minimumOutputTokens: Number.POSITIVE_INFINITY }],
    ["negative output", { minimumOutputTokens: -1 }],
  ])("returns an explicit invalid result for %s", (_label, task) => {
    expect(buildTierConstraints("crowd", task)).toEqual({ invalid: true });
  });
});

describe("evaluateCandidate", () => {
  it("records all applicable failures in the documented order", () => {
    const model = fakeModel("provider", "weak", {
      input: ["image"],
      reasoning: false,
      contextWindow: 10,
      maxTokens: 2,
    });
    const item = candidate("brain", model);
    const constraints = buildTierConstraints("brain", {
      requiredInput: "text",
      minimumContextWindow: 100,
      minimumOutputTokens: 20,
    });
    if ("invalid" in constraints) throw new Error("test constraints unexpectedly invalid");

    const result = evaluateCandidate(item, "low", constraints);

    expect(codes(result)).toEqual([
      "input_unsupported",
      "context_too_small",
      "output_limit_too_small",
      "reasoning_unsupported",
      "thinking_below_minimum",
    ]);
  });

  it("reports invalid metadata first and omits untrustworthy capabilities", () => {
    const model = fakeModel("provider", "invalid", { contextWindow: 0, maxTokens: Number.NaN });
    const item = candidate("crowd", model);
    const constraints = buildTierConstraints("crowd", {});
    if ("invalid" in constraints) throw new Error("test constraints unexpectedly invalid");

    const result = evaluateCandidate(item, "low", constraints);

    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.failures).toEqual([{ code: "invalid_model_capability", detail: "metadata" }]);
    expect(result.capabilities).toBeUndefined();
  });

  it("raises below-floor requests before SDK clamping", () => {
    const mediumOnly = fakeModel("provider", "medium", {
      thinkingLevelMap: { high: null, xhigh: null, max: null },
    });
    const item = candidate("brain", mediumOnly);
    const constraints = buildTierConstraints("brain", {});
    if ("invalid" in constraints) throw new Error("test constraints unexpectedly invalid");

    const result = evaluateCandidate(item, "low", constraints);

    expect(result.eligible).toBe(true);
    if (!result.eligible) return;
    expect(result.thinking).toEqual({ requested: "medium", effective: "medium", clamped: false });
  });

  it("rejects a clamped result that remains below a stricter task floor", () => {
    const mediumOnly = fakeModel("provider", "medium", {
      thinkingLevelMap: { high: null, xhigh: null, max: null },
    });
    const item = candidate("brain", mediumOnly);
    const constraints = buildTierConstraints("brain", { minimumThinkingLevel: "high" });
    if ("invalid" in constraints) throw new Error("test constraints unexpectedly invalid");

    const result = evaluateCandidate(item, "low", constraints);

    expect(codes(result)).toEqual(["thinking_below_minimum"]);
  });
});

describe("selectFirstEligible", () => {
  it("selects the first eligible candidate and still evaluates later candidates", () => {
    const rejected = candidate("crowd", fakeModel("provider", "rejected", { input: ["image"], contextWindow: 1 }), 0);
    const selected = candidate("crowd", fakeModel("provider", "selected"), 1);
    const later = candidate("crowd", fakeModel("provider", "later", { contextWindow: 1 }), 2);
    const result = selectFirstEligible(tier("crowd", [rejected, selected, later]), undefined, {
      requiredInput: "text",
      minimumContextWindow: 100,
    });

    expect(result.requestedThinking).toBe("low");
    expect(result.selected?.candidate).toBe(selected);
    expect(result.evaluations).toHaveLength(3);
    expect(result.exhausted).toBe(false);
    expect(result.evaluations[0].eligible).toBe(false);
    if (result.evaluations[0].eligible) throw new Error("first candidate unexpectedly eligible");
    expect(result.evaluations[0].failures.map((failure) => failure.code)).toEqual([
      "input_unsupported",
      "context_too_small",
    ]);
    expect(result.evaluations[2].eligible).toBe(false);
    if (result.evaluations[2].eligible) throw new Error("later candidate unexpectedly eligible");
    expect(result.evaluations[2].failures.map((failure) => failure.code)).toEqual(["context_too_small"]);
  });

  it("returns a finite exhausted result for empty tiers", () => {
    const result = selectFirstEligible(tier("pillar", []), "off", {});
    expect(result).toEqual({
      tier: "pillar",
      requestedThinking: "low",
      selected: undefined,
      evaluations: [],
      exhausted: true,
    });
  });

  it("reports invalid task constraints once per candidate without coercion", () => {
    const first = candidate("crowd", fakeModel("provider", "first"), 0);
    const second = candidate("crowd", fakeModel("provider", "second"), 1);
    const task: TaskConstraints = Object.freeze({ minimumContextWindow: Number.NaN });
    const result = selectFirstEligible(tier("crowd", Object.freeze([first, second])), undefined, task);

    expect(result.exhausted).toBe(true);
    expect(result.evaluations).toHaveLength(2);
    expect(result.evaluations).toEqual([
      expect.objectContaining({ eligible: false, candidate: first, failures: [{ code: "invalid_task_constraint" }] }),
      expect.objectContaining({ eligible: false, candidate: second, failures: [{ code: "invalid_task_constraint" }] }),
    ]);
  });

  it("preserves frozen inputs", () => {
    const model = Object.freeze(
      fakeModel("provider", "frozen", {
        input: Object.freeze(["text"]) as unknown as PhysicalChatModel["input"],
      }),
    );
    const item = candidate("crowd", model);
    const inputTier = Object.freeze(tier("crowd", Object.freeze([item])));
    const task = Object.freeze({ requiredInput: "text" as const, minimumContextWindow: 1 });
    const before = structuredClone({ model, item, inputTier, task });

    selectFirstEligible(inputTier, undefined, task);

    expect({ model, item, inputTier, task }).toEqual(before);
  });
});
