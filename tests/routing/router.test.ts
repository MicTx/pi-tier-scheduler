import { describe, expect, it } from "vitest";
import type { Model, Api, Message } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  routeRequest,
  NoEligiblePhysicalModel,
  RouteLimitExceeded,
  RoutingError,
  inspectRouteFailure,
  type RouteRequest,
} from "../../src/routing";
import type { EffectiveConfig } from "../../src/config/types";

function model(provider: string, id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id, name: `${provider}/${id}`, api: "openai-completions", provider,
    baseUrl: "https://example.test", input: ["text"],
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, reasoning: true,
    contextWindow: 100_000, maxTokens: 8_000, ...overrides,
  };
}
function config(
  overrides: Partial<EffectiveConfig["tiers"]> = {},
  retryOverrides: Partial<EffectiveConfig["retry"]> = {},
): EffectiveConfig {
  return {
    schemaVersion: 1,
    tiers: {
      brain: { candidates: [] }, pillar: { candidates: [] }, crowd: { candidates: [] }, ...overrides,
    },
    policy: { defaultBias: "medium", sticky: true },
    retry: { maxAttemptsPerRequest: 3, maxTierSwitches: 2, ...retryOverrides },
    provenance: {},
  };
}
function request(modelEntry: Model<Api>, text: string, overrides: Partial<RouteRequest> = {}): RouteRequest {
  const message: Message = { role: "user", content: text, timestamp: 0 };
  return { model: modelEntry, thinkingLevel: "medium", reason: "user", messages: [message], ...overrides };
}
function context(available: readonly Model<Api>[], branch: readonly SessionEntry[] = []): ExtensionContext {
  return { modelRegistry: {
    getAvailable: () => [...available],
    find: (provider: string, id: string) => available.find((entry) => entry.provider === provider && entry.id === id),
  }, sessionManager: { getBranch: () => [...branch] } } as unknown as ExtensionContext;
}
function ref(provider: string, id: string) { return { provider, id }; }

const virtual = model("ts", "auto", { api: "pi-virtual" });

describe("routeRequest", () => {
  it("selects the authored candidate and returns a redacted JSON-safe decision", () => {
    const first = model("acme", "first");
    const second = model("acme", "second");
    const decision = routeRequest(
      request(virtual, "implement a parser"),
      context([first, second]),
      { config: config({ pillar: { candidates: [ref("acme", "first"), ref("acme", "second")] } }) },
    );
    expect(decision.model).toBe(first);
    expect(decision.tier).toBe("pillar");
    expect(decision.candidate).toEqual(ref("acme", "first"));
    expect(JSON.stringify({ reason: decision.reason, state: decision.state })).not.toContain("implement a parser");
    expect(JSON.stringify({ reason: decision.reason, state: decision.state })).not.toContain("example.test");
    expect(decision.reason.code).toBe("work_phase");
  });

  it("uses automatic fallback and manual override precedence", () => {
    const brain = model("acme", "brain");
    const pillar = model("acme", "pillar");
    const auto = routeRequest(
      request(virtual, "plan the architecture"),
      context([pillar]),
      { config: config({ brain: { candidates: [ref("acme", "brain")] }, pillar: { candidates: [ref("acme", "pillar")] } }) },
    );
    expect(auto.model).toBe(pillar);
    expect(auto.reason.fallbackFrom).toBe("brain");
    expect(auto.reason.code).toBe("automatic_fallback");

    const manualEntry = { type: "custom", customType: "pi-tier-scheduler.router-control", data: { schemaVersion: 1, manualOverride: "brain" } } as unknown as SessionEntry;
    const manual = routeRequest(
      request(virtual, "explain this"),
      context([pillar, brain], [manualEntry]),
      { config: config({ brain: { candidates: [ref("acme", "brain")] }, pillar: { candidates: [ref("acme", "pillar")] } }) },
    );
    expect(manual.model).toBe(brain);
    expect(manual.reason.code).toBe("manual_override");
    expect(manual.state?.manualOverride).toBe("brain");
  });

  it("enforces image and high-complexity constraints", () => {
    const textOnly = model("acme", "text", { reasoning: false });
    const imageReasoning = model("acme", "image", { input: ["text", "image"], reasoning: true });
    const result = routeRequest(
      request(virtual, "implement the production migration with architecture and security", {
        messages: [{ role: "user", content: [{ type: "text", text: "implement the production migration with architecture and security" }, { type: "image", data: "x", mimeType: "image/png" }], timestamp: 0 }],
      }),
      context([textOnly, imageReasoning]),
      { config: config({ pillar: { candidates: [ref("acme", "text")] }, brain: { candidates: [ref("acme", "image")] } }) },
    );
    expect(result.model).toBe(imageReasoning);
    expect(result.thinkingLevel).toBe("medium");
  });

  it("fails closed when all configured candidates are exhausted", () => {
    expect(() => routeRequest(
      request(virtual, "implement it"),
      context([virtual]),
      { config: config({ pillar: { candidates: [ref("ts", "auto")] } }) },
    )).toThrowError(NoEligiblePhysicalModel);
  });
});

