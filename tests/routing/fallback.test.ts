import { describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRouteReason } from "@earendil-works/pi-coding-agent";

import { classifyFailure } from "../../src/routing/failure";
import {
  chooseFallback,
  fallbackErrors,
  failureContextOf,
  inspectRouteFailure,
  type FallbackRequest,
  type FallbackSelection,
} from "../../src/routing/fallback";
import { resolveCatalog, type CatalogRegistry } from "../../src/catalog";
import type { EffectiveConfig, TierName } from "../../src/config/types";
import { makeRecoveredState } from "../../src/routing/state";
import type { AttemptedCandidate, RouterState } from "../../src/routing/types";

/**
 * Bounded fallback policy lock (06-fallback-diagnostics.md §7.1 hooks 3–6):
 * class-specific search order, attempted-set uniqueness across repeated
 * retries, exact bound stops at 1–5 attempts and 0–3 tier switches with the
 * code ceiling intact, aborted as a defensive terminal, and JSON-safe
 * failure contexts. Pure fake catalogs only — no providers, no network.
 */

function model(provider: string, id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id,
    name: `${provider}/${id}`,
    api: "openai-completions",
    provider,
    baseUrl: "https://example.test",
    input: ["text"],
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    reasoning: true,
    contextWindow: 100_000,
    maxTokens: 8_000,
    ...overrides,
  };
}

function config(overrides: { tiers?: Partial<EffectiveConfig["tiers"]>; retry?: Partial<EffectiveConfig["retry"]> } = {}): EffectiveConfig {
  return {
    schemaVersion: 1,
    tiers: {
      brain: { candidates: [] },
      pillar: { candidates: [] },
      crowd: { candidates: [] },
      ...overrides.tiers,
    },
    policy: { defaultBias: "medium", sticky: true },
    retry: { maxAttemptsPerRequest: 3, maxTierSwitches: 2, ...overrides.retry },
    provenance: {},
  };
}

function registryOf(models: readonly Model<Api>[]): CatalogRegistry {
  return {
    getAvailable: () => [...models],
    find: (provider: string, id: string) =>
      models.find((entry) => entry.provider === provider && entry.id === id),
  };
}

const LARGE = 200_000;

function request(
  models: readonly Model<Api>[],
  cfg: EffectiveConfig,
  failed: AttemptedCandidate,
  errorMessage: string,
  options: { state?: RouterState; requestedThinking?: Model<Api>["reasoning"] } = {},
): FallbackRequest {
  const assessment = classifyFailure({ stopReason: "error", errorMessage });
  const catalog = resolveCatalog(cfg, registryOf(models));
  const state = options.state ?? {
    ...makeRecoveredState("medium"),
    attempts: 1,
    tierSwitches: 0,
    attempted: [],
    activeTier: failed.tier,
  };
  return {
    requestReason: "retry" as ModelRouteReason,
    failed,
    assessment,
    state,
    catalog,
    constraints: {},
    config: cfg,
    requestedThinking: "medium",
  };
}

function failedOf(provider: string, id: string, tier: TierName): AttemptedCandidate {
  return { provider, id, tier };
}

/** Drive one retry leg: classify, select, and hand back the selection. */
function retryLeg(
  models: readonly Model<Api>[],
  cfg: EffectiveConfig,
  failed: AttemptedCandidate,
  errorMessage: string,
  state: RouterState | undefined,
): FallbackSelection {
  return chooseFallback(request(models, cfg, failed, errorMessage, { state }));
}

