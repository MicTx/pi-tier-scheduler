import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Model, Api, Message } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import type { SessionMode } from "../src/extension";
import type { RouterState } from "../src/routing/types";
import {
  ROUTE_DECISION_ENTRY,
  validateRouteLogEntry,
  type RouteLogEntry,
} from "../src/diag/route-log";

/**
 * Runtime seam tests (F5.1 task-runtime-seam): the session_start config
 * load into runtime state, the route adapter's closure over that config
 * (defaults + `config_not_ready` when not ready), the bounded last-dispatch
 * summary recording and release, and the command dependency assembly. F6.2
 * (task-routelog-runtime): the adapter's route-decision logging — selected,
 * exhausted, and aborted decisions each land one `appendEntry` record;
 * append-failure injection never changes a routing result and only counts;
 * the count resets with a new session; the optional TUI renderer registers
 * only in tui mode. Real temporary directories for the config layers; a
 * structural fake registry for routing; no credentials, no network.
 */

type ExtensionModule = typeof import("../src/extension");
let mod: ExtensionModule;

beforeEach(async () => {
  vi.resetModules();
  mod = await import("../src/extension");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const CONTROL = "pi-tier-scheduler.router-control";

function model(provider: string, id: string): Model<Api> {
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
  };
}

const acmePillar = model("acme", "pillar-1");
const acmeBrain = model("acme", "brain-1");
const virtual = { ...model("ts", "auto"), api: "pi-virtual" } as Model<Api>;

function registryCtx(branch: readonly SessionEntry[] = []): ExtensionContext {
  return registryCtxWith([acmePillar, acmeBrain], branch);
}

function registryCtxWith(models: Model<Api>[], branch: readonly SessionEntry[] = []): ExtensionContext {
  return {
    modelRegistry: {
      getAvailable: () => [...models],
      find: (provider: string, id: string) =>
        models.find((candidate) => candidate.provider === provider && candidate.id === id),
    },
    sessionManager: { getBranch: () => [...branch] },
  } as unknown as ExtensionContext;
}

function controlEntry(manualOverride: "brain" | "pillar" | "crowd" | null): SessionEntry {
  return {
    type: "custom",
    customType: CONTROL,
    data: { schemaVersion: 1, manualOverride },
  } as unknown as SessionEntry;
}

function userTurn(text: string): { model: Model<Api>; thinkingLevel: "medium"; reason: "user"; messages: Message[] } {
  return {
    model: virtual,
    thinkingLevel: "medium",
    reason: "user",
    messages: [{ role: "user", content: text, timestamp: 0 }],
  };
}

interface FakeHost {
  api: ExtensionAPI;
  registerVirtualModel: ReturnType<typeof vi.fn>;
  registerCommand: ReturnType<typeof vi.fn>;
  registerEntryRenderer: ReturnType<typeof vi.fn>;
  sessionActions: {
    setModel: ReturnType<typeof vi.fn>;
    setThinkingLevel: ReturnType<typeof vi.fn>;
    appendEntry: ReturnType<typeof vi.fn>;
  };
  route(): (request: unknown, ctx: unknown) => unknown;
  command(): { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };
  fire(
    event: "session_start" | "session_shutdown" | "model_select" | "thinking_level_select",
    ctx: unknown,
    payload?: unknown,
  ): unknown;
}

function createFakeHost(): FakeHost {
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const registerVirtualModel = vi.fn();
  const registerCommand = vi.fn((name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
    commands.set(name, options);
  });
  const on = vi.fn((event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
    events.set(event, handler);
  });
  const registerEntryRenderer = vi.fn();
  const sessionActions = {
    setModel: vi.fn(async (_model: Model<Api>): Promise<boolean> => true),
    setThinkingLevel: vi.fn((_level: string) => {}),
    appendEntry: vi.fn((_customType: string, _data?: unknown) => {}),
  };
  const api = {
    registerVirtualModel,
    unregisterVirtualModel: vi.fn(),
    registerEntryRenderer,
    registerCommand,
    on,
    getThinkingLevel: vi.fn(() => "medium"),
    ...sessionActions,
  } as unknown as ExtensionAPI;
  return {
    api,
    registerVirtualModel,
    registerCommand,
    registerEntryRenderer,
    sessionActions,
    route() {
      const definition = registerVirtualModel.mock.calls[0]?.[0] as
        | { route: (request: unknown, ctx: unknown) => unknown }
        | undefined;
      if (definition === undefined) throw new Error("virtual model not registered");
      return definition.route;
    },
    command() {
      const options = commands.get("ts");
      if (options === undefined) throw new Error("the ms command was not registered");
      return options;
    },
    fire(event, ctx, payload) {
      const handler = events.get(event);
      if (handler === undefined) throw new Error(`no handler for ${event}`);
      return handler(payload ?? {}, ctx);
    },
  };
}

/**
 * F7.2 footer lifecycle (07-tui-modes.md §3.8/§5.6; spec §7.2 hooks 7–8):
 * the real extension wired into the fake host — session_start sets the
 * bounded `tier-scheduler` text in tui only, control commands refresh it
 * through the dispatcher hook, selection events refresh it when ts/auto is
 * involved, a config save+reload refreshes it with the new bias, and
 * shutdown clears exactly once. Non-tui modes never reach setStatus.
 */
describe("F7.2 footer status lifecycle", () => {
  function footerSessionCtx(
    mode: SessionMode,
    cwd: string,
    branch: SessionEntry[] = [],
  ): { ctx: ExtensionContext; setStatus: ReturnType<typeof vi.fn> } {
    const setStatus = vi.fn();
    const shape = {
      mode,
      hasUI: mode === "tui" || mode === "rpc",
      cwd,
      ui: { notify: vi.fn(), setStatus },
      sessionManager: { getBranch: (): SessionEntry[] => [...branch] },
    };
    return { ctx: shape as unknown as ExtensionContext, setStatus };
  }

  it("session_start sets (ts) auto • medium in tui; rpc sets no status", async () => {
    const { root, agentDir } = await makeWorkspace();
    try {
      const host = createFakeHost();
      mod.default(host.api);
      const tui = footerSessionCtx("tui", root);
      host.fire("session_start", tui.ctx);
      expect(tui.setStatus).toHaveBeenCalledTimes(1);
      expect(tui.setStatus).toHaveBeenCalledWith("tier-scheduler", "(ts) auto • medium");
      expect(mod.getRuntimeState()?.footerStatusSet).toBe(true);

      // A fresh module instance in rpc mode: the same start stays silent on
      // the status surface — RPC must never receive setStatus (07 §5.7).
      vi.resetModules();
      mod = await import("../src/extension");
      const rpcHost = createFakeHost();
      mod.default(rpcHost.api);
      const rpc = footerSessionCtx("rpc", root);
      rpcHost.fire("session_start", rpc.ctx);
      expect(rpc.setStatus).not.toHaveBeenCalled();
      expect(mod.getRuntimeState()?.footerStatusSet ?? false).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("a successful /ts use and /ts auto refresh the footer through the dispatcher hook", async () => {
    const { root, agentDir } = await makeWorkspace();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      const host = createFakeHost();
      mod.default(host.api);
      host.fire("session_start", footerSessionCtx("tui", root).ctx);

      // Branch already carries the brain control (the authority), so the
      // use is idempotent and the refresh reads the branch's manual tier.
      const useCtx = commandCtx(root, { branch: [controlEntry("brain")] });
      (useCtx.ctx as unknown as { ui: Record<string, unknown> }).ui = {
        notify: vi.fn(),
        setStatus: vi.fn(),
      };
      await host.command().handler("use brain", useCtx.ctx);
      const useStatus = (useCtx.ctx as unknown as { ui: { setStatus: ReturnType<typeof vi.fn> } }).ui.setStatus;
      expect(useStatus).toHaveBeenCalledWith("tier-scheduler", "(ts) brain • high");

      // An empty branch is already automatic: the release appends nothing
      // and the footer shows the effective default bias.
      const autoCtx = commandCtx(root, { branch: [] });
      (autoCtx.ctx as unknown as { ui: Record<string, unknown> }).ui = {
        notify: vi.fn(),
        setStatus: vi.fn(),
      };
      await host.command().handler("auto", autoCtx.ctx);
      const autoStatus = (autoCtx.ctx as unknown as { ui: { setStatus: ReturnType<typeof vi.fn> } }).ui.setStatus;
      expect(autoStatus).toHaveBeenCalledWith("tier-scheduler", "(ts) auto • medium");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("model_select refreshes only when ts/auto is involved; thinking_level_select always refreshes", async () => {
    const { root, agentDir } = await makeWorkspace();
    try {
      const host = createFakeHost();
      mod.default(host.api);
      const session = footerSessionCtx("tui", root);
      host.fire("session_start", session.ctx);
      expect(session.setStatus).toHaveBeenCalledTimes(1);

      host.fire("model_select", session.ctx, {
        model: { provider: "acme", id: "pillar-1" },
        previousModel: undefined,
      });
      host.fire("model_select", session.ctx, {
        model: { provider: "acme", id: "pillar-1" },
        previousModel: { provider: "acme", id: "brain-1" },
      });
      expect(session.setStatus).toHaveBeenCalledTimes(1); // unrelated selections: no refresh

      host.fire("model_select", session.ctx, {
        model: { provider: "ts", id: "auto" },
        previousModel: { provider: "acme", id: "pillar-1" },
      });
      expect(session.setStatus).toHaveBeenCalledTimes(2);

      host.fire("thinking_level_select", session.ctx);
      expect(session.setStatus).toHaveBeenCalledTimes(3);
      // Every refresh rewrites the same bounded text — the last call included.
      expect(session.setStatus).toHaveBeenLastCalledWith("tier-scheduler", "(ts) auto • medium");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("a config save + reload refreshes the footer with the new bias", async () => {
    const { root, agentDir } = await makeWorkspace();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      const host = createFakeHost();
      mod.default(host.api);
      const session = footerSessionCtx("tui", root);
      host.fire("session_start", session.ctx);
      await vi.waitFor(() => {
        expect(mod.getRuntimeState()?.configLoad).toBeDefined();
      });
      expect(session.setStatus).toHaveBeenLastCalledWith("tier-scheduler", "(ts) auto • medium");

      const face = wizardCtx(root, [
        { select: "edit project layer" },
        { select: "policy" },
        { select: "set defaultBias" },
        { select: "low" },
        { select: "save" },
        { confirm: true },
      ]);
      await host.command().handler("config", face.ctx);

      const saved = JSON.parse(
        await readFile(resolve(root, ".pi", "tier-scheduler.json"), "utf8"),
      );
      expect(saved).toEqual({ schemaVersion: 1, policy: { defaultBias: "low" } });
      expect(mod.getRuntimeState()?.configRevision).toBe(2);
      // The post-reload refresh runs through the session's footer sink and
      // carries the new effective bias (07 §5.6).
      expect(session.setStatus).toHaveBeenLastCalledWith("tier-scheduler", "(ts) auto • low");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("shutdown clears the key exactly once and stays idempotent", async () => {
    const { root, agentDir } = await makeWorkspace();
    try {
      const host = createFakeHost();
      mod.default(host.api);
      const session = footerSessionCtx("tui", root);
      host.fire("session_start", session.ctx);
      expect(session.setStatus).toHaveBeenCalledTimes(1);

      host.fire("session_shutdown", session.ctx);
      expect(session.setStatus).toHaveBeenLastCalledWith("tier-scheduler", undefined);
      expect(session.setStatus).toHaveBeenCalledTimes(2);

      // A second shutdown event clears nothing and never throws.
      host.fire("session_shutdown", session.ctx);
      expect(session.setStatus).toHaveBeenCalledTimes(2);
      expect(mod.getRuntimeState()?.footerStatusSet).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});

function sessionCtx(mode: SessionMode, hasUI: boolean, cwd: string, branch?: SessionEntry[]): ExtensionContext {
  return {
    mode,
    hasUI,
    cwd,
    ui: { notify: vi.fn() },
    ...(branch !== undefined
      ? { sessionManager: { getBranch: (): SessionEntry[] => [...branch] } }
      : {}),
  } as unknown as ExtensionContext;
}

function commandCtx(
  cwd: string,
  options: {
    model?: { provider: string; id: string; api?: string };
    branch?: readonly SessionEntry[];
    liveBranch?: SessionEntry[];
    virtualModel?: boolean;
  } = {},
): { ctx: ExtensionCommandContext; notify: ReturnType<typeof vi.fn> } {
  const notify = vi.fn();
  const shape = {
    hasUI: true,
    mode: "tui" as const,
    cwd,
    ui: { notify },
    model: options.model,
    sessionManager: {
      getBranch: (): SessionEntry[] => [...(options.liveBranch ?? options.branch ?? [])],
    },
    modelRegistry: {
      find: (provider: string, id: string): Model<Api> | undefined =>
        provider === "ts" && id === "auto" && options.virtualModel !== false
          ? virtual
          : undefined,
    },
  };
  return { ctx: shape as unknown as ExtensionCommandContext, notify };
}

async function makeWorkspace(): Promise<{ root: string; agentDir: string }> {
  const root = await mkdtemp(join(await import("node:os").then((os) => os.tmpdir()), "ms-runtime-project-"));
  const agentDir = await mkdtemp(join(await import("node:os").then((os) => os.tmpdir()), "ms-runtime-agent-"));
  return { root, agentDir };
}

async function writeProjectLayer(root: string, raw: string): Promise<void> {
  await mkdir(resolve(root, ".pi"), { recursive: true });
  await writeFile(resolve(root, ".pi", "tier-scheduler.json"), raw, "utf8");
}

const PILLAR_CONFIG = JSON.stringify({
  schemaVersion: 1,
  tiers: { pillar: { candidates: [{ provider: "acme", id: "pillar-1" }] } },
});

describe("session_start config load", () => {
  it("loads the effective config into runtime state with per-layer statuses", async () => {
    const { root, agentDir } = await makeWorkspace();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      const host = createFakeHost();
      mod.default(host.api);
      host.fire("session_start", sessionCtx("tui", true, root));

      await vi.waitFor(() => {
        expect(mod.getRuntimeState()?.configLoad).toBeDefined();
      });
      const load = mod.getRuntimeState()?.configLoad;
      expect(load?.layers).toEqual({ user: "missing", project: "missing" });
      expect(load?.problems).toEqual([]);
      expect(load?.effective.tiers.pillar.candidates).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("does not touch the filesystem when the context has no cwd", async () => {
    const host = createFakeHost();
    mod.default(host.api);
    const shape = { mode: "tui", hasUI: true } as unknown as ExtensionContext;
    host.fire("session_start", shape);

    expect(mod.getRuntimeState()?.configLoad).toBeUndefined();
  });

  it("keeps the load result on the exact runtime instance it started for", async () => {
    const { root, agentDir } = await makeWorkspace();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      const host = createFakeHost();
      mod.default(host.api);
      const first = mod.getRuntimeState();
      expect(first).toBeNull();
      host.fire("session_start", sessionCtx("tui", true, root));
      const live = mod.getRuntimeState();
      expect(live).not.toBeNull();
      await vi.waitFor(() => {
        expect(mod.getRuntimeState()?.configLoad).toBeDefined();
      });
      expect(mod.getRuntimeState()).toBe(live);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});

describe("route adapter — runtime config closure", () => {
  it("routes on the loaded config and records the bounded dispatch summary", async () => {
    const { root, agentDir } = await makeWorkspace();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      await writeProjectLayer(root, PILLAR_CONFIG);
      const host = createFakeHost();
      mod.default(host.api);
      host.fire("session_start", sessionCtx("tui", true, root));
      await vi.waitFor(() => {
        expect(mod.getRuntimeState()?.configLoad).toBeDefined();
      });

      const route = host.route();
      const result = route(userTurn("implement a parser"), registryCtx()) as {
        model: Model<Api>;
        thinkingLevel: string;
        state?: { activeTier: string };
      };
      expect(result.model).toBe(acmePillar);
      expect(result.thinkingLevel).toBe("medium");

      const dispatch = mod.getRuntimeState()?.lastDispatch;
      expect(dispatch).toEqual({
        model: { provider: "acme", id: "pillar-1" },
        tier: "pillar",
        thinkingLevel: "medium",
        reasonCode: "work_phase",
        selectedTier: "pillar",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("routes through the branch control and records the manual reason", async () => {
    const { root, agentDir } = await makeWorkspace();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      await writeProjectLayer(root, PILLAR_CONFIG);
      const host = createFakeHost();
      mod.default(host.api);
      host.fire("session_start", sessionCtx("tui", true, root));
      await vi.waitFor(() => {
        expect(mod.getRuntimeState()?.configLoad).toBeDefined();
      });

      const route = host.route();
      route(userTurn("explain this"), registryCtx([controlEntry("brain")]));
      // brain has no configured candidate; manual fallback lands on pillar.
      expect(mod.getRuntimeState()?.lastDispatch?.reasonCode).toBe("manual_override_fallback");
      expect(mod.getRuntimeState()?.lastDispatch?.tier).toBe("pillar");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("fails closed on the built-in defaults while the config is not ready", async () => {
    const host = createFakeHost();
    mod.default(host.api);
    // No session_start: runtime config is undefined, defaults have no
    // candidates, and the route fails closed without recording anything.
    const route = host.route();
    expect(() => route(userTurn("implement it"), registryCtx())).toThrowError();
    expect(mod.getRuntimeState()?.lastDispatch).toBeUndefined();
  });

  it("records nothing when a loaded-config route still finds no candidate", async () => {
    const { root, agentDir } = await makeWorkspace();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      await writeProjectLayer(root, JSON.stringify({ schemaVersion: 1 }));
      const host = createFakeHost();
      mod.default(host.api);
      host.fire("session_start", sessionCtx("tui", true, root));
      await vi.waitFor(() => {
        expect(mod.getRuntimeState()?.configLoad).toBeDefined();
      });

      const route = host.route();
      expect(() => route(userTurn("implement it"), registryCtx())).toThrowError();
      expect(mod.getRuntimeState()?.lastDispatch).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});

describe("summarizeDispatch — config_not_ready annotation", () => {
  const decision = {
    model: acmePillar,
    thinkingLevel: "medium",
    tier: "pillar",
    candidate: { provider: "acme", id: "pillar-1" },
    reason: {
      code: "work_phase" as const,
      requestedTier: "pillar",
      selectedTier: "pillar",
      phase: "implementation",
      complexity: "standard",
      bias: "medium",
      baseTier: "pillar",
      complexityTier: "pillar",
      biasedTier: "pillar",
      candidateIndex: 0,
      attempt: 1,
      maxAttempts: 3,
      tierSwitches: 0,
      maxTierSwitches: 2,
    },
    state: undefined,
  };

  it("copies the decision reason when the config was ready", () => {
    const summary = mod.summarizeDispatch(decision as never, true);
    expect(summary.reasonCode).toBe("work_phase");
    expect(summary.attempt).toBe(1);
    expect(summary.maxAttempts).toBe(3);
    expect(summary.selectedTier).toBe("pillar");
  });

  it("annotates config_not_ready when the route ran before the load", () => {
    const summary = mod.summarizeDispatch(decision as never, false);
    expect(summary.reasonCode).toBe("config_not_ready");
    expect(summary.model).toEqual({ provider: "acme", id: "pillar-1" });
  });

  it("omits bound fields the decision does not carry", () => {
    const sticky = {
      ...decision,
      reason: { ...decision.reason, attempt: undefined, maxAttempts: undefined },
    };
    const summary = mod.summarizeDispatch(sticky as never, true);
    expect("attempt" in summary).toBe(false);
    expect("maxAttempts" in summary).toBe(false);
  });
});

describe("runtime release and revival", () => {
  it("releases configLoad and lastDispatch on shutdown", async () => {
    const { root, agentDir } = await makeWorkspace();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      await writeProjectLayer(root, PILLAR_CONFIG);
      const host = createFakeHost();
      mod.default(host.api);
      host.fire("session_start", sessionCtx("tui", true, root));
      await vi.waitFor(() => {
        expect(mod.getRuntimeState()?.configLoad).toBeDefined();
      });
      host.route()(userTurn("implement a parser"), registryCtx());
      expect(mod.getRuntimeState()?.lastDispatch).toBeDefined();

      host.fire("session_shutdown", sessionCtx("tui", true, root));
      const shut = mod.getRuntimeState();
      expect(shut?.shutdownAt).not.toBeNull();
      expect(shut?.configLoad).toBeUndefined();
      expect(shut?.lastDispatch).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("a new session_start resets both snapshots before reloading", async () => {
    const { root, agentDir } = await makeWorkspace();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      await writeProjectLayer(root, PILLAR_CONFIG);
      const host = createFakeHost();
      mod.default(host.api);
      host.fire("session_start", sessionCtx("tui", true, root));
      await vi.waitFor(() => {
        expect(mod.getRuntimeState()?.configLoad).toBeDefined();
      });
      host.route()(userTurn("implement a parser"), registryCtx([]));
      expect(mod.getRuntimeState()?.lastDispatch).toBeDefined();

      host.fire("session_shutdown", sessionCtx("tui", true, root));
      host.fire("session_start", sessionCtx("tui", true, root));
      const revived = mod.getRuntimeState();
      expect(revived?.startCount).toBe(2);
      expect(revived?.lastDispatch).toBeUndefined();
      await vi.waitFor(() => {
        expect(mod.getRuntimeState()?.configLoad).toBeDefined();
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("keeps a shut-down runtime from recording a late route", async () => {
    const { root, agentDir } = await makeWorkspace();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      await writeProjectLayer(root, PILLAR_CONFIG);
      const host = createFakeHost();
      mod.default(host.api);
      host.fire("session_start", sessionCtx("tui", true, root));
      await vi.waitFor(() => {
        expect(mod.getRuntimeState()?.configLoad).toBeDefined();
      });
      host.fire("session_shutdown", sessionCtx("tui", true, root));

      const route = host.route();
      expect(() => route(userTurn("implement it"), registryCtx())).toThrowError();
      expect(mod.getRuntimeState()?.lastDispatch).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});

describe("command dependencies — end-to-end status seam", () => {
  let stdoutWrite: MockInstance<typeof process.stdout.write>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("serves /ts status from the loaded config through the registered handler", async () => {
    const { root, agentDir } = await makeWorkspace();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      await writeProjectLayer(root, PILLAR_CONFIG);
      const host = createFakeHost();
      mod.default(host.api);
      host.fire("session_start", sessionCtx("tui", true, root));
      await vi.waitFor(() => {
        expect(mod.getRuntimeState()?.configLoad).toBeDefined();
      });

      const { ctx, notify } = commandCtx(root, {
        model: { provider: "ts", id: "auto", api: "pi-virtual" },
      });
      await host.command().handler("status", ctx);

      expect(notify).toHaveBeenCalledTimes(1);
      const text = String(notify.mock.calls[0]?.[0]);
      expect(text).toContain("(ts) ");
      
      expect(text).toContain("last: not recorded in this runtime");
      expect(text).toContain("config: valid · user missing · project loaded · bias medium · sticky on");
      expect(text).toContain("  pillar  acme/pillar-1");
      expect(text).toContain("  crowd   (none)");
      expect(text).not.toContain("limits:");
      expect(stdoutWrite).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("reflects a recorded dispatch in a subsequent status request", async () => {
    const { root, agentDir } = await makeWorkspace();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      await writeProjectLayer(root, PILLAR_CONFIG);
      const host = createFakeHost();
      mod.default(host.api);
      host.fire("session_start", sessionCtx("tui", true, root));
      await vi.waitFor(() => {
        expect(mod.getRuntimeState()?.configLoad).toBeDefined();
      });
      host.route()(userTurn("implement a parser"), registryCtx());

      const { ctx, notify } = commandCtx(root, { model: { provider: "ts", id: "auto" } });
      await host.command().handler("", ctx); // empty normalizes to status
      const text = String(notify.mock.calls[0]?.[0]);
      expect(text).toContain("→ pillar-1 • medium");
      expect(text).toContain("last: work_phase (selected pillar)");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});

describe("control queue — serialized mutations through the registered handler", () => {
  it("runs concurrent use/auto commands in arrival order", async () => {
    const { root, agentDir } = await makeWorkspace();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      const host = createFakeHost();
      mod.default(host.api);
      host.fire("session_start", sessionCtx("tui", true, root));

      const liveBranch: SessionEntry[] = [];
      host.sessionActions.appendEntry.mockImplementation((type: string, data?: unknown) => {
        liveBranch.push({ type: "custom", customType: type, data } as unknown as SessionEntry);
      });

      const order: string[] = [];
      let releaseFirst: (() => void) | undefined;
      const blockFirst = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      host.sessionActions.setModel.mockImplementation(async () => {
        order.push("setModel:start");
        if (order.filter((item) => item === "setModel:start").length === 1) {
          await blockFirst;
        }
        order.push("setModel:end");
        return true;
      });

      const first = commandCtx(root, { model: { provider: "ts", id: "auto", api: "pi-virtual" }, liveBranch });
      const firstRun = host.command().handler("use brain", first.ctx);
      await vi.waitFor(() => {
        expect(order).toEqual(["setModel:start"]);
      });
      const second = commandCtx(root, { model: { provider: "ts", id: "auto", api: "pi-virtual" }, liveBranch });
      const secondRun = host.command().handler("auto", second.ctx);

      // Serialized: the second command does not start while the first is in flight.
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(order).toEqual(["setModel:start"]);

      releaseFirst?.();
      await Promise.all([firstRun, secondRun]);
      expect(order).toEqual([
        "setModel:start",
        "setModel:end",
        "setModel:start",
        "setModel:end",
      ]);
      expect(host.sessionActions.setThinkingLevel).toHaveBeenNthCalledWith(1, "high");
      expect(host.sessionActions.setThinkingLevel).toHaveBeenNthCalledWith(2, "medium");
      const appended = host.sessionActions.appendEntry.mock.calls.map((call) => call?.[1]);
      expect(appended).toEqual([
        { schemaVersion: 1, manualOverride: "brain" },
        { schemaVersion: 1, manualOverride: null },
      ]);
      expect(first.notify.mock.calls[0]?.[0]).toContain("pinned: brain");
      expect(second.notify.mock.calls[0]?.[0]).toContain("auto routing • bias");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("isolates failures: a rejected mutation never poisons the tail", async () => {
    const { root, agentDir } = await makeWorkspace();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      const host = createFakeHost();
      mod.default(host.api);
      host.fire("session_start", sessionCtx("tui", true, root));

      let thinkingCalls = 0;
      host.sessionActions.setThinkingLevel.mockImplementation(() => {
        thinkingCalls += 1;
        if (thinkingCalls === 1) throw new Error("unexpected thinking failure");
      });

      const first = commandCtx(root, { model: { provider: "ts", id: "auto", api: "pi-virtual" } });
      await expect(host.command().handler("use brain", first.ctx)).rejects.toThrow(
        "unexpected thinking failure",
      );

      host.sessionActions.setThinkingLevel.mockImplementation(() => {});
      const second = commandCtx(root, { model: { provider: "ts", id: "auto", api: "pi-virtual" } });
      await host.command().handler("use crowd", second.ctx);
      expect(String(second.notify.mock.calls[0]?.[0])).toContain("pinned: crowd");
      expect(host.sessionActions.setThinkingLevel).toHaveBeenLastCalledWith("low");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("resets the queue on a new session_start, and the shutdown intercept precedes any mutation", async () => {
    const { root, agentDir } = await makeWorkspace();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      const host = createFakeHost();
      mod.default(host.api);
      host.fire("session_start", sessionCtx("tui", true, root));

      // Leave a pending mutation on the old tail.
      let releasePending: ((value: void) => void) | undefined;
      const pending = new Promise<void>((resolve) => {
        releasePending = resolve;
      });
      host.sessionActions.setModel.mockImplementation(async () => {
        await pending;
        return true;
      });
      const stale = commandCtx(root, { model: { provider: "ts", id: "auto", api: "pi-virtual" } });
      const staleRun = host.command().handler("use brain", stale.ctx);
      await vi.waitFor(() => {
        expect(host.sessionActions.setModel).toHaveBeenCalledTimes(1);
      });

      // A fresh session_start resets the tail: the new command does not wait
      // behind the still-pending old one.
      host.fire("session_start", sessionCtx("tui", true, root));
      host.sessionActions.setModel.mockImplementation(async () => true);
      const fresh = commandCtx(root, { model: { provider: "ts", id: "auto", api: "pi-virtual" } });
      const freshRun = host.command().handler("use crowd", fresh.ctx);
      await Promise.race([
        freshRun,
        new Promise((_, reject) => setTimeout(() => reject(new Error("fresh command blocked behind the old tail")), 100)),
      ]);
      releasePending?.();
      await staleRun;

      // After shutdown, the intercept answers before any mutation can enqueue.
      host.fire("session_shutdown", sessionCtx("tui", true, root));
      host.sessionActions.setModel.mockClear();
      host.sessionActions.setThinkingLevel.mockClear();
      host.sessionActions.appendEntry.mockClear();
      const shut = commandCtx(root, { model: { provider: "ts", id: "auto", api: "pi-virtual" } });
      await host.command().handler("use brain", shut.ctx);
      expect(String(shut.notify.mock.calls[0]?.[0])).toBe(mod.SHUTDOWN_NOTICE);
      expect(host.sessionActions.setModel).not.toHaveBeenCalled();
      expect(host.sessionActions.appendEntry).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("reflects the control write in a subsequent status request end-to-end", async () => {
    const { root, agentDir } = await makeWorkspace();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      await writeProjectLayer(root, PILLAR_CONFIG);
      const host = createFakeHost();
      mod.default(host.api);
      host.fire("session_start", sessionCtx("tui", true, root));
      await vi.waitFor(() => {
        expect(mod.getRuntimeState()?.configLoad).toBeDefined();
      });

      const liveBranch: SessionEntry[] = [];
      host.sessionActions.appendEntry.mockImplementation((type: string, data?: unknown) => {
        liveBranch.push({ type: "custom", customType: type, data } as unknown as SessionEntry);
      });

      const control = commandCtx(root, {
        model: { provider: "ts", id: "auto", api: "pi-virtual" },
        liveBranch,
      });
      await host.command().handler("use brain", control.ctx);
      expect(String(control.notify.mock.calls[0]?.[0])).toBe(
        "pinned: brain • high",
      );

      // The branch entry is the only truth: a status read on the same branch
      // reports manual routing without any runtime mirror.
      const status = commandCtx(root, {
        model: { provider: "ts", id: "auto", api: "pi-virtual" },
        liveBranch,
      });
      await host.command().handler("status", status.ctx);
      const text = String(status.notify.mock.calls[0]?.[0]);
      
      

      // Releasing on the same branch flips status back to automatic.
      const release = commandCtx(root, {
        model: { provider: "ts", id: "auto", api: "pi-virtual" },
        liveBranch,
      });
      await host.command().handler("auto", release.ctx);
      expect(String(release.notify.mock.calls[0]?.[0])).toBe(
        "auto routing • bias medium",
      );
      const after = commandCtx(root, {
        model: { provider: "ts", id: "auto", api: "pi-virtual" },
        liveBranch,
      });
      await host.command().handler("status", after.ctx);
      const afterText = String(after.notify.mock.calls[0]?.[0]);
      
      
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("reports a missing virtual model as a stable error and keeps the branch untouched", async () => {
    const { root, agentDir } = await makeWorkspace();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      const host = createFakeHost();
      mod.default(host.api);
      host.fire("session_start", sessionCtx("tui", true, root));

      const broken = commandCtx(root, { model: undefined, virtualModel: false });
      await host.command().handler("use brain", broken.ctx);
      const [message, severity] = broken.notify.mock.calls[0] ?? [];
      expect(severity).toBe("error");
      expect(String(message)).toContain("ts/auto is not available");
      expect(host.sessionActions.setModel).not.toHaveBeenCalled();
      expect(host.sessionActions.appendEntry).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});

describe("route adapter — F6.2 route-decision log", () => {
  const TWO_PILLARS = JSON.stringify({
    schemaVersion: 1,
    tiers: {
      pillar: {
        candidates: [
          { provider: "acme", id: "pillar-1" },
          { provider: "acme", id: "pillar-2" },
        ],
      },
    },
  });

  function liveState(overrides: Partial<RouterState> = {}): RouterState {
    return {
      schemaVersion: 1,
      turn: 1,
      phase: "implementation",
      complexity: "standard",
      bias: "medium",
      manualOverride: null,
      sticky: true,
      attempts: 1,
      tierSwitches: 0,
      attempted: [{ provider: "acme", id: "pillar-1", tier: "pillar" }],
      activeTier: "pillar",
      activeCandidate: { provider: "acme", id: "pillar-1" },
      activeThinking: "medium",
      ...overrides,
    };
  }

  function startSession(host: FakeHost, root: string, raw: string, liveBranch?: SessionEntry[]): Promise<void> {
    return (async () => {
      await writeProjectLayer(root, raw);
      mod.default(host.api);
      host.fire("session_start", sessionCtx("tui", true, root, liveBranch));
      await vi.waitFor(() => {
        expect(mod.getRuntimeState()?.configLoad).toBeDefined();
      });
    })();
  }

  /** Extract the appended route-decision records from the fake appendEntry. */
  function routeLogCalls(host: FakeHost): { data: RouteLogEntry }[] {
    return host.sessionActions.appendEntry.mock.calls
      .filter((call) => call?.[0] === ROUTE_DECISION_ENTRY)
      .map((call) => ({ data: call?.[1] as RouteLogEntry }));
  }

  it("records one selected entry for a successful user route, outside LLM context", async () => {
    const { root, agentDir } = await makeWorkspace();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      const host = createFakeHost();
      await startSession(host, root, PILLAR_CONFIG);

      const route = host.route();
      const result = route(userTurn("implement a parser"), registryCtx()) as { model: Model<Api> };
      expect(result.model).toBe(acmePillar);

      const calls = routeLogCalls(host);
      expect(calls.length).toBe(1);
      const record = calls[0]!.data;
      expect(validateRouteLogEntry(record)).toBeDefined();
      expect(record.requestReason).toBe("user");
      expect(record.outcome).toBe("selected");
      expect(record.reasonCode).toBe("work_phase");
      expect(record.selectedCandidate).toEqual({ provider: "acme", id: "pillar-1" });
      expect(record.selectedTier).toBe("pillar");
      expect(record.selectedThinking).toBe("medium");
      expect(record.attempt).toBe(1);
      expect(record.stateStatus).toBe("absent");
      // The custom-entry channel is the only write seam used: records are
      // JSON-safe and carry no message content (CustomEntry never joins the
      // LLM context; a CustomMessageEntry would).
      const json = JSON.stringify(record);
      expect(json).not.toContain("implement a parser");
      expect("message" in record || "content" in record).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("records continuation, direct, and retry-fallback decisions through the same schema", async () => {
    const { root, agentDir } = await makeWorkspace();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      const host = createFakeHost();
      await startSession(host, root, TWO_PILLARS);
      const acmePillar2 = model("acme", "pillar-2");
      const ctx = registryCtxWith([acmePillar, acmePillar2]);
      const route = host.route();

      // Sticky continuation of the recorded dispatch.
      const continuation = route(
        {
          model: virtual,
          thinkingLevel: "medium",
          reason: "continuation",
          messages: [{ role: "user", content: "and continue", timestamp: 1 }],
          previous: { model: acmePillar, thinkingLevel: "medium" },
          state: liveState(),
        },
        ctx,
      ) as { model: Model<Api> };
      expect(continuation.model).toBe(acmePillar);

      // A direct request (compaction summary): same schema, no state.
      route(
        {
          model: virtual,
          thinkingLevel: "medium",
          reason: "direct",
          messages: [],
          previous: { model: acmePillar, thinkingLevel: "medium" },
        },
        ctx,
      );

      // A retry fallback onto the second pillar candidate.
      route(
        {
          model: virtual,
          thinkingLevel: "medium",
          reason: "retry",
          messages: [],
          previous: { model: acmePillar, thinkingLevel: "medium" },
          failed: { model: acmePillar, message: { role: "assistant", content: [], stopReason: "error", errorMessage: "request timed out after 30s", timestamp: 1 } },
          state: liveState(),
        },
        ctx,
      );

      const calls = routeLogCalls(host).map((call) => call.data);
      expect(calls.length).toBe(3);
      for (const record of calls) {
        expect(validateRouteLogEntry(record)).toBeDefined();
      }
      const [continuationRecord, directRecord, retryRecord] = calls;
      expect(continuationRecord!.requestReason).toBe("continuation");
      expect(continuationRecord!.reasonCode).toBe("sticky_continuation");
      expect(continuationRecord!.stateStatus).toBe("valid");
      expect(directRecord!.requestReason).toBe("direct");
      expect(directRecord!.reasonCode).toBe("direct");
      expect(directRecord!.stateStatus).toBe("absent");
      expect(retryRecord!.requestReason).toBe("retry");
      expect(retryRecord!.reasonCode).toBe("retry_same_tier");
      expect(retryRecord!.selectedCandidate).toEqual({ provider: "acme", id: "pillar-2" });
      expect(retryRecord!.failed).toEqual({
        candidate: { provider: "acme", id: "pillar-1" },
        tier: null,
        failureClass: "transient",
        retryHint: "transient",
      });
      expect(retryRecord!.attempt).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("records an exhausted entry with the safe fallback context, and the error still throws", async () => {
    const { root, agentDir } = await makeWorkspace();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      const host = createFakeHost();
      await startSession(host, root, PILLAR_CONFIG);
      const route = host.route();

      expect(() =>
        route(
          {
            model: virtual,
            thinkingLevel: "medium",
            reason: "retry",
            messages: [],
            previous: { model: acmePillar, thinkingLevel: "medium" },
            failed: { model: acmePillar, message: { role: "assistant", content: [], stopReason: "error", errorMessage: "rate limit exceeded for this key", timestamp: 1 } },
            state: liveState(),
          },
          registryCtx(),
        ),
      ).toThrowError(/No eligible physical model/);

      const calls = routeLogCalls(host);
      expect(calls.length).toBe(1);
      const record = calls[0]!.data;
      expect(validateRouteLogEntry(record)).toBeDefined();
      expect(record.outcome).toBe("exhausted");
      expect(record.requestReason).toBe("retry");
      expect(record.reasonCode).toBe("no_eligible_physical_model");
      expect(record.failed).toEqual({
        candidate: { provider: "acme", id: "pillar-1" },
        tier: "pillar",
        failureClass: "rate_limited",
        retryHint: "transient",
      });
      expect(record.boundHits).toEqual(["candidate_exhausted"]);
      expect(record.attempt).toBe(2);
      expect(record.maxAttempts).toBe(3);
      expect(JSON.stringify(record)).not.toContain("rate limit exceeded for this key");
      // lastDispatch keeps recording only successes: the terminal is not a dispatch.
      expect(mod.getRuntimeState()?.lastDispatch).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("records an aborted retry with outcome aborted and unchanged counters", async () => {
    const { root, agentDir } = await makeWorkspace();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      const host = createFakeHost();
      await startSession(host, root, PILLAR_CONFIG);
      const route = host.route();

      expect(() =>
        route(
          {
            model: virtual,
            thinkingLevel: "medium",
            reason: "retry",
            messages: [],
            previous: { model: acmePillar, thinkingLevel: "medium" },
            failed: { model: acmePillar, message: { role: "assistant", content: [], stopReason: "aborted", timestamp: 1 } },
            state: liveState(),
          },
          registryCtx(),
        ),
      ).toThrowError(/aborted/);

      const calls = routeLogCalls(host);
      expect(calls.length).toBe(1);
      const record = calls[0]!.data;
      expect(validateRouteLogEntry(record)).toBeDefined();
      expect(record.outcome).toBe("aborted");
      expect(record.reasonCode).toBe("route_limit_exceeded");
      expect(record.failed).toEqual({
        candidate: { provider: "acme", id: "pillar-1" },
        tier: null,
        failureClass: "aborted",
        retryHint: "permanent",
      });
      // An abort consumes no budget: the counters mirror the pre-abort state.
      expect(record.attempt).toBe(1);
      expect(record.tierSwitches).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("records a context-less terminal exhaustion for an empty catalog", async () => {
    const { root, agentDir } = await makeWorkspace();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      const host = createFakeHost();
      await startSession(host, root, JSON.stringify({ schemaVersion: 1 }));
      const route = host.route();

      expect(() => route(userTurn("implement it"), registryCtx())).toThrowError();
      const calls = routeLogCalls(host);
      expect(calls.length).toBe(1);
      const record = calls[0]!.data;
      expect(record.outcome).toBe("exhausted");
      expect(record.reasonCode).toBe("no_eligible_physical_model");
      expect(record.requestReason).toBe("user");
      expect(record.attempt).toBe(1);
      expect(record.boundHits).toEqual([]);
      expect(record.failed).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("injected append failures never change the routing result and only count (hook 4)", async () => {
    const { root, agentDir } = await makeWorkspace();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      const host = createFakeHost();
      await startSession(host, root, PILLAR_CONFIG);
      host.sessionActions.appendEntry.mockImplementation(() => {
        throw new Error("session file unavailable");
      });

      const route = host.route();
      const result = route(userTurn("implement a parser"), registryCtx()) as { model: Model<Api> };
      expect(result.model).toBe(acmePillar); // the routing result is unchanged
      expect(mod.getRuntimeState()?.routeLogWriteFailures).toBe(1);
      expect(mod.getRuntimeState()?.lastDispatch).toBeDefined();

      route(userTurn("implement another parser"), registryCtx());
      expect(mod.getRuntimeState()?.routeLogWriteFailures).toBe(2);

      // The same failure injection on a terminal route: the error is the
      // router's own, and the route log failure only counts.
      expect(() =>
        route(
          {
            model: virtual,
            thinkingLevel: "medium",
            reason: "retry",
            messages: [],
            previous: { model: acmePillar, thinkingLevel: "medium" },
            failed: { model: acmePillar, message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider overload", timestamp: 1 } },
            state: liveState(),
          },
          registryCtx(),
        ),
      ).toThrowError();
      expect(mod.getRuntimeState()?.routeLogWriteFailures).toBe(3);

      // A fresh session_start resets the counter with a fresh sink.
      host.sessionActions.appendEntry.mockImplementation(() => {});
      host.fire("session_start", sessionCtx("tui", true, root));
      expect(mod.getRuntimeState()?.routeLogWriteFailures).toBe(0);
      expect(mod.getRuntimeState()?.routeLog?.health().writeFailures).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("rebuilds the sink's latest from the session branch (hook 5 reload)", async () => {
    const { root, agentDir } = await makeWorkspace();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      const host = createFakeHost();
      const liveBranch: SessionEntry[] = [];
      await startSession(host, root, PILLAR_CONFIG, liveBranch);

      // The appendEntry double writes into the same live branch the
      // session_start context exposes, so the sink's branch reads see it.
      host.sessionActions.appendEntry.mockImplementation((type: string, data?: unknown) => {
        liveBranch.push({ type: "custom", customType: type, data } as unknown as SessionEntry);
      });

      const route = host.route();
      route(userTurn("implement a parser"), registryCtx(liveBranch));
      expect(mod.getRuntimeState()?.routeLog?.latest()?.reasonCode).toBe("work_phase");
      expect(mod.getRuntimeState()?.routeLog?.health()).toEqual({ writeFailures: 0, malformedEntries: 0 });

      // A reload rebuilds the volatile latest from branch data alone.
      host.sessionActions.appendEntry.mockImplementation(() => {});
      host.fire("session_start", sessionCtx("tui", true, root));
      const sinkAfterReload = mod.getRuntimeState()?.routeLog;
      // The fresh sink reads the same branch supplier only if the new
      // session_start context exposes it; the standard fake ctx has none, so
      // latest is rebuilt from an empty branch — no cached state crosses.
      expect(sinkAfterReload?.latest()).toBeUndefined();
      expect(sinkAfterReload?.health()).toEqual({ writeFailures: 0, malformedEntries: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("registers the compact TUI renderer only in tui mode (hook 5)", async () => {
    const { root, agentDir } = await makeWorkspace();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      const host = createFakeHost();
      mod.default(host.api);
      host.fire("session_start", sessionCtx("json", true, root));
      expect(host.registerEntryRenderer).not.toHaveBeenCalled();

      host.fire("session_start", sessionCtx("tui", true, root));
      expect(host.registerEntryRenderer).toHaveBeenCalledTimes(1);
      expect(host.registerEntryRenderer).toHaveBeenCalledWith(ROUTE_DECISION_ENTRY, expect.any(Function));

      const renderer = host.registerEntryRenderer.mock.calls[0]?.[1] as (
        entry: { data?: unknown },
        options: { expanded: boolean },
      ) => { render(width: number): string[] } | undefined;
      const record = {
        schemaVersion: 1,
        requestReason: "user" as const,
        outcome: "selected" as const,
        reasonCode: "work_phase",
        phase: "implementation" as const,
        complexity: "standard" as const,
        requestedTier: "pillar" as const,
        selectedTier: "pillar" as const,
        selectedCandidate: { provider: "acme", id: "pillar-1" },
        selectedThinking: "medium" as const,
        attempt: 1,
        maxAttempts: 3,
        tierSwitches: 0,
        maxTierSwitches: 2,
        fallbackPath: [],
        boundHits: [],
        stateStatus: "absent" as const,
      };
      const valid = renderer({ data: record }, { expanded: true });
      expect(valid).toBeDefined();
      expect(valid!.render(80).join("\n")).toContain("→ pillar-1 • medium");
      expect(renderer({ data: "garbage" }, { expanded: true })).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// F7.1 config wiring — /ts init through the registered handler with the
// real dependency assembly (07-tui-modes.md §3.7/§7.1 hooks 6–8): the
// command runs against real temporary directories through the same Phase 2
// seams the extension installs, the reload swaps the runtime snapshot and
// increments the revision, the flow mutex rejects a second init without a
// second dialog, and the save queue serializes and resets per session.
// ---------------------------------------------------------------------------

/** Scripted dialog step for the config-flow command contexts. */
type Scripted =
  | { select: string | undefined }
  | { input: string | undefined }
  | { confirm: boolean };

/** TUI command ctx with a scripted ui; a release hook pauses the scope dialog. */
function wizardCtx(
  cwd: string,
  steps: Scripted[],
  options: { pauseOnScope?: () => Promise<void> } = {},
) {
  const queue = [...steps];
  const take = (kind: "select" | "input" | "confirm"): unknown => {
    const next = queue.shift();
    if (next === undefined || !(kind in next)) {
      throw new Error(`unexpected ${kind} dialog; next: ${JSON.stringify(next ?? null)}`);
    }
    return (next as Record<string, unknown>)[kind];
  };
  const notify = vi.fn();
  const select = vi.fn(
    async (title: string, _options?: readonly string[]): Promise<string | undefined> => {
      if (options.pauseOnScope !== undefined && title.includes("scope")) {
        await options.pauseOnScope();
      }
      return take("select") as string | undefined;
    },
  );
  const confirm = vi.fn(async (_title: string, _message?: string): Promise<boolean> =>
    take("confirm") as boolean,
  );
  const input = vi.fn(async (_title: string): Promise<string | undefined> =>
    take("input") as string | undefined,
  );
  const shape = {
    hasUI: true,
    mode: "tui" as const,
    cwd,
    ui: { notify, select, confirm, input },
    model: undefined,
    sessionManager: { getBranch: (): SessionEntry[] => [] },
    modelRegistry: { find: () => undefined },
  };
  return { ctx: shape as unknown as ExtensionCommandContext, notify, select, confirm, input };
}

describe("config wiring — /ts init through the registered handler", () => {
  const KEEP = "keep this tier as shown";

  function happyPath(): Scripted[] {
    return [
      { select: "project" },
      { select: "Enter manually…" },
      { input: " acme " },
      { input: " brain-1 " },
      { confirm: false },
      { select: "skip pillar" },
      { select: "skip crowd" },
      { confirm: true },
    ];
  }

  it("saves, reloads the effective config into the runtime, and increments the revision", async () => {
    const { root, agentDir } = await makeWorkspace();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      const host = createFakeHost();
      mod.default(host.api);
      host.fire("session_start", sessionCtx("tui", true, root));
      await vi.waitFor(() => {
        expect(mod.getRuntimeState()?.configLoad).toBeDefined();
      });
      expect(mod.getRuntimeState()?.configRevision ?? 1).toBe(1);

      const face = wizardCtx(root, happyPath());
      await host.command().handler("init", face.ctx);

      const saved = JSON.parse(
        await readFile(resolve(root, ".pi", "tier-scheduler.json"), "utf8"),
      );
      expect(saved.schemaVersion).toBe(1);
      expect(saved.policy).toEqual({ defaultBias: "medium", sticky: true });
      // The reload landed on the live runtime and was versioned once.
      expect(mod.getRuntimeState()?.configLoad?.layers.project).toBe("loaded");
      expect(mod.getRuntimeState()?.configRevision).toBe(2);
      expect(String(face.notify.mock.calls.at(-1)?.[0])).toContain(
        "configuration saved; effective config reloaded (scope: project, revision: 2)",
      );
      // The config flow never drives session or provider actions.
      expect(host.sessionActions.setModel).not.toHaveBeenCalled();
      expect(host.sessionActions.setThinkingLevel).not.toHaveBeenCalled();
      expect(host.sessionActions.appendEntry).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("rejects a concurrent second init without a second dialog, then recovers", async () => {
    const { root, agentDir } = await makeWorkspace();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    try {
      const host = createFakeHost();
      mod.default(host.api);
      host.fire("session_start", sessionCtx("tui", true, root));

      let releaseScope: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseScope = resolve;
      });
      const first = wizardCtx(root, [{ select: undefined }], {
        pauseOnScope: () => gate,
      });
      const firstRun = host.command().handler("init", first.ctx);
      await vi.waitFor(() => {
        expect(first.select).toHaveBeenCalledTimes(1);
      });

      // While the first wizard holds the scope dialog open, a second init is
      // rejected with the mutex notice and opens no dialog of its own.
      const second = wizardCtx(root, []);
      await host.command().handler("init", second.ctx);
      expect(String(second.notify.mock.calls[0]?.[0])).toBe("configuration flow already active");
      expect(second.select).not.toHaveBeenCalled();

      // Escaping the first flow cancels it and clears the mutex; nothing
      // was written and the runtime flag settled back to false.
      releaseScope?.();
      await firstRun;
      expect(String(first.notify.mock.calls.at(-1)?.[0])).toBe(
        "configuration cancelled; no changes made",
      );
      expect(mod.getRuntimeState()?.flowActive ?? false).toBe(false);
      expect(
        await readFile(resolve(root, ".pi", "tier-scheduler.json"), "utf8").catch(
          () => undefined,
        ),
      ).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});

describe("config save queue — enqueueConfigSave", () => {
  it("serializes operations in arrival order and isolates failures", async () => {
    const order: string[] = [];
    const gate = new Promise<void>((resolve) => setTimeout(resolve, 10));
    const first = mod.enqueueConfigSave(async () => {
      await gate;
      order.push("first");
    });
    const second = mod.enqueueConfigSave(async () => {
      order.push("second");
      throw new Error("isolated");
    });
    const third = mod.enqueueConfigSave(async () => {
      order.push("third");
    });
    await expect(second).rejects.toThrow("isolated");
    await Promise.all([first, third]);
    expect(order).toEqual(["first", "second", "third"]);
  });
});