function controlEntry(manualOverride: "brain" | "pillar" | "crowd" | null): SessionEntry {
  return {
    type: "custom",
    customType: "pi-tier-scheduler.router-control",
    data: { schemaVersion: 1, manualOverride },
  } as unknown as SessionEntry;
}
function invalidControlEntry(): SessionEntry {
  return {
    type: "custom",
    customType: "pi-tier-scheduler.router-control",
    data: { schemaVersion: 9, manualOverride: "brain" },
  } as unknown as SessionEntry;
}

const STATE_KEYS = [
  "schemaVersion", "turn", "phase", "complexity", "bias", "manualOverride",
  "sticky", "attempts", "tierSwitches", "attempted", "activeTier",
  "activeCandidate", "activeThinking",
];

describe("branch-aware router state (F4.4)", () => {
  const first = model("acme", "first");
  const brain = model("acme", "brain");
  const crowdModel = model("acme", "crowd");
  const cfg = config({
    brain: { candidates: [ref("acme", "brain")] },
    pillar: { candidates: [ref("acme", "first")] },
    crowd: { candidates: [ref("acme", "crowd")] },
  });

  it("returns a plain JSON-serializable state with exactly the schema fields", () => {
    const decision = routeRequest(
      request(virtual, "implement a parser"),
      context([first, brain, crowdModel]),
      { config: cfg },
    );
    const state = decision.state;
    expect(state).toBeDefined();
    expect(Object.keys(state as object).sort()).toEqual([...STATE_KEYS].sort());
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(state).toMatchObject({
      schemaVersion: 1, turn: 1, phase: "implementation", complexity: "standard",
      bias: "medium", manualOverride: null, sticky: true, attempts: 1, tierSwitches: 0,
      activeTier: "pillar", activeCandidate: { provider: "acme", id: "first" }, activeThinking: "medium",
    });
    expect(state?.attempted).toEqual([{ provider: "acme", id: "first", tier: "pillar" }]);
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("example.test");
    expect(serialized).not.toContain("baseUrl");
    expect(serialized).not.toContain("api key");
  });

  it("round-trips state through JSON without changing continuation behavior", () => {
    const initial = routeRequest(request(virtual, "implement a parser"), context([first]), { config: cfg });
    const restored = JSON.parse(JSON.stringify(initial.state)) as NonNullable<typeof initial.state>;
    const continuation = routeRequest(
      request(first, "keep going", { reason: "continuation", state: restored, previous: { model: first, thinkingLevel: "high" } }),
      context([first]),
      { config: cfg },
    );
    expect(continuation.model).toBe(first);
    expect(continuation.reason.code).toBe("sticky_continuation");
    expect(continuation.state).toBe(restored);
  });

  it("recovers an unusable schema version instead of throwing", () => {
    const stale = { schemaVersion: 2, turn: 99, garbage: "payload" } as unknown as RouteRequest["state"];
    const decision = routeRequest(
      request(virtual, "implement the rest", { reason: "continuation", state: stale }),
      context([first, brain, crowdModel]),
      { config: cfg },
    );
    expect(decision.reason.code).toBe("state_recovered");
    expect(decision.model).toBe(first);
    expect(decision.state).toMatchObject({
      turn: 0, attempts: 0, tierSwitches: 0, attempted: [], activeTier: "pillar",
      activeCandidate: { provider: "acme", id: "first" },
    });
    expect(JSON.stringify(decision.state)).not.toContain("payload");
  });

  it("recovers malformed counters, enums, and identities field-by-field", () => {
    const corrupted = {
      schemaVersion: 1, turn: 4, phase: "bogus", complexity: "standard", bias: "medium",
      manualOverride: "brainz", sticky: true, attempts: -3, tierSwitches: 0,
      attempted: [{ provider: "acme", id: "first", tier: "pillar" }, "junk"],
      activeTier: "bogus", activeCandidate: { provider: 5, id: "first" }, activeThinking: "medium",
    } as unknown as RouteRequest["state"];
    const decision = routeRequest(
      request(virtual, "implement the rest", { reason: "continuation", state: corrupted }),
      context([first, brain, crowdModel]),
      { config: cfg },
    );
    expect(decision.reason.code).toBe("state_recovered");
    expect(decision.state).toMatchObject({
      turn: 4, phase: "implementation", manualOverride: null, sticky: true, attempts: 0,
      activeTier: "pillar", activeCandidate: { provider: "acme", id: "first" },
    });
    expect(decision.state?.attempted).toEqual([{ provider: "acme", id: "first", tier: "pillar" }]);
  });

  it("caps an oversized attempted list and blocks sticky on the recovery", () => {
    const oversized = {
      schemaVersion: 1, turn: 1, phase: "implementation", complexity: "standard", bias: "medium",
      manualOverride: null, sticky: true, attempts: 1, tierSwitches: 0,
      attempted: Array.from({ length: 7 }, (_, index) => ({ provider: "acme", id: `m-${index}`, tier: "pillar" as const })),
      activeTier: null, activeCandidate: null, activeThinking: null,
    } as unknown as RouteRequest["state"];
    const decision = routeRequest(
      request(virtual, "implement the rest", {
        reason: "continuation",
        state: oversized,
        previous: { model: first, thinkingLevel: "high" },
      }),
      context([first, brain, crowdModel]),
      { config: cfg },
    );
    expect(decision.reason.code).toBe("state_recovered");
    expect(decision.model).toBe(first);
    expect(decision.state?.attempted).toHaveLength(5);
    expect(decision.state?.attempted[0]).toEqual({ provider: "acme", id: "m-2", tier: "pillar" });
  });

  it("reports invalid bias recovery without structural recovery on a fresh selection", () => {
    const decision = routeRequest(
      request(virtual, "implement it", { thinkingLevel: "ultra" as never }),
      context([first, brain, crowdModel]),
      { config: cfg },
    );
    expect(decision.reason.code).toBe("invalid_bias_recovered");
    expect(decision.state?.bias).toBe("medium");
  });

  it("keeps direct requests state-free while honoring a manual control entry", () => {
    const decision = routeRequest(
      request(virtual, "compact this", { reason: "direct", previous: { model: first, thinkingLevel: "high" } }),
      context([first, brain, crowdModel], [controlEntry("brain")]),
      { config: cfg },
    );
    expect(decision.reason.code).toBe("direct");
    expect(decision.model).toBe(brain);
    expect(decision.state).toBeUndefined();
  });

  it("increments turn and resets retry bookkeeping on user routes and retains them on continuations", () => {
    const initial = routeRequest(request(virtual, "implement a parser"), context([first]), { config: cfg });
    expect(initial.state?.turn).toBe(1);
    expect(initial.state?.attempts).toBe(1);

    const second = routeRequest(
      request(virtual, "implement a parser again", { state: initial.state }),
      context([first]),
      { config: cfg },
    );
    expect(second.state?.turn).toBe(2);
    expect(second.state?.attempts).toBe(1);
    expect(second.state?.attempted).toEqual([{ provider: "acme", id: "first", tier: "pillar" }]);

    const continuation = routeRequest(
      request(first, "keep going", { reason: "continuation", state: second.state, previous: { model: first, thinkingLevel: "high" } }),
      context([first]),
      { config: cfg },
    );
    expect(continuation.state).toBe(second.state);
  });

  it("increments retry counters before dispatch and keeps the turn stable", () => {
    const initial = routeRequest(request(virtual, "implement the change"), context([first, brain]), { config: cfg });
    const failure = {
      model: first,
      message: {
        role: "assistant", content: [], api: first.api, provider: first.provider, model: first.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 } },
        stopReason: "error", errorMessage: "rate limit", timestamp: 0,
      } as never,
    };
    const retry = routeRequest(
      request(first, "implement the change", { reason: "retry", state: initial.state, failed: failure }),
      context([first, brain]),
      { config: cfg },
    );
    expect(retry.reason.code).toBe("retry_tier_fallback");
    expect(retry.state?.turn).toBe(initial.state?.turn);
    expect(retry.state?.attempts).toBe(2);
  });
});