describe("chooseFallback — class-specific search order (hook 3)", () => {
  it("a transient failure first visits an untried same-provider candidate", () => {
    const sameProvider = model("acme", "pillar-a");
    const sameProviderB = model("acme", "pillar-b");
    const otherProvider = model("beta", "pillar-c");
    const cfg = config({
      tiers: { pillar: { candidates: [{ provider: "acme", id: "pillar-a" }, { provider: "acme", id: "pillar-b" }, { provider: "beta", id: "pillar-c" }] } },
    });
    const selection = retryLeg(
      [sameProvider, sameProviderB, otherProvider],
      cfg,
      failedOf("acme", "pillar-a", "pillar"),
      "timeout while streaming",
      undefined,
    );
    expect(selection.selectedCandidate).toEqual({ provider: "acme", id: "pillar-b" });
    expect(selection.selectedTier).toBe("pillar");
    expect(selection.path).toEqual(["same_provider"]);
    expect(selection.terminalCode).toBeUndefined();
  });

  it("an authentication failure skips the failed provider and takes another provider in the same tier", () => {
    const failedModel = model("acme", "pillar-a");
    const sibling = model("acme", "pillar-b");
    const otherProvider = model("beta", "pillar-c");
    const cfg = config({
      tiers: { pillar: { candidates: [{ provider: "acme", id: "pillar-a" }, { provider: "acme", id: "pillar-b" }, { provider: "beta", id: "pillar-c" }] } },
    });
    const selection = retryLeg(
      [failedModel, sibling, otherProvider],
      cfg,
      failedOf("acme", "pillar-a", "pillar"),
      "unauthorized: invalid api key",
      undefined,
    );
    expect(selection.selectedCandidate).toEqual({ provider: "beta", id: "pillar-c" });
    expect(selection.boundHits).toContain("provider_skipped");
  });

  it("a quota failure degrades to adjacent tiers while always skipping the failed provider", () => {
    const failedModel = model("acme", "brain-a", { contextWindow: LARGE });
    const brainSibling = model("acme", "brain-b");
    const otherBrain = model("beta", "brain-c");
    const pillar = model("gamma", "pillar-a");
    const cfg = config({
      tiers: {
        brain: { candidates: [{ provider: "acme", id: "brain-a" }, { provider: "acme", id: "brain-b" }, { provider: "beta", id: "brain-c" }] },
        pillar: { candidates: [{ provider: "gamma", id: "pillar-a" }] },
      },
    });
    const selection = retryLeg(
      [failedModel, brainSibling, otherBrain, pillar],
      cfg,
      failedOf("acme", "brain-a", "brain"),
      "quota exceeded for this billing account",
      undefined,
    );
    // brain-b is the same provider (skipped); brain-c is another provider in the failed tier.
    expect(selection.selectedCandidate).toEqual({ provider: "beta", id: "brain-c" });
    expect(selection.selectedTier).toBe("brain");
  });

  it("a context-overflow failure never selects a candidate with insufficient capacity", () => {
    const failedModel = model("acme", "pillar-a", { contextWindow: 100_000 });
    const smallSibling = model("acme", "pillar-b", { contextWindow: 100_000 });
    const biggerSibling = model("acme", "pillar-c", { contextWindow: LARGE });
    const cfg = config({
      tiers: { pillar: { candidates: [{ provider: "acme", id: "pillar-a" }, { provider: "acme", id: "pillar-b" }, { provider: "acme", id: "pillar-c" }] } },
    });
    const selection = retryLeg(
      [failedModel, smallSibling, biggerSibling],
      cfg,
      failedOf("acme", "pillar-a", "pillar"),
      "prompt too long: context length exceeded",
      undefined,
    );
    expect(selection.selectedCandidate).toEqual({ provider: "acme", id: "pillar-c" });
    expect(selection.path).toEqual(["same_provider"]);
  });

  it("an output-limit failure prefers strictly larger output envelopes", () => {
    const failedModel = model("acme", "pillar-a", { maxTokens: 4_000 });
    const equalOutput = model("acme", "pillar-b", { maxTokens: 4_000 });
    const biggerOutput = model("acme", "pillar-c", { maxTokens: 16_000 });
    const cfg = config({
      tiers: { pillar: { candidates: [{ provider: "acme", id: "pillar-a" }, { provider: "acme", id: "pillar-b" }, { provider: "acme", id: "pillar-c" }] } },
    });
    const selection = retryLeg(
      [failedModel, equalOutput, biggerOutput],
      cfg,
      failedOf("acme", "pillar-a", "pillar"),
      "response too long: hit the max output tokens",
      { ...makeRecoveredState("medium"), attempts: 1, tierSwitches: 0, attempted: [] },
    );
    expect(selection.selectedCandidate).toEqual({ provider: "acme", id: "pillar-c" });
  });

  it("preserves authored candidate order inside every tier", () => {
    const first = model("acme", "pillar-a");
    const second = model("beta", "pillar-b");
    const third = model("gamma", "pillar-c");
    const cfg = config({
      tiers: { pillar: { candidates: [{ provider: "acme", id: "pillar-a" }, { provider: "beta", id: "pillar-b" }, { provider: "gamma", id: "pillar-c" }] } },
    });
    const leg1 = retryLeg([first, second, third], cfg, failedOf("acme", "pillar-a", "pillar"), "timeout", undefined);
    expect(leg1.selectedCandidate).toEqual({ provider: "beta", id: "pillar-b" });

    // Second failure of pillar-b walks to the next authored candidate, not back.
    const stateAfterLeg1: RouterState = {
      ...makeRecoveredState("medium"),
      attempts: 2,
      tierSwitches: 0,
      attempted: leg1.attempted,
    };
    const leg2 = retryLeg([first, second, third], cfg, failedOf("beta", "pillar-b", "pillar"), "timeout", stateAfterLeg1);
    expect(leg2.selectedCandidate).toEqual({ provider: "gamma", id: "pillar-c" });
  });

  it("crosses tiers with escalate/degrade stages and counts the switch", () => {
    const failedModel = model("acme", "pillar-a");
    const brainModel = model("acme", "brain-a");
    const cfg = config({
      tiers: {
        brain: { candidates: [{ provider: "acme", id: "brain-a" }] },
        pillar: { candidates: [{ provider: "acme", id: "pillar-a" }] },
      },
    });
    const selection = retryLeg(
      [failedModel, brainModel],
      cfg,
      failedOf("acme", "pillar-a", "pillar"),
      "timeout",
      undefined,
    );
    expect(selection.selectedCandidate).toEqual({ provider: "acme", id: "brain-a" });
    expect(selection.selectedTier).toBe("brain");
    expect(selection.path).toEqual(["escalate_tier"]);
    expect(selection.tierSwitches).toBe(1);
  });

  it("an invalid-request failure walks untried candidates without provider preference", () => {
    const failedModel = model("acme", "pillar-a");
    const sameProvider = model("acme", "pillar-b");
    const otherProvider = model("beta", "pillar-c");
    const cfg = config({
      tiers: { pillar: { candidates: [{ provider: "acme", id: "pillar-a" }, { provider: "beta", id: "pillar-c" }, { provider: "acme", id: "pillar-b" }] } },
    });
    const selection = retryLeg(
      [failedModel, otherProvider, sameProvider],
      cfg,
      failedOf("acme", "pillar-a", "pillar"),
      "400 bad request: unsupported parameter",
      undefined,
    );
    // No same-provider preference: authored order decides among the untried.
    expect(selection.selectedCandidate).toEqual({ provider: "beta", id: "pillar-c" });
    expect(selection.path).toEqual(["same_tier"]);
  });

  it("an unknown failure takes one bounded same-provider alternate first", () => {
    const failedModel = model("acme", "pillar-a");
    const sibling = model("acme", "pillar-b");
    const cfg = config({
      tiers: { pillar: { candidates: [{ provider: "acme", id: "pillar-a" }, { provider: "acme", id: "pillar-b" }] } },
    });
    const selection = retryLeg(
      [failedModel, sibling],
      cfg,
      failedOf("acme", "pillar-a", "pillar"),
      "provider closed the stream",
      undefined,
    );
    expect(selection.selectedCandidate).toEqual({ provider: "acme", id: "pillar-b" });
  });
});

