import { describe, expect, it } from "vitest";
import {
  adjustTierForBias,
  adjustTierForComplexity,
  fallbackOrder,
  normalizeBias,
  tierForPhase,
} from "../../src/routing";

describe("deterministic tier policy", () => {
  it("maps phases and moves at most one rung", () => {
    expect(tierForPhase("planning")).toBe("brain");
    expect(tierForPhase("implementation")).toBe("pillar");
    expect(tierForPhase("conversation")).toBe("crowd");
    expect(adjustTierForComplexity("pillar", "high")).toBe("brain");
    expect(adjustTierForComplexity("crowd", "low")).toBe("crowd");
    expect(adjustTierForBias("pillar", "low")).toBe("crowd");
    expect(adjustTierForBias("pillar", "high")).toBe("brain");
  });

  it("normalizes invalid bias without throwing", () => {
    expect(normalizeBias("bogus")).toEqual({ bias: "medium", recovered: true });
    expect(normalizeBias(undefined, "high")).toEqual({ bias: "high", recovered: false });
    expect(normalizeBias("low")).toEqual({ bias: "low", recovered: false });
  });

  it("uses exact automatic and manual fallback ladders", () => {
    expect(fallbackOrder("brain")).toEqual(["brain", "pillar", "crowd"]);
    expect(fallbackOrder("pillar")).toEqual(["pillar", "brain", "crowd"]);
    expect(fallbackOrder("crowd")).toEqual(["crowd", "pillar", "brain"]);
    expect(fallbackOrder("crowd", true)).toEqual(["crowd", "pillar", "brain"]);
    expect(fallbackOrder("brain", true)).toEqual(["brain", "pillar", "crowd"]);
  });
});
