import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";

import {
  TS_VIRTUAL_CONTEXT_WINDOW,
  TS_VIRTUAL_MAX_TOKENS,
  TS_VIRTUAL_MODEL_ID,
  TS_VIRTUAL_MODEL_NAME,
  TS_VIRTUAL_PROVIDER,
  TS_VIRTUAL_THINKING_LEVELS,
  VirtualRouteError,
  createVirtualModel,
  createVirtualModelRegistration,
  routePhysicalModel,
} from "../../src/routing";

function fakeModel(
  provider: string,
  id: string,
  overrides: Partial<Model<Api>> = {},
): Model<Api> {
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

function fakeContext(
  available: readonly Model<Api>[],
  find: (provider: string, id: string) => Model<Api> | undefined = (provider, id) =>
    available.find((model) => model.provider === provider && model.id === id),
): ExtensionContext {
  return {
    modelRegistry: { getAvailable: () => [...available], find },
  } as unknown as ExtensionContext;
}

function fakeRequest(
  model: Model<Api>,
  overrides: Partial<ModelRouteRequest> = {},
): ModelRouteRequest {
  return {
    model,
    thinkingLevel: "medium",
    reason: "user",
    messages: [],
    ...overrides,
  };
}

describe("ts/auto virtual model definition", () => {
  it("exposes the fixed selectable envelope and delegates route calls", async () => {
    const physical = fakeModel("acme", "primary");
    const route = vi.fn(() => ({ model: physical, thinkingLevel: "medium" as const }));
    const model = createVirtualModel(route);

    expect(model).toMatchObject({
      provider: TS_VIRTUAL_PROVIDER,
      id: TS_VIRTUAL_MODEL_ID,
      name: TS_VIRTUAL_MODEL_NAME,
      thinkingLevels: [...TS_VIRTUAL_THINKING_LEVELS],
      contextWindow: TS_VIRTUAL_CONTEXT_WINDOW,
      maxTokens: TS_VIRTUAL_MAX_TOKENS,
      input: ["text", "image"],
    });
    expect(model.contextWindow).toBeGreaterThan(0);
    expect(model.maxTokens).toBeGreaterThan(0);

    const request = fakeRequest(model as unknown as Model<Api>);
    const context = fakeContext([physical]);
    expect(model.route(request, context)).toEqual({
      model: physical,
      thinkingLevel: "medium",
    });
    expect(route).toHaveBeenCalledWith(request, context);
  });
});

describe("virtual model registration lifecycle", () => {
  it("registers once, unregisters once, and can be registered again", () => {
    const registerVirtualModel = vi.fn();
    const unregisterVirtualModel = vi.fn();
    const api = { registerVirtualModel, unregisterVirtualModel } as unknown as ExtensionAPI;
    const route = vi.fn(() => ({ model: fakeModel("acme", "one"), thinkingLevel: "low" as const }));
    const registration = createVirtualModelRegistration(api, route);

    registration.ensureRegistered();
    registration.ensureRegistered();
    expect(registerVirtualModel).toHaveBeenCalledTimes(1);
    expect(registerVirtualModel).toHaveBeenCalledWith(expect.objectContaining({ provider: "ts", id: "auto" }));

    registration.unregister();
    registration.unregister();
    expect(unregisterVirtualModel).toHaveBeenCalledTimes(1);
    expect(unregisterVirtualModel).toHaveBeenCalledWith("ts", "auto");

    registration.ensureRegistered();
    expect(registerVirtualModel).toHaveBeenCalledTimes(2);
  });
});

describe("minimal physical route", () => {
  it("prefers an available physical previous model and clamps its thinking level", () => {
    const first = fakeModel("acme", "first");
    const previous = fakeModel("acme", "previous", {
      thinkingLevelMap: { medium: null, high: null, xhigh: null, max: null },
    });
    const context = fakeContext([first, previous]);

    const result = routePhysicalModel(
      fakeRequest(fakeModel("ts", "auto"), { previous: { model: previous }, thinkingLevel: "high" }),
      context,
    );

    expect(result).toEqual({ model: previous, thinkingLevel: "low" });
  });

  it("falls back to the first available physical chat model", () => {
    const virtual = fakeModel("ts", "other", { api: "pi-virtual" });
    const image = fakeModel("acme", "image", { type: "image" } as unknown as Partial<Model<Api>>);
    const physical = fakeModel("acme", "physical");

    const result = routePhysicalModel(
      fakeRequest(fakeModel("ts", "auto")),
      fakeContext([virtual, image, physical]),
    );

    expect(result.model).toBe(physical);
    expect(result.thinkingLevel).toBe("medium");
  });

  it("rejects unavailable, virtual, mismatched, or absent physical choices without leaking details", () => {
    const requested = fakeModel("acme", "requested");
    const virtual = fakeModel("ts", "virtual", { api: "pi-virtual" });
    const mismatch = fakeModel("other", "different");
    const context = fakeContext([virtual], () => mismatch);

    expect(() =>
      routePhysicalModel(
        fakeRequest(fakeModel("ts", "auto"), { previous: { model: requested } }),
        context,
      ),
    ).toThrowError(VirtualRouteError);
    try {
      routePhysicalModel(fakeRequest(fakeModel("ts", "auto")), context);
    } catch (error) {
      expect(error).toMatchObject({
        code: "no_eligible_physical_model",
        message: "No eligible physical model is available for ts/auto",
      });
      expect(String(error)).not.toContain("requested");
    }
  });

  it("does not call credential or provider APIs", () => {
    const physical = fakeModel("acme", "physical");
    const getAvailable = vi.fn(() => [physical]);
    const find = vi.fn(() => physical);
    const context = { modelRegistry: { getAvailable, find } } as unknown as ExtensionContext;

    routePhysicalModel(fakeRequest(fakeModel("ts", "auto")), context);

    expect(getAvailable).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledTimes(0);
  });
});
