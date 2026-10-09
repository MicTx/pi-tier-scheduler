import { describe, expect, it } from "vitest";
import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  classifyRetryHint,
  NoEligiblePhysicalModel,
  RouteLimitExceeded,
  routeRequest,
  type EffectiveConfig,
  type RouteRequest,
} from "../../src/routing";

function model(provider: string, id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id, name: `${provider}/${id}`, api: "openai-completions", provider,
    baseUrl: "https://example.test", input: ["text"],
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, reasoning: true,
    contextWindow: 100_000, maxTokens: 8_000, ...overrides,
  };
}
function ref(provider: string, id: string) { return { provider, id }; }
function config(overrides: Partial<EffectiveConfig["tiers"]> = {}, retry = { maxAttemptsPerRequest: 3, maxTierSwitches: 2 }): EffectiveConfig {
  return {
    schemaVersion: 1,
    tiers: { brain: { candidates: [] }, pillar: { candidates: [] }, crowd: { candidates: [] }, ...overrides },
    policy: { defaultBias: "medium", sticky: true }, retry, provenance: {},
  };
}
function context(available: readonly Model<Api>[]): ExtensionContext {
  return { modelRegistry: {
    getAvailable: () => [...available],
    find: (provider: string, id: string) => available.find((entry) => entry.provider === provider && entry.id === id),
  }, sessionManager: { getBranch: () => [] } } as unknown as ExtensionContext;
}
function request(entry: Model<Api>, reason: RouteRequest["reason"], state?: RouteRequest["state"], failed?: RouteRequest["failed"]): RouteRequest {
  const message: Message = { role: "user", content: "implement the change", timestamp: 0 };
  return { model: model("ts", "auto", { api: "pi-virtual" }), thinkingLevel: "medium", reason, messages: [message], state, failed, ...(reason === "continuation" ? { previous: { model: entry, thinkingLevel: "high" as const } } : {}) };
}
function failure(modelEntry: Model<Api>, text: string): NonNullable<RouteRequest["failed"]> {
  return {
    model: modelEntry,
    message: {
      role: "assistant", content: [], api: modelEntry.api, provider: modelEntry.provider, model: modelEntry.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "error", errorMessage: text, timestamp: 0,
    } as AssistantMessage,
  };
}

const virtual = model("ts", "auto", { api: "pi-virtual" });

describe("retry contracts", () => {
  it("classifies stable hints and never returns provider text", () => {
    expect(classifyRetryHint(failure(virtual, "context_length_exceeded: private-secret" as string).message)).toBe("context_overflow");
    expect(classifyRetryHint(failure(virtual, "429 service temporarily unavailable").message)).toBe("transient");
    expect(classifyRetryHint(failure(virtual, "permission denied").message)).toBe("permanent");
    expect(classifyRetryHint(failure(virtual, "private-secret unknown failure").message)).toBe("unknown");
  });

  it("reuses a sticky physical model and clamps its thinking level", () => {
    const first = model("acme", "first", { thinkingLevelMap: { high: null } });
    const initial = routeRequest(
      request(virtual, "user"), context([first]),
      { config: config({ pillar: { candidates: [ref("acme", "first")] } }) },
    );
    const continuation = routeRequest(
      request(first, "continuation", initial.state), context([first]),
      { config: config({ pillar: { candidates: [ref("acme", "first")] } }) },
    );
    expect(continuation.model).toBe(first);
    expect(continuation.reason.code).toBe("sticky_continuation");
    expect(continuation.thinkingLevel).toBe("medium");
    expect(continuation.state).toBe(initial.state);
  });

  it("walks same-tier candidates and records bounded retry state", () => {
    const first = model("acme", "first");
    const second = model("acme", "second");
    const cfg = config({ pillar: { candidates: [ref("acme", "first"), ref("acme", "second")] } });
    const initial = routeRequest(request(virtual, "user"), context([first, second]), { config: cfg });
    const retry = routeRequest(
      { ...request(first, "retry", initial.state, failure(first, "rate limit")), failed: failure(first, "rate limit") },
      context([first, second]), { config: cfg },
    );
    expect(retry.model).toBe(second);
    expect(retry.reason.code).toBe("retry_same_tier");
    expect(retry.reason.retryHint).toBe("transient");
    expect(retry.state?.attempts).toBe(2);
    expect(JSON.stringify(retry.reason)).not.toContain("rate limit");
  });

  it("stops before a further dispatch at the attempt limit", () => {
    const first = model("acme", "first");
    const cfg = config({ pillar: { candidates: [ref("acme", "first")] } }, { maxAttemptsPerRequest: 1, maxTierSwitches: 0 });
    const initial = routeRequest(request(virtual, "user"), context([first]), { config: cfg });
    expect(() => routeRequest(
      { ...request(first, "retry", initial.state, failure(first, "timeout")), failed: failure(first, "timeout") },
      context([first]), { config: cfg },
    )).toThrowError(RouteLimitExceeded);
  });

  it("stops with a stable route-limit error when a tier switch is disallowed", () => {
    const first = model("acme", "first");
    const cfg = config({ pillar: { candidates: [ref("acme", "first")] } }, { maxAttemptsPerRequest: 3, maxTierSwitches: 0 });
    const initial = routeRequest(request(virtual, "user"), context([first]), { config: cfg });
    expect(() => routeRequest(
      { ...request(first, "retry", initial.state, failure(first, "unknown")), failed: failure(first, "unknown") },
      context([first]), { config: cfg },
    )).toThrowError(RouteLimitExceeded);
  });
});