describe("chooseFallback — uniqueness and bounds (hooks 4–5)", () => {
  const cfg = config({
    tiers: {
      brain: { candidates: [{ provider: "acme", id: "brain-1" }] },
      pillar: { candidates: [{ provider: "acme", id: "pillar-1" }, { provider: "beta", id: "pillar-2" }] },
      crowd: { candidates: [{ provider: "acme", id: "crowd-1" }] },
    },
  });
  const models = [
    model("acme", "pillar-1"),
    model("beta", "pillar-2"),
    model("acme", "brain-1"),
    model("acme", "crowd-1"),
  ];

  it("never returns the failed exact candidate and keeps the attempted set unique across repeated retries", () => {
    let state: RouterState | undefined = undefined;
    const seen: string[] = [];
    // maxAttempts=5, maxTierSwitches=3: walk the whole catalog through failures.
    const walk = config({
      tiers: cfg.tiers,
      retry: { maxAttemptsPerRequest: 5, maxTierSwitches: 3 },
    });
    for (let leg = 0; leg < 4; leg += 1) {
      const lastFailed = seen.length === 0 ? failedOf("acme", "pillar-1", "pillar") : failedOf(seen[seen.length - 1].split("\0")[0], seen[seen.length - 1].split("\0")[1], state?.activeTier ?? "pillar");
      const selection = retryLeg(models, walk, lastFailed, "timeout", state);
      if (selection.terminalCode !== undefined) break;
      expect(selection.selectedCandidate).toBeDefined();
      const key = `${selection.selectedCandidate?.provider}\0${selection.selectedCandidate?.id}`;
      expect(seen).not.toContain(key);
      seen.push(key);
      expect(new Set(selection.attempted.map((entry) => `${entry.provider}\0${entry.id}`)).size)
        .toBe(selection.attempted.length);
      state = {
        ...makeRecoveredState("medium"),
        attempts: selection.attempts,
        tierSwitches: selection.tierSwitches,
        attempted: selection.attempted,
        activeTier: selection.selectedTier,
      };
    }
    expect(seen.length).toBeGreaterThanOrEqual(3);
  });

  it.each([1, 2, 3, 4, 5] as const)(
    "stops exactly at maxAttemptsPerRequest=%d",
    (maxAttempts) => {
      const bounded = config({
        tiers: { pillar: { candidates: [{ provider: "acme", id: "pillar-1" }, { provider: "acme", id: "pillar-2" }] } },
        retry: { maxAttemptsPerRequest: maxAttempts, maxTierSwitches: 3 },
      });
      const pool = [model("acme", "pillar-1"), model("acme", "pillar-2")];
      // Spent attempts at the configured limit: the next retry must stop
      // before selecting another candidate (§3.2 step 2).
      const spent: RouterState = {
        ...makeRecoveredState("medium"),
        attempts: maxAttempts,
        tierSwitches: 0,
        attempted: [{ provider: "acme", id: "pillar-1", tier: "pillar" }],
        activeTier: "pillar",
      };
      const stopped = retryLeg(pool, bounded, failedOf("acme", "pillar-1", "pillar"), "timeout", spent);
      expect(stopped.terminalCode).toBe("route_limit_exceeded");
      expect(stopped.boundHits).toContain("attempt_limit");
      expect(stopped.selected).toBeUndefined();

      // One below the limit: the leg selects and consumes exactly the limit.
      if (maxAttempts > 1) {
        const oneLeft: RouterState = { ...spent, attempts: maxAttempts - 1 };
        const selection = retryLeg(pool, bounded, failedOf("acme", "pillar-1", "pillar"), "timeout", oneLeft);
        expect(selection.terminalCode).toBeUndefined();
        expect(selection.attempts).toBe(maxAttempts);
        expect(selection.selectedCandidate).toEqual({ provider: "acme", id: "pillar-2" });
      }
    },
  );

  it("a value above the Phase 2 contract cannot raise the code ceiling", () => {
    const malformed = config({
      tiers: { pillar: { candidates: [{ provider: "acme", id: "pillar-1" }, { provider: "acme", id: "pillar-2" }] } },
      retry: { maxAttemptsPerRequest: 99, maxTierSwitches: 99 },
    });
    const pool = [model("acme", "pillar-1"), model("acme", "pillar-2")];
    // State already at the code ceiling (5): even 99 configured must stop.
    const state: RouterState = {
      ...makeRecoveredState("medium"),
      attempts: 5,
      tierSwitches: 0,
      attempted: [{ provider: "acme", id: "pillar-1", tier: "pillar" }],
      activeTier: "pillar",
    };
    const selection = retryLeg(pool, malformed, failedOf("acme", "pillar-1", "pillar"), "timeout", state);
    expect(selection.terminalCode).toBe("route_limit_exceeded");
    expect(selection.boundHits).toContain("attempt_limit");
  });

  it.each([0, 1, 2, 3] as const)(
    "stops cross-tier search at maxTierSwitches=%d",
    (maxTierSwitches) => {
      const bounded = config({
        tiers: {
          brain: { candidates: [{ provider: "acme", id: "brain-1" }] },
          pillar: { candidates: [{ provider: "acme", id: "pillar-1" }] },
          crowd: { candidates: [{ provider: "acme", id: "crowd-1" }] },
        },
        retry: { maxAttemptsPerRequest: 5, maxTierSwitches: maxTierSwitches },
      });
      const pool = [model("acme", "pillar-1"), model("acme", "brain-1"), model("acme", "crowd-1")];
      // pillar-1 failed; only cross-tier alternatives remain, and the switch
      // budget is already spent: no cross-tier visit may happen (§3.2 step 7).
      const spent: RouterState = {
        ...makeRecoveredState("medium"),
        attempts: 1,
        tierSwitches: maxTierSwitches,
        attempted: [{ provider: "acme", id: "pillar-1", tier: "pillar" }],
        activeTier: "pillar",
      };
      const stopped = retryLeg(pool, bounded, failedOf("acme", "pillar-1", "pillar"), "timeout", spent);
      expect(stopped.terminalCode).toBe("route_limit_exceeded");
      expect(stopped.boundHits).toContain("tier_switch_limit");
      expect(stopped.selected).toBeUndefined();

      // One switch left in the budget: the leg may cross exactly one tier.
      if (maxTierSwitches > 0) {
        const oneLeft: RouterState = { ...spent, tierSwitches: maxTierSwitches - 1 };
        const selection = retryLeg(pool, bounded, failedOf("acme", "pillar-1", "pillar"), "timeout", oneLeft);
        expect(selection.terminalCode).toBeUndefined();
        expect(selection.selectedCandidate).toBeDefined();
        expect(selection.tierSwitches).toBe(maxTierSwitches);
      }
    },
  );
});

