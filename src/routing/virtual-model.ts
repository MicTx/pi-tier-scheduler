import { isModelType, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";

import { clampRequestedThinking } from "../catalog";
import { PI_VIRTUAL_API } from "../catalog/constants";
import type { EffectiveConfig } from "../config/types";
import { routeRequestAsModelRoute } from "./router";
import type { RouterState } from "./types";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionVirtualModel,
  ModelRoute,
  ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";

export const TS_VIRTUAL_PROVIDER = "ts";
export const TS_VIRTUAL_MODEL_ID = "auto";
export const TS_VIRTUAL_MODEL_NAME = "Auto";
export const TS_VIRTUAL_CONTEXT_WINDOW = 128_000;
export const TS_VIRTUAL_MAX_TOKENS = 16_384;
export const TS_VIRTUAL_THINKING_LEVELS: readonly ModelThinkingLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
export { PI_VIRTUAL_API };

export type AutoModelRoute<TState = unknown> = (
  request: ModelRouteRequest<TState>,
  ctx: ExtensionContext,
) => ModelRoute<TState> | Promise<ModelRoute<TState>>;

/** Build the SDK adapter for the pure F4.2 router. Config is supplied by session runtime code. */
export function createDeterministicRoute(config: EffectiveConfig): AutoModelRoute<RouterState> {
  return (request, ctx) => routeRequestAsModelRoute(request, ctx, { config });
}

export function createVirtualModel<TState>(
  route: AutoModelRoute<TState>,
): ExtensionVirtualModel<TState> {
  return {
    provider: TS_VIRTUAL_PROVIDER,
    id: TS_VIRTUAL_MODEL_ID,
    name: TS_VIRTUAL_MODEL_NAME,
    thinkingLevels: [...TS_VIRTUAL_THINKING_LEVELS],
    contextWindow: TS_VIRTUAL_CONTEXT_WINDOW,
    maxTokens: TS_VIRTUAL_MAX_TOKENS,
    input: ["text", "image"],
    route,
  };
}

type VirtualModelRegistration = {
  ensureRegistered(): void;
  unregister(): void;
};

export function createVirtualModelRegistration<TState>(
  api: Pick<ExtensionAPI, "registerVirtualModel" | "unregisterVirtualModel">,
  route: AutoModelRoute<TState>,
): VirtualModelRegistration {
  let active = false;
  const definition = createVirtualModel(route);

  return {
    ensureRegistered(): void {
      if (active) return;
      api.registerVirtualModel(definition);
      active = true;
    },
    unregister(): void {
      if (!active) return;
      api.unregisterVirtualModel(TS_VIRTUAL_PROVIDER, TS_VIRTUAL_MODEL_ID);
      active = false;
    },
  };
}

export class VirtualRouteError extends Error {
  readonly code = "no_eligible_physical_model" as const;

  constructor() {
    super("No eligible physical model is available for ts/auto");
    this.name = "VirtualRouteError";
  }
}

function isPhysicalChatModel(model: Model<Api>): boolean {
  return model.api !== PI_VIRTUAL_API && isModelType(model, "chat");
}

function sameIdentity(left: Model<Api>, right: Model<Api>): boolean {
  return left.provider === right.provider && left.id === right.id;
}

function selectAvailablePhysical(
  available: readonly Model<Api>[],
  requested: Model<Api> | undefined,
  find: (provider: string, id: string) => Model<Api> | undefined,
): Model<Api> {
  if (requested !== undefined && isPhysicalChatModel(requested)) {
    let registered: Model<Api> | undefined;
    try {
      registered = find(requested.provider, requested.id);
    } catch {
      registered = undefined;
    }
    if (
      registered !== undefined &&
      isPhysicalChatModel(registered) &&
      sameIdentity(registered, requested)
    ) {
      const availablePrevious = available.find(
        (model) => isPhysicalChatModel(model) && sameIdentity(model, registered),
      );
      if (availablePrevious !== undefined) return availablePrevious;
    }
  }

  const first = available.find(isPhysicalChatModel);
  if (first === undefined) throw new VirtualRouteError();
  return first;
}

/**
 * Minimal physical route used until F4.2 supplies the full deterministic router.
 * It preserves a still-available previous physical model, otherwise follows the
 * registry's available order. No credential payload or provider call is needed.
 */
export function routePhysicalModel(
  request: ModelRouteRequest,
  ctx: ExtensionContext,
): ModelRoute {
  let available: readonly Model<Api>[];
  try {
    available = ctx.modelRegistry.getAvailable();
  } catch {
    throw new VirtualRouteError();
  }

  const previous = request.previous?.model;
  const selected = selectAvailablePhysical(
    available,
    previous,
    (provider, id) => ctx.modelRegistry.find(provider, id),
  );
  const thinkingLevel = clampRequestedThinking(selected, request.thinkingLevel).effective;
  return { model: selected, thinkingLevel };
}

export type { ModelRoute, ModelRouteRequest };
