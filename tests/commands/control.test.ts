import { describe, expect, it, vi } from "vitest";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import {
  applyAutomatic,
  applyManualTier,
  ensureVirtualModel,
  releaseManualTier,
  resolveDefaultBias,
  setManualTier,
  severityForTsResult,
  TIER_BIAS,
  type ControlActions,
  type ControlContext,
  type TsCommandResult,
  type TsControlDependencies,
} from "../../src/commands/control";
import type { StatusConfigInput } from "../../src/commands/status";
import { routeRequest } from "../../src/routing";
import type { RouteRequest } from "../../src/routing";
import type { EffectiveConfig, LoadResult } from "../../src/config/types";

/**
 * Control-core lock (05-commands.md §7.2 hooks 1–6): the three-tier action
 * sequence and exact entry shape, idempotent no-append, /ts auto release
 * semantics, failure retention and best-effort rollback, serialized mutation
 * order with failure isolation, and the zero-candidate tier handing control
 * to Phase 4's fallback. Fakes only: no credentials, no network, no files.
 */

const CONTROL = "pi-tier-scheduler.router-control";

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

const virtual = model("ts", "auto", { api: "pi-virtual" });
const physical = model("acme", "pillar-1");

function controlEntry(manualOverride: "brain" | "pillar" | "crowd" | null): SessionEntry {
  return {
    type: "custom",
    customType: CONTROL,
    data: { schemaVersion: 1, manualOverride },
  } as unknown as SessionEntry;
}

function invalidControlEntry(): SessionEntry {
  return {
    type: "custom",
    customType: CONTROL,
    data: { schemaVersion: 1, manualOverride: "frob" },
  } as unknown as SessionEntry;
}

/** In-memory branch store: appendEntry lands on the branch getBranch exposes. */
function branchStore(initial: readonly SessionEntry[] = []) {
  const entries: SessionEntry[] = [...initial];
  return {
    entries,
    getBranch: (): SessionEntry[] => [...entries],
    appendEntry: (type: string, data: unknown): void => {
      entries.push({ type: "custom", customType: type, data } as unknown as SessionEntry);
    },
  };
}

/** Actions fake: records one ordered log of every Pi action taken. */
function actionLog(
  branch?: ReturnType<typeof branchStore>,
): { events: string[]; actions: ControlActions } {
  const events: string[] = [];
  const actions: ControlActions = {
    setModel: vi.fn(async (target: Model<Api>): Promise<boolean> => {
      events.push(`setModel:${target.provider}/${target.id}`);
      return true;
    }),
    setThinkingLevel: vi.fn((level: ThinkingLevel) => {
      events.push(`setThinkingLevel:${level}`);
    }),
    appendEntry: vi.fn((type: string, data?: unknown) => {
      events.push(`appendEntry:${type}`);
      if (branch !== undefined) branch.appendEntry(type, data);
    }),
    getThinkingLevel: vi.fn((): ThinkingLevel => "medium"),
  };
  return { events, actions };
}

function ctxOf(options: {
  model?: Model<Api> | undefined;
  branch?: ReturnType<typeof branchStore>;
  find?: (provider: string, id: string) => Model<Api> | undefined;
}): ControlContext {
  return {
    model: options.model,
    sessionManager: {
      getBranch: options.branch ? options.branch.getBranch : (): SessionEntry[] => [],
    },
    modelRegistry: {
      find:
        options.find ??
        ((provider: string, id: string): Model<Api> | undefined =>
          provider === "ts" && id === "auto" ? virtual : undefined),
    },
  } as unknown as ControlContext;
}

function effectiveConfig(overrides: Partial<EffectiveConfig["tiers"]> = {}): EffectiveConfig {
  return {
    schemaVersion: 1,
    tiers: {
      brain: { candidates: [{ provider: "acme", id: "brain-1" }] },
      pillar: { candidates: [{ provider: "acme", id: "pillar-1" }] },
      crowd: { candidates: [] },
      ...overrides,
    },
    policy: { defaultBias: "medium", sticky: true },
    retry: { maxAttemptsPerRequest: 3, maxTierSwitches: 2 },
    provenance: {},
  };
}

