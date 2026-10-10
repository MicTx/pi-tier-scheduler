import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { dispatch, type TsDispatchDependencies } from "../../src/commands/dispatch";
import { DOCTOR_USAGE_ERROR } from "../../src/diag/doctor";
import type { DoctorReport } from "../../src/diag/doctor";
import type { LoadResult } from "../../src/config/types";
import type { SessionMode } from "../../src/extension";

/**
 * F6.3 command-face mode tests (06-fallback-diagnostics.md §7.3 hooks 4–6):
 * the four Pi modes receive the same redacted report through the sanctioned
 * channel (notify with UI, stderr without), stdout stays parseable in
 * JSON/print, trailing arguments hit the stable usage error, the command is
 * read-only in every mode, and the extension runtime records `lastDoctor`
 * and resets it at session_start.
 */

const SECRET = "sk-test-secret-marker";

function fakeModel(provider: string, id: string): Model<Api> {
  return {
    id,
    name: `${provider}/${id}`,
    api: "openai-completions",
    provider,
    baseUrl: "https://api.example.test/v1",
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    headers: { authorization: `Bearer ${SECRET}` },
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

function allTiersLoadResult(): LoadResult {
  return {
    effective: {
      schemaVersion: 1,
      tiers: {
        brain: { candidates: [{ provider: "acme", id: "brain-1" }] },
        pillar: { candidates: [{ provider: "acme", id: "pillar-1" }] },
        crowd: { candidates: [{ provider: "acme", id: "crowd-1" }] },
      },
      policy: { defaultBias: "medium", sticky: true },
      retry: { maxAttemptsPerRequest: 3, maxTierSwitches: 2 },
      provenance: {},
    },
    problems: [],
    paths: { userPath: "/home/u/.pi/agent/tier-scheduler.json", projectPath: "/w/.pi/tier-scheduler.json" },
    layers: { user: "loaded", project: "loaded" },
  };
}

/** Command ctx covering every surface doctor touches, plus forbidden UI spies. */
function commandCtx(
  mode: SessionMode,
  hasUI: boolean,
  options: { branch?: readonly SessionEntry[] } = {},
) {
  const notify = vi.fn();
  const select = vi.fn();
  const input = vi.fn();
  const custom = vi.fn();
  const setStatus = vi.fn();
  const setModel = vi.fn(async (): Promise<boolean> => true);
  const setThinkingLevel = vi.fn();
  const appendEntry = vi.fn();
  const shape = {
    mode,
    hasUI,
    ui: { notify, select, input, custom, setStatus },
    model: { provider: "ts", id: "auto", api: "pi-virtual" } as Model<Api>,
    sessionManager: {
      getBranch: () => [...(options.branch ?? [])],
    },
    modelRegistry: {
      find: (provider: string, id: string) => fakeModel(provider, id),
      getAvailable: () => [fakeModel("acme", "brain-1"), fakeModel("acme", "pillar-1"), fakeModel("acme", "crowd-1")],
      getProviderAuthStatus: (provider: string) => ({ configured: true, source: "environment", label: SECRET }),
      setModel,
      setThinkingLevel,
      appendEntry,
    },
  };
  return {
    ctx: shape as unknown as ExtensionCommandContext,
    notify,
    select,
    input,
    custom,
    setStatus,
    setModel,
    setThinkingLevel,
    appendEntry,
  };
}

/** Deps fake: the doctor members plus the control/status members dispatch threads. */
function doctorDeps(options: { runtimeVersion?: string; writeFailures?: number; config?: LoadResult } = {}) {
  const actions = {
    setModel: vi.fn(async (_target: Model<Api>): Promise<boolean> => true),
    setThinkingLevel: vi.fn(),
    appendEntry: vi.fn(),
  };
  const recorded: DoctorReport[] = [];
  const deps = {
    getThinkingLevel: (): ThinkingLevel => "medium",
    getConfig: () => options.config ?? allTiersLoadResult(),
    getLastDispatch: () => undefined,
    pi: {
      setModel: (target: Model<Api>): Promise<boolean> => actions.setModel(target),
      setThinkingLevel: (level: ThinkingLevel): void => actions.setThinkingLevel(level),
      appendEntry: (type: string, data?: unknown): void => actions.appendEntry(type, data),
    },
    enqueueControlMutation: <T,>(operation: () => Promise<T>): Promise<T> => operation(),
    getRouteLogHealth: () => ({ writeFailures: options.writeFailures ?? 0 }),
    getDoctorApi: () => ({
      runtimeVersion: options.runtimeVersion ?? "1.0.4",
      apiProbes: {
        registerVirtualModel: () => true,
        registerCommand: () => true,
        appendEntry: () => true,
      },
    }),
    recordDoctorReport: (report: DoctorReport): void => {
      recorded.push(report);
    },
  } as unknown as TsDispatchDependencies;
  return { deps, actions, recorded };
}

describe("dispatch('doctor') — mode-safe response channel (hook 5)", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  let stdoutWrite: MockInstance<typeof process.stdout.write>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delivers the bounded report through notify in tui mode with info severity on pass", async () => {
    const built = commandCtx("tui", true);
    const { notify } = built;
    await dispatch("doctor", built.ctx, doctorDeps().deps);
    expect(notify).toHaveBeenCalledTimes(1);
    const [message, severity] = notify.mock.calls[0] ?? [];
    expect(severity).toBe("info");
    const text = String(message);
    expect(text).toContain("pi-tier-scheduler doctor");
    expect(text).toContain("result: pass");
    expect(text).toContain("compatibility  pass      Pi 1.0.4; required API surface present");
    expect(text).not.toContain(SECRET);
  });

  it("delivers the report through notify in rpc mode", async () => {
    const built = commandCtx("rpc", true);
    await dispatch("doctor", built.ctx, doctorDeps().deps);
    expect(built.notify).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("writes only to stderr in json mode, leaving stdout untouched and parseable", async () => {
    const built = commandCtx("json", false);
    await dispatch("doctor", built.ctx, doctorDeps().deps);
    expect(built.notify).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledTimes(1);
    const text = String(consoleError.mock.calls[0]?.[0]);
    expect(text).toContain("pi-tier-scheduler doctor");
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it("writes only to stderr in print mode", async () => {
    const built = commandCtx("print", false);
    await dispatch("doctor", built.ctx, doctorDeps().deps);
    expect(built.notify).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it("maps the report severity onto the notification type in every UI mode", async () => {
    const warning = commandCtx("tui", true);
    await dispatch("doctor", warning.ctx, doctorDeps({ writeFailures: 1 }).deps);
    expect(warning.notify.mock.calls[0]?.[1]).toBe("warning");

    const error = commandCtx("tui", true);
    await dispatch("doctor", error.ctx, doctorDeps({ runtimeVersion: "0.9.9" }).deps);
    expect(error.notify.mock.calls[0]?.[1]).toBe("error");
    expect(String(error.notify.mock.calls[0]?.[0])).toContain("below compatibility floor 1.0.4");
  });

  it("never opens a dialog or terminal-only UI in any mode (hook 5)", async () => {
    for (const [mode, hasUI] of [["tui", true], ["rpc", true], ["json", false], ["print", false]] as const) {
      const built = commandCtx(mode, hasUI);
      await dispatch("doctor", built.ctx, doctorDeps().deps);
      expect(built.select).not.toHaveBeenCalled();
      expect(built.input).not.toHaveBeenCalled();
      expect(built.custom).not.toHaveBeenCalled();
      expect(built.setStatus).not.toHaveBeenCalled();
    }
  });
});

describe("dispatch('doctor') — grammar and zero side effects (hooks 4/6)", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects trailing arguments through the stable usage error without collecting", async () => {
    const built = commandCtx("tui", true);
    const { deps, recorded } = doctorDeps();
    await dispatch("doctor now", built.ctx, deps);
    expect(built.notify).toHaveBeenCalledTimes(1);
    expect(built.notify).toHaveBeenCalledWith(DOCTOR_USAGE_ERROR, "warning");
    expect(recorded).toEqual([]);
    expect(built.appendEntry).not.toHaveBeenCalled();
  });

  it("is read-only: no append, no model or thinking mutation, no branch change", async () => {
    const branch: SessionEntry[] = [];
    const built = commandCtx("tui", true, { branch });
    const { deps, actions } = doctorDeps();
    const before = structuredClone(branch);
    await dispatch("doctor", built.ctx, deps);
    expect(actions.appendEntry).not.toHaveBeenCalled();
    expect(actions.setModel).not.toHaveBeenCalled();
    expect(actions.setThinkingLevel).not.toHaveBeenCalled();
    expect(built.setModel).not.toHaveBeenCalled();
    expect(built.setThinkingLevel).not.toHaveBeenCalled();
    expect(built.appendEntry).not.toHaveBeenCalled();
    expect(branch).toEqual(before);
  });

  it("records the report on the runtime accessor and is idempotent for one snapshot", async () => {
    const built = commandCtx("tui", true);
    const { deps, recorded } = doctorDeps();
    await dispatch("doctor", built.ctx, deps);
    await dispatch("doctor", built.ctx, deps);
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toEqual(recorded[1]);
    expect(recorded[0]?.severity).toBe("pass");
    expect(recorded[0]?.checks).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// Extension wiring: lastDoctor lifecycle (hook 6)
// ---------------------------------------------------------------------------

type ExtensionModule = typeof import("../../src/extension");
let mod: ExtensionModule;

beforeEach(async () => {
  vi.resetModules();
  mod = await import("../../src/extension");
});

function createFakeHost() {
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  const eventHandlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const registerCommand = vi.fn((name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
    commands.set(name, options);
  });
  const on = vi.fn((event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
    eventHandlers.set(event, handler);
  });
  const appendEntry = vi.fn();
  const api = {
    registerCommand,
    on,
    registerVirtualModel: vi.fn(),
    unregisterVirtualModel: vi.fn(),
    registerEntryRenderer: vi.fn(),
    getThinkingLevel: vi.fn(() => "medium"),
    setModel: vi.fn(async () => true),
    setThinkingLevel: vi.fn(),
    appendEntry,
  } as unknown as ExtensionAPI;
  return {
    api,
    appendEntry,
    tsCommand() {
      const options = commands.get("ts");
      if (!options) throw new Error("the ms command was not registered");
      return options;
    },
    fire(event: string, ctx: unknown): unknown {
      const handler = eventHandlers.get(event);
      if (!handler) throw new Error(`no handler registered for ${event}`);
      return handler({}, ctx);
    },
  };
}

function extensionCtx(mode: SessionMode, hasUI: boolean) {
  const built = commandCtx(mode, hasUI);
  return {
    ctx: built.ctx as unknown as ExtensionContext,
    commandCtx: built.ctx,
    notify: built.notify,
  };
}

describe("extension wiring — lastDoctor runtime record", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records the doctor report after a successful run and reports over notify", async () => {
    const host = createFakeHost();
    mod.default(host.api);
    const { ctx, commandCtx: command, notify } = extensionCtx("tui", true);

    host.fire("session_start", ctx);
    await host.tsCommand().handler("doctor", command);

    const lastDoctor = mod.getRuntimeState()?.lastDoctor;
    expect(lastDoctor).toBeDefined();
    expect(lastDoctor?.checks.map((check) => check.code)).toEqual([
      "config",
      "catalog",
      "credentials",
      "router_state",
      "route_log",
      "compatibility",
    ]);
    // The session_start load never completed (no cwd), so the honest config
    // verdict is the not-loaded warning, never a fabricated pass.
    const config = lastDoctor?.checks.find((check) => check.code === "config");
    expect(config?.severity).toBe("warning");
    expect(config?.details).toEqual(["config_not_loaded"]);
    expect(notify).toHaveBeenCalledTimes(1);
    const text = String(notify.mock.calls[0]?.[0]);
    expect(text).toContain("pi-tier-scheduler doctor");
    expect(text).not.toContain(SECRET);
    // Doctor itself appends nothing; the session_start lifecycle appends nothing either.
    expect(host.appendEntry).not.toHaveBeenCalled();
  });

  it("resets lastDoctor at session_start and keeps shutdown clean", async () => {
    const host = createFakeHost();
    mod.default(host.api);
    const { ctx, commandCtx: command } = extensionCtx("json", false);

    host.fire("session_start", ctx);
    await host.tsCommand().handler("doctor", command);
    expect(mod.getRuntimeState()?.lastDoctor).toBeDefined();

    host.fire("session_start", ctx);
    expect(mod.getRuntimeState()?.lastDoctor).toBeUndefined();

    await host.tsCommand().handler("doctor", command);
    expect(mod.getRuntimeState()?.lastDoctor).toBeDefined();

    host.fire("session_shutdown", ctx);
    expect(mod.getRuntimeState()?.lastDoctor).toBeUndefined();

    // After shutdown the fixed notice answers and nothing is recorded again.
    const recorded = mod.getRuntimeState();
    await host.tsCommand().handler("doctor", command);
    expect(mod.getRuntimeState()?.lastDoctor).toBeUndefined();
    expect(mod.getRuntimeState()).toBe(recorded);
    expect(String(consoleError.mock.calls.at(-1)?.[0])).toBe(mod.SHUTDOWN_NOTICE);
  });

  it("serves the wired runtime version through the doctor api accessor", async () => {
    const host = createFakeHost();
    mod.default(host.api);
    const { ctx, commandCtx: command } = extensionCtx("tui", true);
    host.fire("session_start", ctx);
    await host.tsCommand().handler("doctor", command);
    const compatibility = mod.getRuntimeState()?.lastDoctor?.checks.find(
      (check) => check.code === "compatibility",
    );
    // The installed peer satisfies the 1.0.4 floor; the exact string is
    // environment-owned, so assert the verdict, not the literal version.
    expect(compatibility?.severity === "pass" || compatibility?.severity === "warning").toBe(true);
    expect(String(compatibility?.summary)).toMatch(/^Pi .+; /);
  });
});
