import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { SessionMode, SessionRuntimeState } from "../src/extension";

// Runtime state is module-scoped by design: a reload builds a fresh
// module instance with clean state. Resetting the module registry
// before each test gives every case the same clean-instance guarantee.
type ExtensionModule = typeof import("../src/extension");
let mod: ExtensionModule;

beforeEach(async () => {
  vi.resetModules();
  mod = await import("../src/extension");
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Structural fakes: only the fields the skeleton actually touches. The
// casts document that these are deliberate test doubles, not real host
// objects (the Pi SDK exposes no constructor for ExtensionContext).
interface RegisteredOptions {
  description?: string;
  getArgumentCompletions?: (argumentPrefix: string) => unknown;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

function createFakeHost() {
  const commands = new Map<string, RegisteredOptions>();
  const eventHandlers = new Map<
    string,
    (event: unknown, ctx: unknown) => unknown
  >();
  const registerCommand = vi.fn((name: string, options: RegisteredOptions) => {
    commands.set(name, options);
  });
  const on = vi.fn(
    (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      eventHandlers.set(event, handler);
    },
  );
  const registerVirtualModel = vi.fn();
  const unregisterVirtualModel = vi.fn();
  const registerEntryRenderer = vi.fn();
  const getThinkingLevel = vi.fn(() => "medium");
  const api = {
    registerCommand,
    on,
    registerVirtualModel,
    unregisterVirtualModel,
    registerEntryRenderer,
    getThinkingLevel,
  } as unknown as ExtensionAPI;
  return {
    api,
    registerCommand,
    on,
    registerVirtualModel,
    unregisterVirtualModel,
    registerEntryRenderer,
    tsCommand(): RegisteredOptions {
      const options = commands.get("ts");
      if (!options) {
        throw new Error("the ms command was not registered");
      }
      return options;
    },
    fire(event: string, ctx: unknown): unknown {
      const handler = eventHandlers.get(event);
      if (!handler) {
        throw new Error(`no handler registered for ${event}`);
      }
      return handler({}, ctx);
    },
  };
}

function fakeCtx(mode: SessionMode, hasUI: boolean) {
  const notify = vi.fn();
  const shape = { mode, hasUI, ui: { notify } };
  return {
    ctx: shape as unknown as ExtensionContext,
    commandCtx: shape as unknown as ExtensionCommandContext,
    notify,
  };
}

describe("extension factory — registration surface", () => {
  it("registers ts/auto, the ms command, and the six lifecycle/selection/turn hooks, with no output", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdoutWrite: MockInstance<typeof process.stdout.write> = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const host = createFakeHost();

    mod.default(host.api);

    expect(host.registerVirtualModel).toHaveBeenCalledTimes(1);
    expect(host.registerVirtualModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "ts",
        id: "auto",
        name: "Auto",
        thinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max"],
        contextWindow: 128_000,
        maxTokens: 16_384,
        input: ["text", "image"],
      }),
    );
    expect(host.registerCommand).toHaveBeenCalledTimes(1);
    expect(host.registerCommand).toHaveBeenCalledWith(
      "ts",
      expect.objectContaining({
        description: expect.any(String),
        handler: expect.any(Function),
      }),
    );
    expect(host.on).toHaveBeenCalledTimes(6);
    expect(host.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(host.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
    // F7.2: the footer refresh hooks on selection events (07 §3.8).
    expect(host.on).toHaveBeenCalledWith("model_select", expect.any(Function));
    expect(host.on).toHaveBeenCalledWith("thinking_level_select", expect.any(Function));
    expect(consoleError).not.toHaveBeenCalled();
    expect(stdoutWrite).not.toHaveBeenCalled();
  });
});

describe("pure state helpers", () => {
  it("ensureSessionState creates initial state from null", () => {
    expect(mod.ensureSessionState(null, "print", 500)).toEqual({
      startedAt: 500,
      mode: "print",
      startCount: 1,
      shutdownAt: null,
      routeLogWriteFailures: 0,
    });
  });

  it("ensureSessionState revives a shut-down state", () => {
    const prior: SessionRuntimeState = {
      startedAt: 100,
      mode: "tui",
      startCount: 2,
      shutdownAt: 900,
      configLoad: undefined,
      lastDispatch: undefined,
      routeLogWriteFailures: 2,
      routeLog: undefined,
    };
    expect(mod.ensureSessionState(prior, "json", 1_000)).toEqual({
      startedAt: 1_000,
      mode: "json",
      startCount: 3,
      shutdownAt: null,
      routeLogWriteFailures: 0,
    });
  });

  it("markSessionShutdown marks once and is idempotent afterwards", () => {
    const live: SessionRuntimeState = {
      startedAt: 100,
      mode: "tui",
      startCount: 1,
      shutdownAt: null,
      configLoad: undefined,
      lastDispatch: undefined,
      routeLogWriteFailures: 1,
      routeLog: undefined,
    };
    const once = mod.markSessionShutdown(live, 200);
    expect(once.shutdownAt).toBe(200);
    // A second shutdown must not move the marker.
    expect(mod.markSessionShutdown(once, 300).shutdownAt).toBe(200);
  });
});

describe("session lifecycle", () => {
  it("repeated starts and shutdowns do not duplicate or double-unregister ts/auto", () => {
    const host = createFakeHost();
    mod.default(host.api);
    const { ctx } = fakeCtx("tui", true);

    host.fire("session_start", ctx);
    host.fire("session_start", ctx);
    host.fire("session_shutdown", ctx);
    host.fire("session_shutdown", ctx);

    expect(host.registerVirtualModel).toHaveBeenCalledTimes(1);
    expect(host.unregisterVirtualModel).toHaveBeenCalledTimes(1);

    host.fire("session_start", ctx);
    expect(host.registerVirtualModel).toHaveBeenCalledTimes(2);
  });

  it("session_start creates live state and stays silent", () => {
    const host = createFakeHost();
    mod.default(host.api);
    const { ctx, notify } = fakeCtx("tui", true);

    vi.spyOn(Date, "now").mockReturnValue(1_000);
    host.fire("session_start", ctx);

    expect(mod.getRuntimeState()).toEqual({
      startedAt: 1_000,
      mode: "tui",
      startCount: 1,
      shutdownAt: null,
      routeLogWriteFailures: 0,
      routeLog: expect.anything(),
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it("a second session_start increments startCount and adopts the new mode", () => {
    const host = createFakeHost();
    mod.default(host.api);
    const { ctx } = fakeCtx("tui", true);

    vi.spyOn(Date, "now").mockReturnValue(1_000);
    host.fire("session_start", ctx);
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    host.fire("session_start", fakeCtx("rpc", true).ctx);

    expect(mod.getRuntimeState()).toEqual({
      startedAt: 2_000,
      mode: "rpc",
      startCount: 2,
      shutdownAt: null,
      routeLogWriteFailures: 0,
      routeLog: expect.anything(),
    });
  });

  it("session_shutdown sets shutdownAt once and stays idempotent", () => {
    const host = createFakeHost();
    mod.default(host.api);
    const { ctx } = fakeCtx("tui", true);

    vi.spyOn(Date, "now").mockReturnValue(1_000);
    host.fire("session_start", ctx);
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    host.fire("session_shutdown", ctx);
    expect(mod.getRuntimeState()?.shutdownAt).toBe(2_000);

    vi.spyOn(Date, "now").mockReturnValue(3_000);
    host.fire("session_shutdown", ctx);
    const state = mod.getRuntimeState();
    expect(state?.shutdownAt).toBe(2_000);
    expect(state?.startCount).toBe(1);
  });

  it("session_shutdown without a prior start is a safe no-op", () => {
    const host = createFakeHost();
    mod.default(host.api);
    const { ctx } = fakeCtx("rpc", true);

    expect(() => host.fire("session_shutdown", ctx)).not.toThrow();
    expect(mod.getRuntimeState()).toBeNull();
  });

  it("a new session_start revives a shut-down runtime", () => {
    const host = createFakeHost();
    mod.default(host.api);
    const { ctx } = fakeCtx("tui", true);

    vi.spyOn(Date, "now").mockReturnValue(1_000);
    host.fire("session_start", ctx);
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    host.fire("session_shutdown", ctx);
    vi.spyOn(Date, "now").mockReturnValue(3_000);
    host.fire("session_start", ctx);

    expect(mod.getRuntimeState()).toEqual({
      startedAt: 3_000,
      mode: "tui",
      startCount: 2,
      shutdownAt: null,
      routeLogWriteFailures: 0,
      routeLog: expect.anything(),
    });
  });
});

describe("ms command handler", () => {
  it("answers the fixed shutdown notice after session_shutdown", async () => {
    const host = createFakeHost();
    mod.default(host.api);
    const { ctx, commandCtx, notify } = fakeCtx("tui", true);

    expect(mod.SHUTDOWN_NOTICE).toBe("tier-scheduler is shutting down");

    vi.spyOn(Date, "now").mockReturnValue(1_000);
    host.fire("session_start", ctx);
    host.fire("session_shutdown", ctx);

    await host.tsCommand().handler("status", commandCtx);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(mod.SHUTDOWN_NOTICE, "info");
  });

  it("answers the shutdown notice on stderr when headless", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const stdoutWrite: MockInstance<typeof process.stdout.write> = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const host = createFakeHost();
    mod.default(host.api);
    const { ctx, commandCtx, notify } = fakeCtx("print", false);

    vi.spyOn(Date, "now").mockReturnValue(1_000);
    host.fire("session_start", ctx);
    host.fire("session_shutdown", ctx);

    await host.tsCommand().handler("status", commandCtx);

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(mod.SHUTDOWN_NOTICE);
    expect(notify).not.toHaveBeenCalled();
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it("reaches the live command path while the runtime is live", async () => {
    const host = createFakeHost();
    mod.default(host.api);
    const { ctx, commandCtx, notify } = fakeCtx("tui", true);

    vi.spyOn(Date, "now").mockReturnValue(1_000);
    host.fire("session_start", ctx);

    await host.tsCommand().handler("status", commandCtx);

    expect(notify).toHaveBeenCalledTimes(1);
    const [message, severity] = notify.mock.calls[0] ?? [];
    expect(severity).toBe("info");
    // F5.1: status is live; without a loaded config the fixed not-loaded
    // line renders instead of a fabricated summary.
    expect(String(message)).toContain("pi-tier-scheduler status");
    expect(String(message)).toContain("config: not loaded (built-in defaults in effect)");
  });

  it("reaches the live command path even when no session_start has fired", async () => {
    const host = createFakeHost();
    mod.default(host.api);
    const { commandCtx, notify } = fakeCtx("rpc", true);

    await host.tsCommand().handler("status", commandCtx);

    expect(notify).toHaveBeenCalledTimes(1);
    const [message] = notify.mock.calls[0] ?? [];
    expect(String(message)).toContain("pi-tier-scheduler status");
  });
});
