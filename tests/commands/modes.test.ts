import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import { dispatch, type TsDispatchDependencies } from "../../src/commands/dispatch";
import { respond } from "../../src/ui/respond";
import type { EffectiveConfig } from "../../src/config/types";

/**
 * Mode matrix lock (05-commands.md §2.1/§7.1 hook 7/§7.2 hook 8): the /ts
 * family answers on `ui.notify` when a UI exists (tui/rpc) and on stderr only
 * when headless (json/print); stdout stays clean for the host protocol in
 * every mode, status never mutates session state, and the control commands
 * (use/auto) never touch terminal-only components in any mode.
 */

const CONTROL = "pi-tier-scheduler.router-control";

function controlEntry(manualOverride: "brain" | "pillar" | "crowd" | null): SessionEntry {
  return {
    type: "custom",
    customType: CONTROL,
    data: { schemaVersion: 1, manualOverride },
  } as unknown as SessionEntry;
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

function ctxFor(mode: "tui" | "rpc" | "json" | "print") {
  const hasUI = mode === "tui" || mode === "rpc";
  const notify = vi.fn();
  const setModel = vi.fn(async (): Promise<boolean> => true);
  const setThinkingLevel = vi.fn();
  const appendEntry = vi.fn();
  const find = vi.fn(
    (provider: string, id: string): Model<Api> | undefined =>
      provider === "ts" && id === "auto" ? virtualModel() : undefined,
  );
  const shape = {
    mode,
    hasUI,
    ui: { notify },
    model: { provider: "ts", id: "auto", api: "pi-virtual" },
    sessionManager: { getBranch: vi.fn(() => [] as SessionEntry[]) },
    modelRegistry: { find },
    setModel,
    setThinkingLevel,
    appendEntry,
  };
  return {
    mode,
    hasUI,
    ctx: shape as unknown as ExtensionCommandContext,
    notify,
    find,
    spies: { setModel, setThinkingLevel, appendEntry },
  };
}

/** Deps fake: the ctx-level spies double as the control action recording. */
function deps(spies: { setModel: (target: Model<Api>) => Promise<boolean>; setThinkingLevel: (level: ThinkingLevel) => void; appendEntry: (type: string, data?: unknown) => void }): TsDispatchDependencies {
  return {
    getThinkingLevel: (): ThinkingLevel => "medium",
    getConfig: () => ({
      effective: effectiveConfig(),
      problems: [],
      paths: { userPath: "/home/u/.pi/agent/tier-scheduler.json", projectPath: "/w/.pi/tier-scheduler.json" },
      layers: { user: "missing", project: "missing" },
    }),
    getLastDispatch: () => undefined,
    pi: {
      setModel: (target: Model<Api>): Promise<boolean> => spies.setModel(target),
      setThinkingLevel: (level: ThinkingLevel): void => spies.setThinkingLevel(level),
      appendEntry: (type: string, data?: unknown): void => spies.appendEntry(type, data),
    },
    enqueueControlMutation: <T>(operation: () => Promise<T>): Promise<T> => operation(),
    // F7.1 config seams: mode-guard paths only need the response channel.
    respond: respond,
    isRuntimeClosed: () => false,
    isFlowActive: () => false,
    // F7.2 seams: benign no-ops for the channel-matrix assertions.
    getManualOverride: () => null,
    refreshFooter: () => {},
    setReloadPending: () => {},
  } as unknown as TsDispatchDependencies;
}

describe("mode matrix — /ts status response channels", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  let stdoutWrite: MockInstance<typeof process.stdout.write>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["tui", "rpc"] as const)(
    "routes the status response through ui.notify in %s mode",
    async (mode) => {
      const { ctx, notify, spies } = ctxFor(mode);
      await dispatch("status", ctx, deps(spies));
      expect(notify).toHaveBeenCalledTimes(1);
      expect(String(notify.mock.calls[0]?.[0])).toContain("pi-tier-scheduler status");
      expect(notify.mock.calls[0]?.[1]).toBe("info");
      expect(consoleError).not.toHaveBeenCalled();
      expect(spies.setModel).not.toHaveBeenCalled();
      expect(spies.setThinkingLevel).not.toHaveBeenCalled();
      expect(spies.appendEntry).not.toHaveBeenCalled();
    },
  );

  it.each(["json", "print"] as const)(
    "routes the status response through stderr only in %s mode",
    async (mode) => {
      const { ctx, notify, spies } = ctxFor(mode);
      await dispatch("status", ctx, deps(spies));
      expect(notify).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(String(consoleError.mock.calls[0]?.[0])).toContain("pi-tier-scheduler status");
      expect(stdoutWrite).not.toHaveBeenCalled();
      expect(spies.setModel).not.toHaveBeenCalled();
      expect(spies.setThinkingLevel).not.toHaveBeenCalled();
      expect(spies.appendEntry).not.toHaveBeenCalled();
    },
  );

  it("never writes user-facing output to stdout in any mode", async () => {
    for (const mode of ["tui", "rpc", "json", "print"] as const) {
      const { ctx, spies } = ctxFor(mode);
      await dispatch("", ctx, deps(spies)); // empty normalizes to status
      await dispatch("frob", ctx, deps(spies)); // parse errors respond too
    }
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it("never resolves the model registry, a config file, or the router for status", async () => {
    for (const mode of ["tui", "rpc", "json", "print"] as const) {
      const { ctx, find, spies } = ctxFor(mode);
      await dispatch("status", ctx, deps(spies));
      expect(find).not.toHaveBeenCalled();
      expect(spies.appendEntry).not.toHaveBeenCalled();
    }
  });

  it("answers the control commands through the same channel contract", async () => {
    const tui = ctxFor("tui");
    await dispatch("use brain", tui.ctx, deps(tui.spies));
    expect(tui.notify).toHaveBeenCalledWith(
      "pinned: brain • high",
      "info",
    );
    expect(tui.spies.setModel).toHaveBeenCalledTimes(1);
    expect(tui.spies.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(tui.spies.appendEntry).toHaveBeenCalledWith(
      "pi-tier-scheduler.router-control",
      { schemaVersion: 1, manualOverride: "brain" },
    );

    const print = ctxFor("print");
    await dispatch("auto", print.ctx, deps(print.spies));
    await dispatch("init", print.ctx, deps(print.spies));
    expect(consoleError).toHaveBeenCalledTimes(2);
    expect(String(consoleError.mock.calls[0]?.[0])).toContain("auto routing • bias medium");
    expect(String(consoleError.mock.calls[1]?.[0])).toContain(
      "interactive configuration requires TUI mode; no changes made",
    );
    expect(print.notify).not.toHaveBeenCalled();
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it("keeps control responses off stdout and never touches terminal components in headless modes", async () => {
    for (const mode of ["json", "print"] as const) {
      const { ctx, notify, spies } = ctxFor(mode);
      await dispatch("use pillar", ctx, deps(spies));
      await dispatch("crowd", ctx, deps(spies));
      expect(notify).not.toHaveBeenCalled();
      // Control drives exactly the session actions, never a terminal component.
      expect(spies.setModel).toHaveBeenCalledTimes(2);
      expect(spies.appendEntry).toHaveBeenCalledTimes(2);
    }
    expect(
      consoleError.mock.calls.filter((call) => String(call?.[0]).includes("pinned:")),
    ).toHaveLength(4);
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it("routes control failure severities through the mode-appropriate channel", async () => {
    const rpc = ctxFor("rpc");
    const unauthenticated = { ...rpc.spies, setModel: vi.fn(async (): Promise<boolean> => false) };
    await dispatch("use brain", rpc.ctx, deps(unauthenticated));
    expect(rpc.notify.mock.calls[0]?.[1]).toBe("warning");

    const json = ctxFor("json");
    const brokenCtx = {
      ...json.ctx,
      modelRegistry: { find: () => undefined },
    } as unknown as ExtensionCommandContext;
    await dispatch("use brain", brokenCtx, deps(json.spies));
    const message = String(consoleError.mock.calls.at(-1)?.[0]);
    expect(message).toContain("ts/auto is not available");
  });
});

/**
 * F7.3 supplements (07-tui-modes.md §7.3 hooks 2–3): the json-mode init
 * guidance through the real dispatch channel, and the rpc full-ui-surface
 * lock — the whole /ts family in rpc touches only `notify`, never
 * select/confirm/input/custom/setStatus. Consolidated surface redundancy
 * with tests/ui/mode-matrix.test.ts is deliberate.
 */
describe("mode matrix — /ts init json channel + rpc ui full surface (F7.3)", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  let stdoutWrite: MockInstance<typeof process.stdout.write>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Full whitelisted ui surface as spies plus the doctor-capable deps. */
  function fullSurfaceCtx(mode: "tui" | "rpc" | "json" | "print") {
    const notify = vi.fn();
    const select = vi.fn(async (): Promise<string | undefined> => undefined);
    const confirm = vi.fn(async (): Promise<boolean> => false);
    const input = vi.fn(async (): Promise<string | undefined> => undefined);
    const setStatus = vi.fn();
    const custom = vi.fn();
    const setModel = vi.fn(async (): Promise<boolean> => true);
    const setThinkingLevel = vi.fn();
    const appendEntry = vi.fn();
    const find = vi.fn(
      (provider: string, id: string): Model<Api> | undefined =>
        provider === "ts" && id === "auto" ? virtualModel() : undefined,
    );
    const getAvailable = vi.fn((): Model<Api>[] => [virtualModel()]);
    const getProviderAuthStatus = vi.fn(() => ({ configured: true, source: "environment", label: "ok" }));
    const shape = {
      mode,
      hasUI: mode === "tui" || mode === "rpc",
      cwd: "/w",
      signal: undefined,
      ui: { notify, select, confirm, input, setStatus, custom },
      model: { provider: "ts", id: "auto", api: "pi-virtual" },
      sessionManager: { getBranch: vi.fn(() => [] as SessionEntry[]) },
      modelRegistry: { find, getAvailable, getProviderAuthStatus },
      setModel,
      setThinkingLevel,
      appendEntry,
    };
    return {
      ctx: shape as unknown as ExtensionCommandContext,
      ui: { notify, select, confirm, input, setStatus, custom },
      spies: { setModel, setThinkingLevel, appendEntry },
    };
  }

  function familyDeps(spies: {
    setModel: (target: Model<Api>) => Promise<boolean>;
    setThinkingLevel: (level: ThinkingLevel) => void;
    appendEntry: (type: string, data?: unknown) => void;
  }): TsDispatchDependencies {
    return {
      ...deps(spies),
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
    } as unknown as TsDispatchDependencies;
  }

  it("answers init through stderr only in json mode with the TUI-required notice", async () => {
    const face = fullSurfaceCtx("json");
    await dispatch("init", face.ctx, familyDeps(face.spies));
    expect(face.ui.notify).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0]?.[0])).toContain(
      "interactive configuration requires TUI mode; no changes made",
    );
    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(face.ui.select).not.toHaveBeenCalled();
  });

  it("rpc: the whole /ts family touches only notify on the ui surface", async () => {
    const face = fullSurfaceCtx("rpc");
    const tool = familyDeps(face.spies);
    for (const args of ["status", "use brain", "auto", "init", "config", "doctor"]) {
      await dispatch(args, face.ctx, tool);
    }
    expect(face.ui.notify.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(face.ui.select).not.toHaveBeenCalled();
    expect(face.ui.confirm).not.toHaveBeenCalled();
    expect(face.ui.input).not.toHaveBeenCalled();
    expect(face.ui.setStatus).not.toHaveBeenCalled();
    expect(face.ui.custom).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(stdoutWrite).not.toHaveBeenCalled();
  });
});
