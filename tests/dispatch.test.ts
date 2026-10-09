import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import type { EffectiveConfig } from "../src/config/types";
import { respond } from "../src/ui/respond";
import {
  CANDIDATES,
  SUBCOMMANDS,
  TIER_CANDIDATES,
  completeArguments,
  dispatch,
  resolveSubcommand,
  type TsDispatchDependencies,
} from "../src/commands/dispatch";
import type { LastDispatchSummary } from "../src/commands/types";

/**
 * Dispatch wiring lock (05-commands.md §3.1/§3.8/§7.1 hook 1/§7.2 hooks 1–2):
 * empty normalizes to status, parser errors respond as warnings without
 * touching Pi state, use/auto run the serialized control path with the
 * result's own severity, deferred subcommands keep their owning-phase stub,
 * and the completion surface stays pure with `use ` tier candidates.
 */

const CONTROL = "pi-tier-scheduler.router-control";

function virtualModel(): Model<Api> {
  return {
    id: "auto",
    name: "Auto",
    api: "pi-virtual",
    provider: "ts",
    baseUrl: "",
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: true,
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

function controlEntry(manualOverride: "brain" | "pillar" | "crowd" | null): SessionEntry {
  return {
    type: "custom",
    customType: CONTROL,
    data: { schemaVersion: 1, manualOverride },
  } as unknown as SessionEntry;
}

/** Pi action spies the control path drives through deps.pi. */
function controlActions(options: { setModelResult?: boolean } = {}) {
  return {
    setModel: vi.fn(async (_target: Model<Api>): Promise<boolean> => options.setModelResult ?? true),
    setThinkingLevel: vi.fn(),
    appendEntry: vi.fn(),
  };
}

type Actions = ReturnType<typeof controlActions>;

function fakeCtx(
  hasUI: boolean,
  options: { branch?: readonly SessionEntry[]; virtualModel?: boolean } = {},
) {
  const notify = vi.fn();
  const select = vi.fn(async (): Promise<string | undefined> => undefined);
  const confirm = vi.fn(async (): Promise<boolean> => false);
  const input = vi.fn(async (): Promise<string | undefined> => undefined);
  const physical = (provider: string, id: string): Model<Api> => ({
    id,
    name: `${provider}/${id}`,
    api: "openai-completions",
    provider,
    baseUrl: "https://api.example.test/v1",
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 16_384,
  });
  const find = vi.fn(
    (provider: string, id: string): Model<Api> | undefined =>
      provider === "ts" && id === "auto" && options.virtualModel !== false
        ? virtualModel()
        : provider === "acme"
          ? physical(provider, id)
          : undefined,
  );
  const getAvailable = vi.fn(
    (): Model<Api>[] => [physical("acme", "brain-1"), physical("acme", "pillar-1")],
  );
  const getProviderAuthStatus = vi.fn(() => ({ configured: true, source: "environment" }));
  const shape = {
    hasUI,
    mode: hasUI ? "tui" : "json",
    ui: { notify, select, confirm, input },
    model: { provider: "ts", id: "auto", api: "pi-virtual" },
    sessionManager: { getBranch: () => [...(options.branch ?? [])] },
    modelRegistry: { find, getAvailable, getProviderAuthStatus },
  };
  return {
    ctx: shape as unknown as ExtensionCommandContext,
    notify,
    select,
    confirm,
    input,
    find,
  };
}

function effectiveConfig(): EffectiveConfig {
  return {
    schemaVersion: 1,
    tiers: {
      brain: { candidates: [{ provider: "acme", id: "brain-1" }] },
      pillar: { candidates: [{ provider: "acme", id: "pillar-1" }] },
      crowd: { candidates: [] },
    },
    policy: { defaultBias: "medium", sticky: true },
    retry: { maxAttemptsPerRequest: 3, maxTierSwitches: 2 },
    provenance: {},
  };
}

/** Deps fake: status inputs plus the control actions and a passthrough queue. */
function deps(overrides: Partial<TsDispatchDependencies> = {}, actions: Actions = controlActions()): {
  deps: TsDispatchDependencies;
  actions: Actions;
} {
  const built: TsDispatchDependencies = {
    getThinkingLevel: (): ThinkingLevel => "medium",
    getConfig: () => ({
      effective: effectiveConfig(),
      problems: [],
      paths: { userPath: "/home/u/.pi/agent/tier-scheduler.json", projectPath: "/w/.pi/tier-scheduler.json" },
      layers: { user: "missing", project: "missing" },
    }),
    getLastDispatch: () => undefined,
    pi: {
      setModel: (target: Model<Api>): Promise<boolean> => actions.setModel(target),
      setThinkingLevel: (level: ThinkingLevel): void => actions.setThinkingLevel(level),
      appendEntry: (type: string, data?: unknown): void => actions.appendEntry(type, data),
    },
    enqueueControlMutation: <T>(operation: () => Promise<T>): Promise<T> => operation(),
    // F7.1 config seams: benign defaults; per-test overrides swap them.
    respond: respond,
    readConfigLayerForEdit: async () => {
      throw new Error("readConfigLayerForEdit not scripted for this test");
    },
    loadConfig: async () => {
      throw new Error("loadConfig not scripted for this test");
    },
    saveConfigFile: async () => {},
    isRuntimeClosed: () => false,
    isFlowActive: () => false,
    setFlowActive: () => {},
    getConfigRevision: () => 1,
    applyConfigReload: () => ({ applied: true, revision: 2 }),
    enqueueConfigSave: <T>(operation: () => Promise<T>): Promise<T> => operation(),
    // F7.2 seams; per-test overrides swap them.
    getManualOverride: () => null,
    refreshFooter: () => {},
    setReloadPending: () => {},
    getRouteLogHealth: () => ({ writeFailures: 0 }),
    getDoctorApi: () => ({
      runtimeVersion: "1.0.4",
      apiProbes: {
        registerVirtualModel: () => true,
        registerCommand: () => true,
        appendEntry: () => true,
      },
    }),
    recordDoctorReport: () => {},
    ...overrides,
  } as unknown as TsDispatchDependencies;
  return { deps: built, actions };
}

describe("SUBCOMMANDS — phase contract lock", () => {
  it("seeds the six canonical names in table order with owning phases", () => {
    expect(SUBCOMMANDS.map((entry) => entry.name)).toEqual([
      "status",
      "use",
      "auto",
      "init",
      "config",
      "doctor",
    ]);
    const phases = Object.fromEntries(
      SUBCOMMANDS.map((entry) => [entry.name, entry.owningPhase]),
    );
    expect(phases).toEqual({
      status: 5,
      use: 5,
      auto: 5,
      init: 7,
      config: 7,
      doctor: 6,
    });
  });

  it("declares the brain|pillar|crowd alias layer on use only", () => {
    const use = SUBCOMMANDS.find((entry) => entry.name === "use");
    expect(use?.aliases).toEqual(["brain", "pillar", "crowd"]);
    expect(
      SUBCOMMANDS.filter((entry) => entry.name !== "use").every(
        (entry) => entry.aliases.length === 0,
      ),
    ).toBe(true);
  });

  it("resolveSubcommand maps aliases to the canonical entry", () => {
    expect(resolveSubcommand("brain")?.name).toBe("use");
    expect(resolveSubcommand("pillar")?.name).toBe("use");
    expect(resolveSubcommand("crowd")?.name).toBe("use");
    expect(resolveSubcommand("status")?.name).toBe("status");
    expect(resolveSubcommand("frob")).toBeUndefined();
  });

  it("keeps the first-level candidate shape: value, label, description", () => {
    expect(CANDIDATES).toHaveLength(9);
    const status = CANDIDATES.find((item) => item.value === "status");
    expect(status?.label).toBe("status");
    expect(status?.description).toBe(SUBCOMMANDS[0]?.description);
    const brain = CANDIDATES.find((item) => item.value === "brain");
    expect(brain?.label).toBe("brain");
    expect(brain?.description).toBe("alias of use");
  });
});

describe("dispatch — /ts routing", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes empty input to the status body (no banner)", async () => {
    const { ctx, notify } = fakeCtx(true);
    const built = deps();
    await dispatch("", ctx, built.deps);
    expect(notify).toHaveBeenCalledTimes(1);
    const [message, severity] = notify.mock.calls[0] ?? [];
    expect(severity).toBe("info");
    expect(String(message)).toContain("pi-tier-scheduler status");
  });

  it("renders an identical snapshot for empty and explicit status", async () => {
    const first = fakeCtx(true);
    await dispatch("", first.ctx, deps().deps);
    const second = fakeCtx(true);
    await dispatch("status", second.ctx, deps().deps);
    expect(first.notify.mock.calls[0]?.[0]).toBe(second.notify.mock.calls[0]?.[0]);
  });

  it("answers status with the routed view in TUI mode", async () => {
    const { ctx, notify } = fakeCtx(true, { branch: [controlEntry("brain")] });
    const lastDispatch: LastDispatchSummary = {
      model: { provider: "anthropic", id: "claude-sonnet-4-1" },
      tier: "pillar",
      thinkingLevel: "medium",
      reasonCode: "work_phase",
      selectedTier: "pillar",
      attempt: 1,
      maxAttempts: 3,
    };
    const built = deps({ getLastDispatch: () => lastDispatch });
    await dispatch("status", ctx, built.deps);
    const text = String(notify.mock.calls[0]?.[0]);
    expect(text).toContain("selection: ts/auto");
    expect(text).toContain("routing: manual");
    expect(text).toContain("override: brain");
    expect(text).toContain("last dispatch: anthropic/claude-sonnet-4-1 (tier=pillar, thinking=medium)");
    expect(text).toContain("last reason: work_phase (selected=pillar)");
  });

  it("runs the real control path for use, auto, and the tier aliases", async () => {
    const { ctx, notify } = fakeCtx(true);
    const actions = controlActions();
    const built = deps({}, actions);

    await dispatch("use brain", ctx, built.deps);
    expect(notify).toHaveBeenCalledWith("manual routing set to brain (ts/auto thinking=high)", "info");
    await dispatch("pillar", ctx, built.deps);
    expect(notify).toHaveBeenCalledWith("manual routing set to pillar (ts/auto thinking=medium)", "info");
    await dispatch("crowd", ctx, built.deps);
    expect(notify).toHaveBeenCalledWith("manual routing set to crowd (ts/auto thinking=low)", "info");
    await dispatch("auto", ctx, built.deps);
    expect(notify).toHaveBeenCalledWith("automatic routing enabled (bias=medium)", "info");

    expect(actions.setModel).toHaveBeenCalledTimes(4);
    expect(actions.setThinkingLevel).toHaveBeenNthCalledWith(1, "high");
    expect(actions.setThinkingLevel).toHaveBeenNthCalledWith(2, "medium");
    expect(actions.setThinkingLevel).toHaveBeenNthCalledWith(3, "low");
    expect(actions.setThinkingLevel).toHaveBeenNthCalledWith(4, "medium");
    // The empty branch reads as already-automatic, so the three use appends land
    // and the auto release needs no duplicate entry.
    expect(actions.appendEntry).toHaveBeenCalledTimes(3);
    expect(actions.appendEntry).toHaveBeenCalledWith(CONTROL, {
      schemaVersion: 1,
      manualOverride: "brain",
    });
  });

  it("answers aliases identically to the explicit use form", async () => {
    const explicit = fakeCtx(true);
    await dispatch("use brain", explicit.ctx, deps().deps);
    const alias = fakeCtx(true);
    await dispatch("brain", alias.ctx, deps().deps);
    expect(explicit.notify.mock.calls[0]).toEqual(alias.notify.mock.calls[0]);
  });

  it("releases manual control with a null entry over a non-null latest", async () => {
    const { ctx, notify } = fakeCtx(true, { branch: [controlEntry("brain")] });
    const actions = controlActions();
    await dispatch("auto", ctx, deps({}, actions).deps);
    expect(notify).toHaveBeenCalledWith("automatic routing enabled (bias=medium)", "info");
    expect(actions.appendEntry).toHaveBeenCalledWith(CONTROL, {
      schemaVersion: 1,
      manualOverride: null,
    });
  });

  it("reports an unauthenticated selection as a warning without appending", async () => {
    const { ctx, notify } = fakeCtx(true);
    const actions = controlActions({ setModelResult: false });
    await dispatch("use brain", ctx, deps({}, actions).deps);
    const [message, severity] = notify.mock.calls[0] ?? [];
    expect(severity).toBe("warning");
    expect(String(message)).toContain("could not be selected");
    expect(actions.setThinkingLevel).not.toHaveBeenCalled();
    expect(actions.appendEntry).not.toHaveBeenCalled();
  });

  it("reports a missing virtual model as an error without touching Pi state", async () => {
    const { ctx, notify } = fakeCtx(true, { virtualModel: false });
    const actions = controlActions();
    await dispatch("use brain", ctx, deps({}, actions).deps);
    const [message, severity] = notify.mock.calls[0] ?? [];
    expect(severity).toBe("error");
    expect(String(message)).toContain("ts/auto is not available");
    expect(actions.setModel).not.toHaveBeenCalled();
    expect(actions.setThinkingLevel).not.toHaveBeenCalled();
    expect(actions.appendEntry).not.toHaveBeenCalled();
  });

  it("routes doctor to the real diagnostics body, init to the wizard body, config to the real handler", async () => {
    const doctorCtx = fakeCtx(true);
    await dispatch("doctor", doctorCtx.ctx, deps().deps);
    const [message, severity] = doctorCtx.notify.mock.calls[0] ?? [];
    expect(severity).toBe("warning"); // the config fixture carries an empty crowd tier
    expect(String(message)).toContain("pi-tier-scheduler doctor");
    expect(String(message)).toContain("config: pass (effective schema=1; problems=0)");

    // init reaches the real F7.1 handler: the scripted TUI ctx escapes at
    // the scope dialog, so the wizard ends with the stable cancel notice
    // and no other dialog is opened.
    const { ctx, notify, select, confirm } = fakeCtx(true);
    await dispatch("init", ctx, deps().deps);
    expect(notify).toHaveBeenCalledWith("configuration cancelled; no changes made", "info");
    expect(select).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();

    // config reaches the real F7.2 handler: the view renders, then the
    // post-view menu escapes, so the flow ends with the stable cancel
    // notice and the layer probe is never reached.
    await dispatch("config", ctx, deps().deps);
    expect(notify).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("pi-tier-scheduler configuration"),
      "info",
    );
    expect(notify).toHaveBeenNthCalledWith(3, "configuration cancelled; no changes made", "info");
    expect(select).toHaveBeenCalledTimes(2);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("refreshes the footer after a successful use/auto and not after a failure", async () => {
    const use = fakeCtx(true);
    const refreshFooter = vi.fn();
    await dispatch("use brain", use.ctx, deps({ refreshFooter }).deps);
    expect(refreshFooter).toHaveBeenCalledTimes(1);
    expect(refreshFooter).toHaveBeenCalledWith(use.ctx);

    const failed = fakeCtx(true); // unauthenticated setModel → control failure
    const refreshFooterFailed = vi.fn();
    await dispatch(
      "use brain",
      failed.ctx,
      deps({ refreshFooter: refreshFooterFailed }, controlActions({ setModelResult: false })).deps,
    );
    expect(refreshFooterFailed).not.toHaveBeenCalled();

    const auto = fakeCtx(true);
    const refreshFooterAuto = vi.fn();
    await dispatch("auto", auto.ctx, deps({ refreshFooter: refreshFooterAuto }).deps);
    expect(refreshFooterAuto).toHaveBeenCalledTimes(1);
  });

  it("answers parser errors once with warning severity and zero Pi actions", async () => {
    const { ctx, notify } = fakeCtx(true);
    const actions = controlActions();
    const built = deps({}, actions);
    await dispatch("frob", ctx, built.deps);
    await dispatch("use", ctx, built.deps);
    await dispatch("use frob", ctx, built.deps);
    await dispatch("status extra", ctx, built.deps);
    await dispatch("brain extra", ctx, built.deps);
    expect(notify).toHaveBeenCalledTimes(5);
    for (const call of notify.mock.calls) {
      expect(call?.[1]).toBe("warning");
    }
    expect(String(notify.mock.calls[0]?.[0])).toContain("unknown command 'frob'");
    expect(String(notify.mock.calls[1]?.[0])).toContain("missing tier");
    expect(String(notify.mock.calls[2]?.[0])).toContain("unknown tier 'frob'");
    expect(String(notify.mock.calls[3]?.[0])).toContain("invalid arguments for 'status'");
    expect(String(notify.mock.calls[4]?.[0])).toContain("invalid arguments for 'brain'");
    expect(actions.setModel).not.toHaveBeenCalled();
    expect(actions.setThinkingLevel).not.toHaveBeenCalled();
    expect(actions.appendEntry).not.toHaveBeenCalled();
  });

  it("answers on stderr when headless and never touches notify", async () => {
    const { ctx, notify } = fakeCtx(false);
    await dispatch("status", ctx, deps().deps);
    expect(notify).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0]?.[0])).toContain("pi-tier-scheduler status");
  });
});