describe("branch control entries (F4.4)", () => {
  const first = model("acme", "first");
  const brain = model("acme", "brain");
  const crowdModel = model("acme", "crowd");
  const cfg = config({
    brain: { candidates: [ref("acme", "brain")] },
    pillar: { candidates: [ref("acme", "first")] },
    crowd: { candidates: [ref("acme", "crowd")] },
  });

  it("lets the latest control entry set and clear the manual override", () => {
    const set = routeRequest(
      request(virtual, "explain this"),
      context([first, brain, crowdModel], [controlEntry("brain")]),
      { config: cfg },
    );
    expect(set.model).toBe(brain);
    expect(set.reason.code).toBe("manual_override");
    expect(set.state?.manualOverride).toBe("brain");

    // A `/ts auto` release entry must clear the override even when the state mirror still holds it.
    const release = routeRequest(
      request(virtual, "explain this", { state: set.state }),
      context([first, brain, crowdModel], [controlEntry("brain"), controlEntry(null)]),
      { config: cfg },
    );
    expect(release.model).toBe(crowdModel);
    expect(release.reason.code).toBe("work_phase");
    expect(release.state?.manualOverride).toBeNull();
  });

  it("recovers an invalid control entry to no override with a stable reason", () => {
    const decision = routeRequest(
      request(virtual, "implement it"),
      context([first, brain, crowdModel], [invalidControlEntry()]),
      { config: cfg },
    );
    expect(decision.reason.code).toBe("invalid_control_recovered");
    expect(decision.model).toBe(first);
    expect(decision.state?.manualOverride).toBeNull();
  });

  it("ignores unknown custom entries", () => {
    const unknown = {
      type: "custom",
      customType: "some-other-extension.entry",
      data: { schemaVersion: 1, manualOverride: "brain" },
    } as unknown as SessionEntry;
    const decision = routeRequest(
      request(virtual, "implement it"),
      context([first, brain, crowdModel], [unknown]),
      { config: cfg },
    );
    expect(decision.reason.code).toBe("work_phase");
    expect(decision.model).toBe(first);
  });

  it("applies the state mirror only when the branch has no control entry", () => {
    const mirrored = {
      schemaVersion: 1, turn: 1, phase: "implementation", complexity: "standard", bias: "medium",
      manualOverride: "brain", sticky: true, attempts: 1, tierSwitches: 0, attempted: [],
      activeTier: "brain", activeCandidate: { provider: "acme", id: "brain" }, activeThinking: "medium",
    } as unknown as RouteRequest["state"];
    const noEntry = routeRequest(
      request(virtual, "implement it", { state: mirrored }),
      context([first, brain, crowdModel]),
      { config: cfg },
    );
    expect(noEntry.model).toBe(brain);
    expect(noEntry.reason.code).toBe("manual_override");
  });

  it("keeps fork control visible per branch without cross-branch leakage", () => {
    const parentBranch = [controlEntry("brain")];
    const childBranch = [controlEntry("brain"), controlEntry("crowd")];

    // Parent control is visible on the forked child; the child's own entry supersedes it there.
    const onChild = routeRequest(
      request(virtual, "implement it"),
      context([first, brain, crowdModel], childBranch),
      { config: cfg },
    );
    expect(onChild.model).toBe(crowdModel);
    expect(onChild.reason.code).toBe("manual_override");

    // Navigating back to the parent branch sees only the parent's override.
    const backOnParent = routeRequest(
      request(virtual, "implement it"),
      context([first, brain, crowdModel], parentBranch),
      { config: cfg },
    );
    expect(backOnParent.model).toBe(brain);

    // Sequential routes never leak state across branches: the same inputs on the
    // parent branch produce the parent's decision again after the child route.
    const again = routeRequest(
      request(virtual, "implement it"),
      context([first, brain, crowdModel], parentBranch),
      { config: cfg },
    );
    expect(again.model).toBe(brain);
  });

  it("retains phase, override, active identity, and counters across a resume fixture", () => {
    const saved = routeRequest(request(virtual, "plan the architecture"), context([first, brain]), { config: cfg });
    expect(saved.state?.phase).toBe("planning");
    expect(saved.state?.activeCandidate).toEqual({ provider: "acme", id: "brain" });

    // Resume/compaction fixture: the branch state is supplied back on a later
    // request; the router must return the same phase, override, identity, counters.
    const resumed = JSON.parse(JSON.stringify(saved.state)) as NonNullable<typeof saved.state>;
    const continuation = routeRequest(
      request(brain, "keep going", { reason: "continuation", state: resumed, previous: { model: brain, thinkingLevel: "high" } }),
      context([first, brain]),
      { config: cfg },
    );
    expect(continuation.state).toBe(resumed);
    expect(continuation.state?.phase).toBe("planning");
    expect(continuation.state?.turn).toBe(saved.state?.turn);
    expect(continuation.state?.attempts).toBe(saved.state?.attempts);
    expect(continuation.state?.activeCandidate).toEqual(saved.state?.activeCandidate);
  });

  it("does not mutate the request state or the branch snapshot", () => {
    const initial = routeRequest(request(virtual, "implement a parser"), context([first]), { config: cfg });
    const stateSnapshot = JSON.stringify(initial.state);
    const branch = [controlEntry("brain")];
    const branchSnapshot = JSON.stringify(branch);
    routeRequest(request(virtual, "implement it", { state: initial.state }), context([first, brain], branch), { config: cfg });
    expect(JSON.stringify(initial.state)).toBe(stateSnapshot);
    expect(JSON.stringify(branch)).toBe(branchSnapshot);
  });

  it("stays deterministic across repeated lifecycle routes", () => {
    const deps = { config: cfg };
    const one = routeRequest(request(virtual, "implement a parser"), context([first]), deps);
    const two = routeRequest(request(virtual, "implement a parser"), context([first]), deps);
    const three = routeRequest(request(virtual, "implement a parser"), context([first]), deps);
    expect(three.reason).toEqual(one.reason);
    expect(two.reason).toEqual(one.reason);
    expect(JSON.stringify(three.state)).toBe(JSON.stringify(one.state));
  });
});

