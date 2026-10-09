import { describe, expect, it } from "vitest";

import {
  isComplexity,
  isPhase,
  isThinkingLevel,
  isTier,
  makeRecoveredState,
  sanitizeRouterState,
  STATE_SCHEMA_VERSION,
  VALID_TIERS,
} from "../../src/routing/state";
import type { RouterState } from "../../src/routing/types";

/** A fully valid, exact-shape state as `makeState` would persist it. */
function validState(overrides: Record<string, unknown> = {}): RouterState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    turn: 3,
    phase: "implementation",
    complexity: "standard",
    bias: "medium",
    manualOverride: null,
    sticky: true,
    attempts: 1,
    tierSwitches: 0,
    attempted: [{ provider: "acme", id: "first", tier: "pillar" }],
    activeTier: "pillar",
    activeCandidate: { provider: "acme", id: "first" },
    activeThinking: "medium",
    ...overrides,
  } as RouterState;
}

describe("state guards", () => {
  it("accepts only the declared enum members", () => {
    expect(VALID_TIERS).toEqual(["brain", "pillar", "crowd"]);
    for (const tier of VALID_TIERS) expect(isTier(tier)).toBe(true);
    expect(isTier("brainz")).toBe(false);
    expect(isTier(7)).toBe(false);
    expect(isTier(null)).toBe(false);

    for (const phase of ["planning", "implementation", "verification", "conversation", "unknown"]) {
      expect(isPhase(phase)).toBe(true);
    }
    expect(isPhase("bogus")).toBe(false);

    for (const band of ["low", "standard", "high"]) expect(isComplexity(band)).toBe(true);
    expect(isComplexity("huge")).toBe(false);

    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(isThinkingLevel(level)).toBe(true);
    }
    expect(isThinkingLevel("ultra")).toBe(false);
  });
});