describe("chooseFallback — terminal outcomes and safe contexts (hook 6)", () => {
  it("an aborted assessment is not a selection outcome: the adapter handles it before chooseFallback", () => {
    // The classifier answers aborted; the policy module is never called with
    // it (06 §3.3). Guard the contract from the caller's side: no chooseFallback
    // code path may accept an abort assessment as a retryable search.
    const assessment = classifyFailure({ stopReason: "aborted" });
    expect(assessment.failureClass).toBe("aborted");
    expect(assessment.retryable).toBe(false);
  });

  it("exhausted catalogs produce candidate_exhausted with the no-candidate terminal code", () => {
    const failedModel = model("acme", "pillar-1");
    const cfg = config({ tiers: { pillar: { candidates: [{ provider: "acme", id: "pillar-1" }] } } });
    const selection = retryLeg([failedModel], cfg, failedOf("acme", "pillar-1", "pillar"), "timeout", undefined);
    expect(selection.terminalCode).toBe("no_eligible_physical_model");
    expect(selection.boundHits).toContain("candidate_exhausted");
    expect(selection.selected).toBeUndefined();
  });

  it("the failure context is JSON-safe: codes, identities, and counters only", () => {
    const failedModel = model("acme", "pillar-1");
    const cfg = config({ tiers: { pillar: { candidates: [{ provider: "acme", id: "pillar-1" }, { provider: "acme", id: "pillar-2" }] } } });
    const input = request([failedModel, model("acme", "pillar-2")], cfg, failedOf("acme", "pillar-1", "pillar"), "timeout: sk-live-999 at /Users/alice");
    const selection = chooseFallback(input);
    const context = failureContextOf(input, selection);
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain("sk-live-999");
    expect(serialized).not.toContain("/Users");
    expect(serialized).not.toContain("timeout");
    expect(context.requestReason).toBe("retry");
    expect(context.failureClass).toBe("transient");
    expect(context.attempts).toBe(selection.attempts);
  });

  it("fallback errors carry the identically-coded Phase 4 code and message with the context", () => {
    const failedModel = model("acme", "pillar-1");
    const cfg = config({ tiers: { pillar: { candidates: [{ provider: "acme", id: "pillar-1" }] } } });
    const input = request([failedModel], cfg, failedOf("acme", "pillar-1", "pillar"), "timeout");
    const selection = chooseFallback(input);
    expect(selection.terminalCode).toBe("no_eligible_physical_model");

    const error = fallbackErrors.noCandidate(failureContextOf(input, selection));
    expect(error.code).toBe("no_eligible_physical_model");
    expect(error.message).toBe("No eligible physical model is available for ts/auto");
    expect(inspectRouteFailure(error)).toBeDefined();
    expect(inspectRouteFailure(error)?.boundHits).toContain("candidate_exhausted");
    expect(inspectRouteFailure(new Error("foreign"))).toBeUndefined();

    const limitError = fallbackErrors.limitExceeded({
      requestReason: "retry",
      attempted: [],
      attempts: 3,
      maxAttempts: 3,
      tierSwitches: 0,
      maxTierSwitches: 3,
      boundHits: ["attempt_limit"],
    });
    expect(limitError.code).toBe("route_limit_exceeded");
    expect(limitError.message).toBe("The configured routing retry limit was reached");
  });

  it("deduplicates path stages and caps the recorded arrays", () => {
    // Multiple capability rejections across visited segments dedupe to one
    // capability_rejected stage; arrays stay within their documented caps.
    const failedModel = model("acme", "brain-1", { contextWindow: LARGE });
    const smallBrain = model("acme", "brain-2", { contextWindow: 100_000 });
    const smallPillar = model("acme", "pillar-1", { contextWindow: 100_000 });
    const cfg = config({
      tiers: {
        brain: { candidates: [{ provider: "acme", id: "brain-1" }, { provider: "acme", id: "brain-2" }] },
        pillar: { candidates: [{ provider: "acme", id: "pillar-1" }] },
      },
    });
    // A capacity failure where every remaining candidate is too small.
    const selection = retryLeg(
      [failedModel, smallBrain, smallPillar],
      cfg,
      failedOf("acme", "brain-1", "brain"),
      "prompt too long",
      undefined,
    );
    expect(selection.terminalCode).toBe("no_eligible_physical_model");
    expect(selection.path.length).toBeLessThanOrEqual(8);
    expect(new Set(selection.path).size).toBe(selection.path.length);
    expect(selection.boundHits.length).toBeLessThanOrEqual(4);
  });
});