/** Compose the `failed` payload of one retry request (F6.1 §7.1). */
function failure(modelEntry: Model<Api>, stopReason: string, errorMessage?: string) {
  return {
    model: modelEntry,
    message: {
      role: "assistant", content: [], api: modelEntry.api, provider: modelEntry.provider, model: modelEntry.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 } },
      stopReason, errorMessage, timestamp: 0,
    } as never,
  };
}

describe("routeRequest retry legs (F6.1 bounded fallback policy)", () => {
  const first = model("acme", "first");
  const brain = model("acme", "brain");
  const otherProvider = model("beta", "pillar");
  const cfg = config({
    brain: { candidates: [ref("acme", "brain")] },
    pillar: { candidates: [ref("acme", "first"), ref("beta", "pillar")] },
  });

  it("classifies the failure and reports the assessment hint on the decision", () => {
    const initial = routeRequest(request(virtual, "implement the change"), context([first, brain]), { config: cfg });
    const retry = routeRequest(
      request(first, "implement the change", {
        reason: "retry",
        state: initial.state,
        failed: failure(first, "error", "rate limit exceeded"),
      }),
      context([first, brain]),
      { config: cfg },
    );
    expect(retry.reason.retryHint).toBe("transient");
    expect(retry.reason.failedCandidate).toEqual({ provider: "acme", id: "first" });
    expect(retry.reason.attempt).toBe(2);
  });

  it("a context-overflow failure escalates to a larger-capacity candidate in another tier", () => {
    const larger = model("acme", "brain", { contextWindow: 200_000 });
    const wide = config({
      brain: { candidates: [ref("acme", "brain")] },
      pillar: { candidates: [ref("acme", "first")] },
    });
    const initial = routeRequest(request(virtual, "implement the change"), context([first, larger]), { config: wide });
    expect(initial.model).toBe(first);
    const retry = routeRequest(
      request(first, "implement the change", {
        reason: "retry",
        state: initial.state,
        failed: failure(first, "error", "prompt too long for the context window"),
      }),
      context([first, larger]),
      { config: wide },
    );
    expect(retry.model).toBe(larger);
    expect(retry.reason.code).toBe("retry_tier_fallback");
    expect(retry.reason.tierSwitches).toBe(1);
  });

  it("an authentication failure skips the failed provider and routes to the other provider", () => {
    const leg = config({
      pillar: { candidates: [ref("acme", "first"), ref("beta", "pillar")] },
    });
    const initial = routeRequest(request(virtual, "implement the change"), context([first, otherProvider]), { config: leg });
    expect(initial.model).toBe(first);
    const retry = routeRequest(
      request(first, "implement the change", {
        reason: "retry",
        state: initial.state,
        failed: failure(first, "error", "401 unauthorized: invalid api key"),
      }),
      context([first, otherProvider]),
      { config: leg },
    );
    expect(retry.model).toBe(otherProvider);
    expect(retry.reason.code).toBe("retry_same_tier");
  });

  it("stops at the attempt ceiling with the Phase 4 error and a safe failure context", () => {
    const strict = config(
      { pillar: { candidates: [ref("acme", "first"), ref("beta", "pillar")] } },
      { maxAttemptsPerRequest: 1, maxTierSwitches: 2 },
    );
    const initial = routeRequest(request(virtual, "implement the change"), context([first, otherProvider]), { config: strict });
    expect(() => routeRequest(
      request(first, "implement the change", {
        reason: "retry",
        state: initial.state,
        failed: failure(first, "error", "timeout"),
      }),
      context([first, otherProvider]),
      { config: strict },
    )).toThrowError(RouteLimitExceeded);
  });

  it("attaches the JSON-safe failure context to the terminal error", () => {
    const strict = config(
      { pillar: { candidates: [ref("acme", "first")] } },
      { maxAttemptsPerRequest: 1, maxTierSwitches: 2 },
    );
    const initial = routeRequest(request(virtual, "implement the change"), context([first]), { config: strict });
    try {
      routeRequest(
        request(first, "implement the change", {
          reason: "retry",
          state: initial.state,
          failed: failure(first, "error", "timeout with sk-live-999 at /Users/alice"),
        }),
        context([first]),
        { config: strict },
      );
      throw new Error("expected the retry leg to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RouteLimitExceeded);
      const context = inspectRouteFailure(error);
      expect(context).toBeDefined();
      expect(context?.failureClass).toBe("transient");
      expect(context?.requestReason).toBe("retry");
      expect(context?.boundHits).toContain("attempt_limit");
      const serialized = JSON.stringify(context);
      expect(serialized).not.toContain("sk-live-999");
      expect(serialized).not.toContain("/Users");
    }
  });

  it("an aborted assessment is a defensive terminal: no selection, no state budget, mapped error", () => {
    const initial = routeRequest(request(virtual, "implement the change"), context([first, brain]), { config: cfg });
    expect(() => routeRequest(
      request(first, "implement the change", {
        reason: "retry",
        state: initial.state,
        failed: failure(first, "aborted"),
      }),
      context([first, brain]),
      { config: cfg },
    )).toThrowError(expect.objectContaining({
      code: "route_limit_exceeded",
      message: "request aborted; no alternate route",
    }) as never);
    // Nothing consumed the budget: the branch state still holds the initial leg.
    expect(initial.state?.attempts).toBe(1);
  });

  it("an exhausted catalog ends with the no-candidate error and candidate_exhausted", () => {
    const single = config({ pillar: { candidates: [ref("acme", "first")] } });
    const initial = routeRequest(request(virtual, "implement the change"), context([first]), { config: single });
    try {
      routeRequest(
        request(first, "implement the change", {
          reason: "retry",
          state: initial.state,
          failed: failure(first, "error", "timeout"),
        }),
        context([first]),
        { config: single },
      );
      throw new Error("expected the retry leg to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(NoEligiblePhysicalModel);
      expect(inspectRouteFailure(error)?.boundHits).toContain("candidate_exhausted");
    }
  });

  it("a missing failed identity on a retry ends with the no-candidate error", () => {
    const initial = routeRequest(request(virtual, "implement the change"), context([first, brain]), { config: cfg });
    expect(() => routeRequest(
      request(first, "implement the change", {
        reason: "retry",
        state: initial.state,
        failed: undefined,
      }),
      context([first, brain]),
      { config: cfg },
    )).toThrowError(NoEligiblePhysicalModel);
  });

  it("provider failures never leak raw error text into the decision or the state", () => {
    const initial = routeRequest(request(virtual, "implement the change"), context([first, brain, otherProvider]), { config: cfg });
    const retry = routeRequest(
      request(first, "implement the change", {
        reason: "retry",
        state: initial.state,
        failed: failure(first, "error", "quota exceeded for anthropic/claude-secret with sk-live-999"),
      }),
      context([first, brain, otherProvider]),
      { config: cfg },
    );
    const serialized = JSON.stringify({ reason: retry.reason, state: retry.state });
    expect(serialized).not.toContain("claude-secret");
    expect(serialized).not.toContain("sk-live-999");
    expect(serialized).not.toContain("quota exceeded");
    expect(retry.reason.retryHint).toBe("permanent");
  });
});