describe("makeRecoveredState", () => {
  it("is the neutral JSON-safe recovery skeleton", () => {
    const state = makeRecoveredState("medium");
    expect(state).toEqual({
      schemaVersion: STATE_SCHEMA_VERSION,
      turn: 0,
      phase: "unknown",
      complexity: "standard",
      bias: "medium",
      manualOverride: null,
      sticky: false,
      attempts: 0,
      tierSwitches: 0,
      attempted: [],
      activeTier: null,
      activeCandidate: null,
      activeThinking: null,
    });
    // Plain JSON values only: the skeleton must round-trip losslessly.
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it("takes the caller's bias fallback", () => {
    expect(makeRecoveredState("high").bias).toBe("high");
  });
});

describe("sanitizeRouterState", () => {
  it("treats absent state as a fresh route, not a recovery", () => {
    expect(sanitizeRouterState(undefined, "medium")).toEqual({
      state: undefined,
      recovered: false,
      biasRecovered: false,
    });
    expect(sanitizeRouterState(null, "medium")).toEqual({
      state: undefined,
      recovered: false,
      biasRecovered: false,
    });
  });

  it("discards non-object input and unknown schema versions as unusable", () => {
    for (const input of ["state", 42, [], [validState()]]) {
      const result = sanitizeRouterState(input, "medium");
      expect(result.state).toBeUndefined();
      expect(result.recovered).toBe(true);
    }

    for (const schemaVersion of [2, 0, "1", undefined]) {
      const result = sanitizeRouterState(validState({ schemaVersion }), "medium");
      expect(result.state).toBeUndefined();
      expect(result.recovered).toBe(true);
    }
  });

  it("keeps a valid exact-shape state by reference", () => {
    const input = validState();
    const result = sanitizeRouterState(input, "medium");
    expect(result.state).toBe(input);
    expect(result.recovered).toBe(false);
    expect(result.biasRecovered).toBe(false);
  });

  it("keeps a JSON round-tripped valid state by reference", () => {
    const input = JSON.parse(JSON.stringify(validState())) as RouterState;
    const result = sanitizeRouterState(input, "medium");
    expect(result.state).toBe(input);
    expect(result.recovered).toBe(false);
  });

  it("preserves every valid field while rebuilding from malformed siblings", () => {
    const input = validState({
      attempts: -3,
      activeCandidate: { provider: 5, id: "first" },
      sticky: "yes",
    });
    const result = sanitizeRouterState(input, "medium");
    expect(result.recovered).toBe(true);
    expect(result.state).toMatchObject({
      schemaVersion: 1,
      turn: 3,
      phase: "implementation",
      complexity: "standard",
      bias: "medium",
      manualOverride: null,
      sticky: false,
      attempts: 0,
      tierSwitches: 0,
      attempted: [{ provider: "acme", id: "first", tier: "pillar" }],
      activeTier: "pillar",
      activeCandidate: null,
      activeThinking: "medium",
    });
    expect(result.state).not.toBe(input);
  });

  it("recovers counters to bounded defaults", () => {
    const maxAttempts = 5;
    expect(sanitizeRouterState(validState({ turn: -1 }), "medium").recovered).toBe(true);
    expect(sanitizeRouterState(validState({ turn: 1.5 }), "medium").recovered).toBe(true);
    expect(sanitizeRouterState(validState({ turn: Number.NaN }), "medium").recovered).toBe(true);
    expect(sanitizeRouterState(validState({ turn: "3" }), "medium").recovered).toBe(true);
    expect(sanitizeRouterState(validState({ attempts: -2 }), "medium").state?.attempts).toBe(0);
    expect(
      sanitizeRouterState(validState({ attempts: 99 }), "medium").state?.attempts,
    ).toBe(maxAttempts);
    expect(
      sanitizeRouterState(validState({ tierSwitches: 99 }), "medium").state?.tierSwitches,
    ).toBe(3);
    expect(sanitizeRouterState(validState({ turn: 7 }), "medium").state?.turn).toBe(7);
  });

  it("recovers enum and boolean fields to safe values", () => {
    expect(sanitizeRouterState(validState({ phase: "bogus" }), "medium").state?.phase).toBe("unknown");
    expect(sanitizeRouterState(validState({ complexity: "huge" }), "medium").state?.complexity).toBe("standard");
    expect(sanitizeRouterState(validState({ manualOverride: "brainz" }), "medium").state?.manualOverride).toBeNull();
    expect(sanitizeRouterState(validState({ manualOverride: 7 }), "medium").recovered).toBe(true);
    expect(sanitizeRouterState(validState({ activeTier: "bogus" }), "medium").state?.activeTier).toBeNull();
    expect(sanitizeRouterState(validState({ activeThinking: "ultra" }), "medium").state?.activeThinking).toBeNull();
    expect(sanitizeRouterState(validState({ sticky: 1 }), "medium").state?.sticky).toBe(false);
    // Valid nullable fields stay untouched.
    expect(sanitizeRouterState(validState({ activeThinking: "xhigh" }), "medium").state?.activeThinking).toBe("xhigh");
  });

  it("drops malformed attempted entries and caps oversized lists", () => {
    const oversized = Array.from({ length: 7 }, (_, index) => ({
      provider: "acme",
      id: `model-${index}`,
      tier: "pillar",
    }));
    const capped = sanitizeRouterState(validState({ attempted: oversized }), "medium");
    expect(capped.recovered).toBe(true);
    expect(capped.state?.attempted).toHaveLength(5);
    expect(capped.state?.attempted[0]).toEqual({ provider: "acme", id: "model-2", tier: "pillar" });

    const malformed = [
      { provider: "acme", id: "ok", tier: "pillar" },
      "garbage",
      { provider: "acme", id: "no-tier" },
      { provider: "acme", id: "bad-tier", tier: "bogus" },
      { provider: "", id: "empty-provider", tier: "pillar" },
      { provider: "acme", id: "extra", tier: "pillar", junk: "x" },
    ];
    const dropped = sanitizeRouterState(validState({ attempted: malformed }), "medium");
    expect(dropped.recovered).toBe(true);
    expect(dropped.state?.attempted).toEqual([{ provider: "acme", id: "ok", tier: "pillar" }]);

    expect(sanitizeRouterState(validState({ attempted: "nope" }), "medium").state?.attempted).toEqual([]);
  });

  it("recovers a malformed activeCandidate identity", () => {
    for (const activeCandidate of ["acme", { provider: "acme" }, { provider: 5, id: 6 }, 42]) {
      const result = sanitizeRouterState(validState({ activeCandidate }), "medium");
      expect(result.recovered).toBe(true);
      expect(result.state?.activeCandidate).toBeNull();
    }
    const identity = { provider: "acme", id: "keep" };
    expect(sanitizeRouterState(validState({ activeCandidate: identity }), "medium").state?.activeCandidate)
      .toEqual({ provider: "acme", id: "keep" });
  });

  it("reports an invalid bias separately without structural recovery", () => {
    const input = validState({ bias: "ultra" });
    const result = sanitizeRouterState(input, "high");
    expect(result.recovered).toBe(false);
    expect(result.biasRecovered).toBe(true);
    expect(result.state).not.toBe(input);
    expect(result.state?.bias).toBe("high");
    expect(result.state?.turn).toBe(3);
    expect(result.state?.activeCandidate).toEqual({ provider: "acme", id: "first" });
  });

  it("treats shape drift — extra or missing keys — as stale data", () => {
    const withExtra = { ...validState(), junk: "payload" } as unknown as RouterState;
    const extra = sanitizeRouterState(withExtra, "medium");
    expect(extra.recovered).toBe(true);
    expect(extra.state).not.toHaveProperty("junk");
    expect(JSON.stringify(extra.state)).not.toContain("payload");

    const protoKey = JSON.parse(
      '{"schemaVersion":1,"turn":1,"phase":"unknown","complexity":"standard","bias":"medium","manualOverride":null,"sticky":false,"attempts":0,"tierSwitches":0,"attempted":[],"activeTier":null,"activeCandidate":null,"activeThinking":null,"__proto__":{"injected":true}}',
    );
    const injected = sanitizeRouterState(protoKey, "medium");
    expect(injected.recovered).toBe(true);
    expect(JSON.stringify(injected.state)).not.toContain("injected");
    expect(Object.keys(injected.state as object)).toHaveLength(13);

    const { turn, ...missing } = validState();
    const missed = sanitizeRouterState(missing, "medium");
    expect(missed.recovered).toBe(true);
    expect(missed.state?.turn).toBe(0);
  });

  it("is pure: it never mutates its input and stays deterministic", () => {
    const input = validState({ attempts: -1 });
    const before = JSON.stringify(input);
    const first = sanitizeRouterState(input, "medium");
    const second = sanitizeRouterState(input, "medium");
    expect(first).toEqual(second);
    expect(JSON.stringify(input)).toBe(before);

    const valid = validState();
    const untouched = JSON.stringify(valid);
    sanitizeRouterState(valid, "medium");
    expect(JSON.stringify(valid)).toBe(untouched);
  });
});