describe("completeArguments — pure two-level completion", () => {
  it("offers all nine first-level candidates on an empty prefix, in canonical-first order", () => {
    const items = completeArguments("");
    expect(items).not.toBeNull();
    expect(items?.map((item) => item.value)).toEqual([
      "status",
      "use",
      "auto",
      "init",
      "config",
      "doctor",
      "brain",
      "pillar",
      "crowd",
    ]);
  });

  it("prefix-filters names and aliases before any whitespace", () => {
    expect(completeArguments("st")?.map((item) => item.value)).toEqual(["status"]);
    expect(completeArguments("c")?.map((item) => item.value)).toEqual(["config", "crowd"]);
    expect(completeArguments("use")?.map((item) => item.value)).toEqual(["use"]);
  });

  it("offers the three tiers after 'use ' (05-commands.md §3.8)", () => {
    expect(completeArguments("use ")?.map((item) => item.value)).toEqual([
      "brain",
      "pillar",
      "crowd",
    ]);
    expect(completeArguments("use b")?.map((item) => item.value)).toEqual(["brain"]);
    expect(completeArguments("use p")?.map((item) => item.value)).toEqual(["pillar"]);
    expect(completeArguments("use cr")?.map((item) => item.value)).toEqual(["crowd"]);
    expect(TIER_CANDIDATES.map((item) => item.value)).toEqual(["brain", "pillar", "crowd"]);
  });

  it("keeps tier completion available without reading config or the filesystem", () => {
    // The completion helper is a pure function over the prefix; nothing is
    // injected here, so any config/catalog/filesystem read would throw.
    expect(completeArguments("use ")).not.toBeNull();
  });

  it("returns null for complete commands with no valid next token", () => {
    expect(completeArguments("use brain")).toBeNull();
    expect(completeArguments("use brain ")).toBeNull();
    expect(completeArguments("use brain x")).toBeNull();
    expect(completeArguments("status ")).toBeNull();
    expect(completeArguments("status foo")).toBeNull();
    expect(completeArguments("auto ")).toBeNull();
    expect(completeArguments("brain ")).toBeNull();
    expect(completeArguments("init ")).toBeNull();
  });

  it("returns [] for an unknown head or an unmatched tier prefix", () => {
    expect(completeArguments("frob")).toEqual([]);
    expect(completeArguments("frob ")).toEqual([]);
    expect(completeArguments("frob x")).toEqual([]);
    expect(completeArguments("use x")).toEqual([]);
  });
});