function loadResult(effective: EffectiveConfig): LoadResult {
  return {
    effective,
    problems: [],
    paths: { userPath: "/home/u/.pi/agent/tier-scheduler.json", projectPath: "/w/.pi/tier-scheduler.json" },
    layers: { user: "missing", project: "missing" },
  } satisfies StatusConfigInput;
}

/**
 * Deps fake with a minimal arrival-order queue mirroring the extension tail
 * (§3.7): the operation chain never rejects, the caller sees its own outcome.
 */
function controlDeps(options: {
  config?: LoadResult | undefined;
  actions: ControlActions;
}): TsControlDependencies {
  let tail: Promise<unknown> = Promise.resolve();
  const deps = {
    getThinkingLevel: (): ThinkingLevel => options.actions.getThinkingLevel(),
    getConfig: (): LoadResult | undefined => options.config,
    getLastDispatch: (): undefined => undefined,
    pi: {
      setModel: (target: Model<Api>): Promise<boolean> => options.actions.setModel(target),
      setThinkingLevel: (level: ThinkingLevel): void => options.actions.setThinkingLevel(level),
      appendEntry: (type: string, data?: unknown): void => options.actions.appendEntry(type, data),
    },
    enqueueControlMutation: <T>(operation: () => Promise<T>): Promise<T> => {
      const run = tail.then(operation);
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
  return deps as unknown as TsControlDependencies;
}

/** Hand-built actions for the failure cases; each records into one event log. */
function failureActions(overrides: {
  setModel?: ControlActions["setModel"];
  appendEntry?: ControlActions["appendEntry"];
  thinkingLevel?: ThinkingLevel;
}): { events: string[]; actions: ControlActions } {
  const events: string[] = [];
  const actions: ControlActions = {
    setModel:
      overrides.setModel ??
      vi.fn(async (target: Model<Api>): Promise<boolean> => {
        events.push(`setModel:${target.provider}/${target.id}`);
        return true;
      }),
    setThinkingLevel: vi.fn((level: ThinkingLevel) => {
      events.push(`setThinkingLevel:${level}`);
    }),
    appendEntry:
      overrides.appendEntry ??
      vi.fn((type: string) => {
        events.push(`appendEntry:${type}`);
      }),
    getThinkingLevel: vi.fn((): ThinkingLevel => overrides.thinkingLevel ?? "medium"),
  };
  return { events, actions };
}

describe("TIER_BIAS — fixed tier→bias mapping (§4.4)", () => {
  it("maps brain→high, pillar→medium, crowd→low", () => {
    expect(TIER_BIAS).toEqual({ brain: "high", pillar: "medium", crowd: "low" });
  });
});

describe("ensureVirtualModel — registry lookup", () => {
  it("finds the registered ts/auto model", () => {
    const found = ensureVirtualModel(ctxOf({}));
    expect(found).toEqual({ ok: true, model: virtual });
  });

  it("reports a missing virtual model without touching anything", () => {
    const found = ensureVirtualModel(ctxOf({ find: () => undefined }));
    expect(found).toEqual({ ok: false, code: "virtual_model_missing" });
  });

  it("rejects an id-mismatched entry under the namespace", () => {
    const found = ensureVirtualModel(
      ctxOf({ find: () => model("ts", "auto-2", { api: "pi-virtual" }) }),
    );
    expect(found).toEqual({ ok: false, code: "virtual_model_missing" });
  });
});

describe("applyManualTier — the three-tier action sequence (§3.5, hooks 1–2)", () => {
  it.each(["brain", "pillar", "crowd"] as const)(
    "use %s: setModel(ts/auto) → setThinkingLevel(%s) → append the exact control entry",
    async (tier) => {
      const branch = branchStore();
      const { events, actions } = actionLog(branch);
      const result = await applyManualTier(tier, ctxOf({ branch, model: physical }), actions);

      expect(result).toEqual({
        ok: true,
        message: `pinned: ${tier} • ${TIER_BIAS[tier]}`,
        controlChanged: true,
      });
      expect(events).toEqual([
        "setModel:ts/auto",
        `setThinkingLevel:${TIER_BIAS[tier]}`,
        `appendEntry:${CONTROL}`,
      ]);
      expect(actions.appendEntry).toHaveBeenCalledWith(CONTROL, {
        schemaVersion: 1,
        manualOverride: tier,
      });
      expect(branch.entries).toEqual([controlEntry(tier)]);
    },
  );

  it("does not duplicate the entry when the latest control already equals the tier", async () => {
    const branch = branchStore([controlEntry("brain")]);
    const { events, actions } = actionLog();
    const result = await applyManualTier("brain", ctxOf({ branch, model: physical }), actions);

    expect(result).toEqual({
      ok: true,
      message: "pinned: brain • high",
      controlChanged: false,
    });
    expect(events).toEqual(["setModel:ts/auto", "setThinkingLevel:high"]);
    expect(actions.appendEntry).not.toHaveBeenCalled();
    expect(branch.entries).toEqual([controlEntry("brain")]);
  });

  it("appends over an invalid latest entry and replaces it as control", async () => {
    const branch = branchStore([invalidControlEntry()]);
    const { actions } = actionLog(branch);
    const result = await applyManualTier("crowd", ctxOf({ branch, model: physical }), actions);

    expect(result).toEqual({
      ok: true,
      message: "pinned: crowd • low",
      controlChanged: true,
    });
    expect(actions.appendEntry).toHaveBeenCalledWith(CONTROL, {
      schemaVersion: 1,
      manualOverride: "crowd",
    });
    expect(branch.entries).toEqual([invalidControlEntry(), controlEntry("crowd")]);
  });

  it("reads the branch fail-soft: a broken session manager reads as no control", async () => {
    const { actions } = actionLog();
    const ctx = {
      model: physical,
      sessionManager: {
        getBranch: () => {
          throw new Error("session gone");
        },
      },
      modelRegistry: { find: () => virtual },
    } as unknown as ControlContext;
    const result = await applyManualTier("brain", ctx, actions);

    expect(result).toEqual({
      ok: true,
      message: "pinned: brain • high",
      controlChanged: true,
    });
    expect(actions.appendEntry).toHaveBeenCalledTimes(1);
  });
});

describe("applyAutomatic — /ts auto release semantics (§3.6, hook 3)", () => {
  it("restores the effective defaultBias and appends null over a manual control", async () => {
    const branch = branchStore([controlEntry("brain")]);
    const { events, actions } = actionLog(branch);
    const result = await applyAutomatic(ctxOf({ branch, model: physical }), actions, "high");

    expect(result).toEqual({
      ok: true,
      message: "auto routing • bias high",
      controlChanged: true,
    });
    expect(events).toEqual(["setModel:ts/auto", "setThinkingLevel:high", `appendEntry:${CONTROL}`]);
    expect(branch.entries).toEqual([controlEntry("brain"), controlEntry(null)]);
  });

  it("does not append when the latest valid control is already automatic", async () => {
    const branch = branchStore([controlEntry(null)]);
    const { events, actions } = actionLog();
    const result = await applyAutomatic(ctxOf({ branch }), actions, "medium");

    expect(result).toEqual({
      ok: true,
      message: "auto routing • bias medium",
      controlChanged: false,
    });
    expect(events).toEqual(["setModel:ts/auto", "setThinkingLevel:medium"]);
    expect(branch.entries).toEqual([controlEntry(null)]);
  });

  it("appends null over an invalid latest entry (recovered reads as needing release)", async () => {
    const branch = branchStore([invalidControlEntry()]);
    const { actions } = actionLog();
    const result = await applyAutomatic(ctxOf({ branch }), actions, "medium");

    expect(result).toEqual({
      ok: true,
      message: "auto routing • bias medium",
      controlChanged: true,
    });
    expect(actions.appendEntry).toHaveBeenCalledWith(CONTROL, {
      schemaVersion: 1,
      manualOverride: null,
    });
  });

  it("resolves the bias from the validated effective load, falling back to built-in defaults", () => {
    expect(resolveDefaultBias(loadResult(effectiveConfig()))).toBe("medium");
    expect(
      resolveDefaultBias(
        loadResult({ ...effectiveConfig(), policy: { defaultBias: "high", sticky: true } }),
      ),
    ).toBe("high");
    expect(resolveDefaultBias(undefined)).toBe("medium");
  });
});

describe("failure retention — no state change on the failed paths (§5.5, hook 5)", () => {
  it("leaves the prior model and control untouched when the virtual model is missing", async () => {
    const branch = branchStore([controlEntry("pillar")]);
    const { events, actions } = actionLog();
    const result = await applyManualTier(
      "brain",
      ctxOf({ branch, model: physical, find: () => undefined }),
      actions,
    );

    expect(result).toEqual({
      ok: false,
      code: "virtual_model_missing",
      message: expect.stringContaining("control was not changed"),
    });
    expect(events).toEqual([]);
    expect(branch.entries).toEqual([controlEntry("pillar")]);
  });

  it("keeps thinking and control untouched when setModel returns false", async () => {
    const branch = branchStore([controlEntry("pillar")]);
    const { events, actions } = failureActions({
      setModel: vi.fn(async (): Promise<boolean> => {
        events.push("setModel");
        return false;
      }),
    });
    const result = await applyManualTier("brain", ctxOf({ branch, model: physical }), actions);

    expect(result).toEqual({
      ok: false,
      code: "set_model_rejected",
      message: expect.stringContaining("authentication is not configured"),
    });
    expect(events).toEqual(["setModel"]);
    expect(branch.entries).toEqual([controlEntry("pillar")]);
  });

  it("keeps thinking and control untouched when setModel throws", async () => {
    const branch = branchStore([controlEntry("pillar")]);
    const { events, actions } = failureActions({
      setModel: vi.fn(async (): Promise<boolean> => {
        events.push("setModel");
        throw new Error("secret-key leaked from /Users/alice/keyring");
      }),
    });
    const result = await applyManualTier("brain", ctxOf({ branch, model: physical }), actions);

    expect(result).toEqual({
      ok: false,
      code: "set_model_failed",
      message: expect.stringContaining("session action failed"),
    });
    expect(result.message).not.toContain("secret-key");
    expect(result.message).not.toContain("/Users");
    expect(events).toEqual(["setModel"]);
    expect(branch.entries).toEqual([controlEntry("pillar")]);
  });

  it("restores the previous model and thinking on an append failure", async () => {
    const branch = branchStore([controlEntry("pillar")]);
    const { events, actions } = failureActions({
      appendEntry: vi.fn((): void => {
        events.push("appendEntry");
        throw new Error("session storage exploded with sk-live-999");
      }),
      thinkingLevel: "low",
    });
    const result = await applyManualTier("brain", ctxOf({ branch, model: physical }), actions);

    expect(result).toEqual({
      ok: false,
      code: "append_control_failed",
      message: expect.stringContaining("best-effort"),
    });
    expect(result.message).not.toContain("sk-live-999");
    expect(result.message).not.toContain("exploded");
    // Failed append rolls back: the previous physical model and thinking restore.
    expect(events).toEqual([
      "setModel:ts/auto",
      "setThinkingLevel:high",
      "appendEntry",
      "setModel:acme/pillar-1",
      "setThinkingLevel:low",
    ]);
    expect(branch.entries).toEqual([controlEntry("pillar")]);
  });

  it("keeps reporting the append failure even when the restore also fails", async () => {
    const { events, actions } = failureActions({
      setModel: vi.fn(async (target: Model<Api>): Promise<boolean> => {
        events.push(`setModel:${target.id}`);
        if (target.id === "pillar-1") throw new Error("restore failed");
        return true;
      }),
      appendEntry: vi.fn((): void => {
        throw new Error("append failed");
      }),
      thinkingLevel: "low",
    });
    const result = await applyManualTier("brain", ctxOf({ model: physical }), actions);

    expect(result).toEqual({
      ok: false,
      code: "append_control_failed",
      message: expect.stringContaining("best-effort"),
    });
    expect(events).toEqual([
      "setModel:auto",
      "setThinkingLevel:high",
      "setModel:pillar-1",
      "setThinkingLevel:low",
    ]);
  });

  it("has no model restore to attempt when the command started unselected", async () => {
    const { events, actions } = failureActions({
      appendEntry: vi.fn((): void => {
        throw new Error("append failed");
      }),
      thinkingLevel: "high",
    });
    const result = await applyManualTier("crowd", ctxOf({ model: undefined }), actions);

    expect(result).toEqual({
      ok: false,
      code: "append_control_failed",
      message: expect.stringContaining("best-effort"),
    });
    // Tier set (crowd→low), then the captured thinking (high) restores; no
    // previous model existed, so no setModel restore is attempted.
    expect(events).toEqual(["setModel:ts/auto", "setThinkingLevel:low", "setThinkingLevel:high"]);
  });
});

describe("zero-candidate tier — control accepts, the next route falls back (§5.2, hook 4)", () => {
  it("manual control succeeds on an empty tier; the next fake route observes the override", async () => {
    // crowd has zero candidates in the effective config.
    const config = effectiveConfig({ crowd: { candidates: [] } });
    const branch = branchStore();
    const { actions } = actionLog(branch);
    const result = await applyManualTier("crowd", ctxOf({ branch }), actions);

    expect(result.ok).toBe(true);
    expect(result.message).toBe("pinned: crowd • low");

    const message: Message = { role: "user", content: "implement a parser", timestamp: 0 };
    const request: RouteRequest = {
      model: virtual,
      thinkingLevel: "medium",
      reason: "user",
      messages: [message],
    };
    const decision = routeRequest(
      request,
      {
        modelRegistry: {
          getAvailable: (): Model<Api>[] => [physical],
          find: (provider: string, id: string): Model<Api> | undefined =>
            provider === "acme" && id === "pillar-1" ? physical : undefined,
        },
        sessionManager: { getBranch: branch.getBranch },
      } as unknown as ExtensionContext,
      { config, branch: branch.entries },
    );
    expect(decision.reason.code).toBe("manual_override_fallback");
    expect(decision.model).toBe(physical);
    expect(decision.tier).toBe("pillar");
  });
});

describe("setManualTier/releaseManualTier — serialization through the queue (§3.7, hook 6)", () => {
  it("runs mutations inside enqueueControlMutation in arrival order", async () => {
    const branch = branchStore();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const blockFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const actions: ControlActions = {
      setModel: vi.fn(async (): Promise<boolean> => {
        order.push("setModel:start");
        if (order.filter((item) => item === "setModel:start").length === 1) {
          await blockFirst;
        }
        order.push("setModel:end");
        return true;
      }),
      setThinkingLevel: vi.fn((level: ThinkingLevel) => {
        order.push(`thinking:${level}`);
      }),
      appendEntry: vi.fn((type: string, data: unknown) => {
        order.push(`append:${(data as { manualOverride: string | null }).manualOverride}`);
        branch.appendEntry(type, data);
      }),
      getThinkingLevel: vi.fn((): ThinkingLevel => "medium"),
    };
    const deps = controlDeps({ config: loadResult(effectiveConfig()), actions });
    const ctx = ctxOf({ branch });

    const first = setManualTier("brain", ctx, deps);
    await vi.waitFor(() => {
      expect(order).toEqual(["setModel:start"]);
    });
    const second = releaseManualTier(ctx, deps);

    // Serialized: the second mutation must not start while the first is in flight.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["setModel:start"]);

    releaseFirst?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual({
      ok: true,
      message: "pinned: brain • high",
      controlChanged: true,
    });
    expect(secondResult).toEqual({
      ok: true,
      message: "auto routing • bias medium",
      controlChanged: true,
    });
    expect(order).toEqual([
      "setModel:start",
      "setModel:end",
      "thinking:high",
      "append:brain",
      "setModel:start",
      "setModel:end",
      "thinking:medium",
      "append:null",
    ]);
    expect(branch.entries).toEqual([controlEntry("brain"), controlEntry(null)]);
  });

  it("isolates failures: a rejected operation never poisons the tail", async () => {
    const branch = branchStore();
    let thinkingCalls = 0;
    const actions: ControlActions = {
      setModel: vi.fn(async (): Promise<boolean> => true),
      setThinkingLevel: vi.fn((): void => {
        thinkingCalls += 1;
        if (thinkingCalls === 1) throw new Error("unexpected thinking failure");
      }),
      appendEntry: vi.fn((type: string, data: unknown) => branch.appendEntry(type, data)),
      getThinkingLevel: vi.fn((): ThinkingLevel => "medium"),
    };
    const deps = controlDeps({ actions });
    const ctx = ctxOf({ branch });

    // Unexpected errors propagate to the caller — never swallowed.
    await expect(setManualTier("brain", ctx, deps)).rejects.toThrow("unexpected thinking failure");
    // The tail stays usable: the next command succeeds.
    const next = await setManualTier("crowd", ctx, deps);
    expect(next).toEqual({
      ok: true,
      message: "pinned: crowd • low",
      controlChanged: true,
    });
    expect(branch.entries).toEqual([controlEntry("crowd")]);
  });

  it("queues expected failures as results without rejecting", async () => {
    const branch = branchStore([controlEntry("pillar")]);
    const { actions } = failureActions({ setModel: vi.fn(async (): Promise<boolean> => false) });
    const deps = controlDeps({ actions });
    const rejected = await setManualTier("brain", ctxOf({ branch }), deps);

    expect(rejected).toEqual({
      ok: false,
      code: "set_model_rejected",
      message: expect.any(String),
    });
    expect(branch.entries).toEqual([controlEntry("pillar")]);
  });

  it("passes the effective load's defaultBias to the release mutation", async () => {
    const branch = branchStore([controlEntry("brain")]);
    const config = effectiveConfig();
    config.policy.defaultBias = "high";
    const { actions } = actionLog();
    const deps = controlDeps({ config: loadResult(config), actions });

    const result = await releaseManualTier(ctxOf({ branch }), deps);
    expect(result).toEqual({
      ok: true,
      message: "auto routing • bias high",
      controlChanged: true,
    });
    expect(actions.setThinkingLevel).toHaveBeenCalledWith("high");
  });

  it("falls back to the built-in default bias when no load is ready", async () => {
    const branch = branchStore([controlEntry("crowd")]);
    const { actions } = actionLog();
    const deps = controlDeps({ config: undefined, actions });

    const result = await releaseManualTier(ctxOf({ branch }), deps);
    expect(result).toEqual({
      ok: true,
      message: "auto routing • bias medium",
      controlChanged: true,
    });
    expect(actions.setThinkingLevel).toHaveBeenCalledWith("medium");
  });
});

describe("severityForTsResult — response severity vocabulary", () => {
  it("maps success to info, an unauthenticated selection to warning, the rest to error", () => {
    expect(severityForTsResult({ ok: true, message: "m", controlChanged: true })).toBe("info");
    expect(
      severityForTsResult({ ok: false, code: "set_model_rejected", message: "m" } as TsCommandResult),
    ).toBe("warning");
    for (const code of ["virtual_model_missing", "set_model_failed", "append_control_failed"] as const) {
      expect(severityForTsResult({ ok: false, code, message: "m" } as TsCommandResult)).toBe("error");
    }
  });
});

// Re-exported shape guard: the command context contract stays structural,
// so this suite needs no live Pi process (all fakes satisfy ControlContext).
describe("ControlContext — structural shape", () => {
  it("accepts the fields the real ExtensionCommandContext provides", () => {
    const shape = {
      model: physical,
      sessionManager: { getBranch: (): SessionEntry[] => [] },
      modelRegistry: { find: (): Model<Api> | undefined => undefined },
    };
    expect(shape as unknown as ExtensionCommandContext).toBeDefined();
  });
});
