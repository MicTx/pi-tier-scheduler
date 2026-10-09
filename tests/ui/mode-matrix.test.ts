import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import childProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { dispatch, type TsDispatchDependencies } from "../../src/commands/dispatch";
import { respond } from "../../src/ui/respond";
import type { LoadResult } from "../../src/config/types";
import type { DoctorReport } from "../../src/diag/doctor";
import { FOOTER_STATUS_KEY } from "../../src/ui/status";

/**
 * F7.3 consolidated four-mode matrix (07-tui-modes.md §5.7, §7.3 hooks 1–6;
 * spec §2.2 assumption 6): one fake ctx factory × tui/rpc/json/print × the
 * whole /ts family. This file owns *surface completeness* — every ui
 * method on the spy list, every command, every mode, plus the real
 * extension's startup silence. The per-command files keep their semantic
 * detail; assertion overlap with them is deliberate regression redundancy.
 *
 * Authoritative channel contract (§5.7):
 * - tui: built-in dialogs + notify only; commands never touch setStatus
 *   (the footer is owned by the runtime wiring, locked in runtime tests);
 * - rpc: notify only — no select/confirm/input/custom/setStatus;
 * - json/print: zero ctx.ui calls; stderr only; stdout stays host protocol;
 * - every mode: no config write outside a confirmed TUI flow, no catalog
 *   refresh, no credential probe on render paths, no timer/process.
 *
 * Startup silence (§7.3 hook 4) is asserted against the real extension on
 * a fake host: session_start performs the Phase 2 load with zero dialogs
 * and zero terminal calls in every mode; the single sanctioned surface is
 * the TUI footer write (F7.2 `ts:auto/<bias>`), which §5.7 lists under
 * "TUI status" — rpc/json/print never see setStatus.
 */

const MODES = ["tui", "rpc", "json", "print"] as const;
type MatrixMode = (typeof MODES)[number];

const SECRET = "sk-matrix-secret-marker";

function physicalModel(provider: string, id: string): Model<Api> {
  return {
    id,
    name: `${provider}/${id}`,
    api: "openai-completions",
    provider,
    baseUrl: "https://api.example.test/v1",
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    headers: { authorization: `Bearer ${SECRET}` },
    reasoning: true,
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

const VIRTUAL = { ...physicalModel("ts", "auto"), api: "pi-virtual" } as Model<Api>;

function matrixLoadResult(): LoadResult {
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
    layers: { user: "missing", project: "missing" },
  };
}

/**
 * The one matrix ctx factory: the full SDK ui whitelist as spies (plus the
 * terminal-only `custom` surface), registry probes, credential probe, and
 * session actions. `firstDialogResult` scripts the first dialog of a TUI
 * flow (undefined = escape → the flow cancels bounded, per 07 §5.8).
 */
function matrixCtx(mode: MatrixMode, options: { cwd?: string; firstDialogResult?: string | undefined } = {}) {
  const notify = vi.fn();
  const select = vi.fn(async (): Promise<string | undefined> => options.firstDialogResult);
  const confirm = vi.fn(async (): Promise<boolean> => false);
  const input = vi.fn(async (): Promise<string | undefined> => undefined);
  const setStatus = vi.fn();
  const custom = vi.fn();
  const find = vi.fn(
    (provider: string, id: string): Model<Api> | undefined =>
      provider === "ts" && id === "auto" ? VIRTUAL : physicalModel(provider, id),
  );
  const getAvailable = vi.fn((): Model<Api>[] => [
    physicalModel("acme", "brain-1"),
    physicalModel("acme", "pillar-1"),
    physicalModel("acme", "crowd-1"),
  ]);
  const refreshModels = vi.fn(async (): Promise<never[]> => []);
  const getProviderAuthStatus = vi.fn(() => ({
    configured: true,
    source: "environment",
    label: SECRET,
  }));
  const getBranch = vi.fn((): SessionEntry[] => []);
  const setModel = vi.fn(async (): Promise<boolean> => true);
  const setThinkingLevel = vi.fn();
  const appendEntry = vi.fn();
  const shape = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd: options.cwd ?? "/w",
    signal: undefined,
    ui: { notify, select, confirm, input, setStatus, custom },
    model: { provider: "ts", id: "auto", api: "pi-virtual" } as Model<Api>,
    sessionManager: { getBranch },
    modelRegistry: { find, getAvailable, refreshModels, getProviderAuthStatus },
    setModel,
    setThinkingLevel,
    appendEntry,
  };
  return {
    mode,
    ctx: shape as unknown as ExtensionCommandContext,
    ui: { notify, select, confirm, input, setStatus, custom },
    registry: { find, getAvailable, refreshModels, getProviderAuthStatus },
    actions: { setModel, setThinkingLevel, appendEntry },
  };
}

/**
 * Matrix deps covering the whole family. The persistence seams throw on
 * any call: outside a confirmed TUI flow no mode may probe a layer, save,
 * or set a pending-reload mark — reaching one fails the test, which is
 * the zero-config-write assertion. `respond` is the real responder so the
 * channel split is exercised, not simulated.
 */
function matrixDeps(): {
  deps: TsDispatchDependencies;
  doctorReports: DoctorReport[];
  flowLocks(): number;
} {
  const actions = {
    setModel: vi.fn(async (_target: Model<Api>): Promise<boolean> => true),
    setThinkingLevel: vi.fn((_level: ThinkingLevel): void => {}),
    appendEntry: vi.fn((_type: string, _data?: unknown): void => {}),
  };
  const doctorReports: DoctorReport[] = [];
  // Flow-mutex accounting: every setFlowActive(true) from a TUI flow must
  // be released by its finally block — the lock count never goes negative
  // and is back to zero after each dispatch.
  let flowLocks = 0;
  const deps: TsDispatchDependencies = {
    getThinkingLevel: (): ThinkingLevel => "medium",
    getConfig: () => matrixLoadResult(),
    getLastDispatch: () => undefined,
    pi: {
      setModel: (target: Model<Api>): Promise<boolean> => actions.setModel(target),
      setThinkingLevel: (level: ThinkingLevel): void => actions.setThinkingLevel(level),
      appendEntry: (type: string, data?: unknown): void => actions.appendEntry(type, data),
    },
    enqueueControlMutation: <T>(operation: () => Promise<T>): Promise<T> => operation(),
    getRouteLogHealth: () => ({ writeFailures: 0 }),
    getDoctorApi: () => ({
      runtimeVersion: "1.0.4",
      apiProbes: {
        registerVirtualModel: () => true,
        registerCommand: () => true,
        appendEntry: () => true,
      },
    }),
    recordDoctorReport: (report: DoctorReport): void => {
      doctorReports.push(report);
    },
    respond,
    readConfigLayerForEdit: async () => {
      throw new Error("matrix: layer probe escaped its TUI flow");
    },
    loadConfig: async () => {
      throw new Error("matrix: config reload escaped its TUI flow");
    },
    saveConfigFile: async () => {
      throw new Error("matrix: no mode may write a configuration file here");
    },
    isRuntimeClosed: () => false,
    isFlowActive: () => false,
    setFlowActive: (active) => {
      flowLocks += active ? 1 : -1;
      expect(flowLocks, "flow mutex must release in finally").toBeGreaterThanOrEqual(0);
    },
    getConfigRevision: () => 1,
    applyConfigReload: () => ({ applied: false, revision: 1 }),
    enqueueConfigSave: <T>(operation: () => Promise<T>): Promise<T> => operation(),
    getManualOverride: () => null,
    refreshFooter: () => {}, // footer wiring is owned by runtime tests
    setReloadPending: () => {
      throw new Error("matrix: no path here may mark a pending reload");
    },
  };
  return { deps, doctorReports, flowLocks: () => flowLocks };
}

/** The /ts family as dispatch inputs; every member runs in every mode. */
const FAMILY: readonly { label: string; args: string }[] = [
  { label: "status", args: "status" },
  { label: "use", args: "use brain" },
  { label: "auto", args: "auto" },
  { label: "init", args: "init" },
  { label: "config", args: "config" },
  { label: "doctor", args: "doctor" },
];

describe("mode matrix — /ts family channels (hooks 1–3, 6)", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  let stdoutWrite: MockInstance<typeof process.stdout.write>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(MODES)("%s: the whole family answers on the sanctioned channel only", async (mode) => {
    for (const cmd of FAMILY) {
      consoleError.mockClear();
      stdoutWrite.mockClear();
      const face = matrixCtx(mode); // first dialog undefined → TUI flows cancel bounded
      const tool = matrixDeps();
      await dispatch(cmd.args, face.ctx, tool.deps);
      expect(tool.flowLocks(), `mode=${mode} cmd=${cmd.label}: mutex released`).toBe(0);

      if (mode === "tui" || mode === "rpc") {
        expect(
          face.ui.notify.mock.calls.length,
          `mode=${mode} cmd=${cmd.label}: notify channel expected`,
        ).toBeGreaterThanOrEqual(1);
        expect(consoleError, `mode=${mode} cmd=${cmd.label}: stderr must stay silent with UI`).not
          .toHaveBeenCalled();
      } else {
        expect(face.ui.notify, `mode=${mode} cmd=${cmd.label}: ctx.ui must stay untouched`).not
          .toHaveBeenCalled();
        expect(
          consoleError.mock.calls.length,
          `mode=${mode} cmd=${cmd.label}: stderr channel expected`,
        ).toBeGreaterThanOrEqual(1);
      }
      expect(stdoutWrite, `mode=${mode} cmd=${cmd.label}: stdout is host protocol`).not.toHaveBeenCalled();

      // ui whitelist: rpc sees notify only; json/print see nothing; tui
      // opens dialogs but never setStatus/custom from a command body.
      if (mode === "rpc") {
        expect(face.ui.select).not.toHaveBeenCalled();
        expect(face.ui.confirm).not.toHaveBeenCalled();
        expect(face.ui.input).not.toHaveBeenCalled();
        expect(face.ui.setStatus).not.toHaveBeenCalled();
        expect(face.ui.custom).not.toHaveBeenCalled();
      } else if (mode === "json" || mode === "print") {
        expect(face.ui.select).not.toHaveBeenCalled();
        expect(face.ui.confirm).not.toHaveBeenCalled();
        expect(face.ui.input).not.toHaveBeenCalled();
        expect(face.ui.setStatus).not.toHaveBeenCalled();
        expect(face.ui.custom).not.toHaveBeenCalled();
      } else {
        expect(face.ui.setStatus).not.toHaveBeenCalled();
        expect(face.ui.custom).not.toHaveBeenCalled();
      }
      expect(
        Object.hasOwn(face.ctx.ui as object, "onTerminalInput"),
        `mode=${mode}: ctx.ui never exposes onTerminalInput to extensions`,
      ).toBe(false);

      // No response text ever carries the credential marker.
      for (const call of face.ui.notify.mock.calls) {
        expect(String(call?.[0])).not.toContain(SECRET);
      }
      for (const call of consoleError.mock.calls) {
        expect(String(call?.[0])).not.toContain(SECRET);
      }
    }
  });

  it("parse errors stay off stdout and on the mode channel in every mode", async () => {
    for (const mode of MODES) {
      consoleError.mockClear();
      stdoutWrite.mockClear();
      const face = matrixCtx(mode);
      const tool = matrixDeps();
      await dispatch("frob", face.ctx, tool.deps);
      if (mode === "tui" || mode === "rpc") {
        expect(face.ui.notify).toHaveBeenCalledTimes(1);
        expect(face.ui.notify.mock.calls[0]?.[1]).toBe("warning");
        expect(consoleError).not.toHaveBeenCalled();
      } else {
        expect(face.ui.notify).not.toHaveBeenCalled();
        expect(consoleError).toHaveBeenCalledTimes(1);
      }
      expect(stdoutWrite).not.toHaveBeenCalled();
    }
  });
});

describe("mode matrix — trailing-argument consistency (hook 5)", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  let stdoutWrite: MockInstance<typeof process.stdout.write>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("every subcommand rejects trailing arguments with one identical warning in all four modes", async () => {
    const trailing: readonly { label: string; args: string }[] = [
      { label: "status", args: "status extra" },
      { label: "use", args: "use brain extra" },
      { label: "auto", args: "auto extra" },
      { label: "init", args: "init extra" },
      { label: "config", args: "config extra" },
      { label: "doctor", args: "doctor extra" },
      { label: "unknown-head", args: "frob" },
    ];
    for (const cmd of trailing) {
      const seen = new Map<string, { severity: unknown }>();
      for (const mode of MODES) {
        consoleError.mockClear();
        const face = matrixCtx(mode);
        const tool = matrixDeps();
        await dispatch(cmd.args, face.ctx, tool.deps);

        const message =
          mode === "tui" || mode === "rpc"
            ? String(face.ui.notify.mock.calls[0]?.[0])
            : String(consoleError.mock.calls[0]?.[0]);
        const severity =
          mode === "tui" || mode === "rpc" ? face.ui.notify.mock.calls[0]?.[1] : "warning";
        expect(message, `mode=${mode} cmd=${cmd.label}`).toMatch(
          /^invalid arguments for '|^unknown command '/,
        );
        expect(severity, `mode=${mode} cmd=${cmd.label}`).toBe("warning");
        const previous = seen.get(message);
        if (previous === undefined) {
          seen.set(message, { severity });
        } else {
          expect(previous.severity, `cmd=${cmd.label}: identical rejection across modes`).toBe(severity);
        }
        // Exactly one response, no dialog opened anywhere on a usage error.
        expect(face.ui.select).not.toHaveBeenCalled();
        expect(face.ui.confirm).not.toHaveBeenCalled();
        expect(face.ui.input).not.toHaveBeenCalled();
      }
      expect(seen.size, `cmd=${cmd.label}: one stable message across all modes`).toBe(1);
    }
    expect(stdoutWrite).not.toHaveBeenCalled();
  });
});

describe("mode matrix — zero-resource render paths (hook 6)", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  let stdoutWrite: MockInstance<typeof process.stdout.write>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(MODES)("%s: render commands resolve no model, catalog, or credential", async (mode) => {
    const face = matrixCtx(mode);
    const tool = matrixDeps();
    await dispatch("status", face.ctx, tool.deps);
    await dispatch("init", face.ctx, tool.deps);
    await dispatch("config", face.ctx, tool.deps);
    // Rendering configuration never needs the registry (doctor is the
    // sanctioned reader and is covered by its own file).
    expect(face.registry.find).not.toHaveBeenCalled();
    expect(face.registry.getAvailable).not.toHaveBeenCalled();
  });

  it.each(MODES)("%s: no command refreshes a provider catalog; non-doctor commands never probe credentials", async (mode) => {
    const face = matrixCtx(mode);
    const tool = matrixDeps();
    for (const cmd of FAMILY) {
      if (cmd.label !== "doctor") {
        await dispatch(cmd.args, face.ctx, tool.deps);
      }
    }
    expect(face.registry.refreshModels, `mode=${mode}: catalog refresh is never a command side effect`).not
      .toHaveBeenCalled();
    expect(face.registry.getProviderAuthStatus, `mode=${mode}: only doctor reads auth status`).not
      .toHaveBeenCalled();
    // Doctor reads credential *presence* by design (F6.3); it never leaks
    // the credential value itself onto any channel.
    await dispatch("doctor", face.ctx, tool.deps);
    expect(face.registry.refreshModels).not.toHaveBeenCalled();
    for (const call of face.ui.notify.mock.calls) {
      expect(String(call?.[0])).not.toContain(SECRET);
    }
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it("no mode starts a timer or a child process for any family command", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "setImmediate"] });
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    const immediateSpy = vi.spyOn(globalThis, "setImmediate");
    const spawnSpy = vi.spyOn(childProcess, "spawn");
    const execSpy = vi.spyOn(childProcess, "exec");
    const forkSpy = vi.spyOn(childProcess, "fork");
    try {
      for (const mode of MODES) {
        const face = matrixCtx(mode);
        const tool = matrixDeps();
        for (const cmd of FAMILY) {
          await dispatch(cmd.args, face.ctx, tool.deps);
        }
        expect(timeoutSpy, `mode=${mode}`).not.toHaveBeenCalled();
        expect(intervalSpy, `mode=${mode}`).not.toHaveBeenCalled();
        expect(immediateSpy, `mode=${mode}`).not.toHaveBeenCalled();
      }
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(execSpy).not.toHaveBeenCalled();
      expect(forkSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Startup silence: the real extension module on a fake host, one session
// per mode (07-tui-modes.md §7.3 hook 4). The sanctioned TUI footer write
// at session_start is the F7.2 behavior (§5.7 "TUI status"); everything
// else — dialogs, notify, terminal calls — stays at zero in every mode.
// ---------------------------------------------------------------------------

type ExtensionModule = typeof import("../../src/extension");
let mod: ExtensionModule;

interface StartupHost {
  api: ExtensionAPI;
  registerEntryRenderer: ReturnType<typeof vi.fn>;
  fire(event: "session_start" | "session_shutdown", ctx: unknown): unknown;
}

function createStartupHost(): StartupHost {
  const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const registerEntryRenderer = vi.fn();
  const api = {
    registerVirtualModel: vi.fn(),
    unregisterVirtualModel: vi.fn(),
    registerEntryRenderer,
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      events.set(event, handler);
    }),
    getThinkingLevel: vi.fn(() => "medium"),
    setModel: vi.fn(async (): Promise<boolean> => true),
    setThinkingLevel: vi.fn(),
    appendEntry: vi.fn(),
  } as unknown as ExtensionAPI;
  return {
    api,
    registerEntryRenderer,
    fire(event, ctx) {
      const handler = events.get(event);
      if (handler === undefined) throw new Error(`no handler for ${event}`);
      return handler({}, ctx);
    },
  };
}

function startupCtx(mode: MatrixMode, cwd: string) {
  const ui = {
    notify: vi.fn(),
    select: vi.fn(async (): Promise<string | undefined> => undefined),
    confirm: vi.fn(async (): Promise<boolean> => false),
    input: vi.fn(async (): Promise<string | undefined> => undefined),
    setStatus: vi.fn(),
    custom: vi.fn(),
  };
  const registry = {
    find: vi.fn((): Model<Api> | undefined => undefined),
    getAvailable: vi.fn((): Model<Api>[] => []),
    refreshModels: vi.fn(async (): Promise<never[]> => []),
  };
  const shape = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd,
    ui,
    sessionManager: { getBranch: vi.fn((): SessionEntry[] => []) },
    modelRegistry: registry,
  };
  return { ctx: shape as unknown as ExtensionContext, ui, registry };
}

describe("mode matrix — session_start silence (real extension, hook 4)", () => {
  let home: string;
  let project: string;
  let consoleError: ReturnType<typeof vi.spyOn>;
  let stdoutWrite: MockInstance<typeof process.stdout.write>;

  beforeEach(async () => {
    vi.resetModules();
    mod = await import("../../src/extension");
    home = await mkdtemp(join(tmpdir(), "ms-matrix-home-"));
    project = await mkdtemp(join(tmpdir(), "ms-matrix-project-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", home);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  async function seedProjectLayer(raw: string): Promise<void> {
    await mkdir(resolve(project, ".pi"), { recursive: true });
    await writeFile(resolve(project, ".pi", "tier-scheduler.json"), raw, "utf8");
  }

  function expectDialogSilence(face: ReturnType<typeof startupCtx>, label: string): void {
    expect(face.ui.notify, `${label}: startup never notifies`).not.toHaveBeenCalled();
    expect(face.ui.select, `${label}: startup never opens a dialog`).not.toHaveBeenCalled();
    expect(face.ui.confirm, `${label}: startup never opens a dialog`).not.toHaveBeenCalled();
    expect(face.ui.input, `${label}: startup never opens a dialog`).not.toHaveBeenCalled();
    expect(face.ui.custom, `${label}: startup never renders a component`).not.toHaveBeenCalled();
  }

  it.each(MODES)("%s: a valid config loads silently; only TUI writes the footer", async (mode) => {
    await seedProjectLayer(
      JSON.stringify({
        schemaVersion: 1,
        tiers: { pillar: { candidates: [{ provider: "acme", id: "pillar-1" }] } },
      }),
    );
    const host = createStartupHost();
    mod.default(host.api);
    const face = startupCtx(mode, project);

    host.fire("session_start", face.ctx);
    await vi.waitFor(() => {
      expect(mod.getRuntimeState()?.configLoad).toBeDefined();
    });

    expect(mod.getRuntimeState()?.configLoad?.layers.project).toBe("loaded");
    expectDialogSilence(face, `mode=${mode}`);
    if (mode === "tui") {
      // The one sanctioned startup surface (F7.2 footer, §5.7 "TUI status").
      expect(face.ui.setStatus).toHaveBeenCalledTimes(1);
      expect(face.ui.setStatus).toHaveBeenCalledWith(FOOTER_STATUS_KEY, "ts:auto/medium");
    } else {
      expect(face.ui.setStatus, `mode=${mode}: rpc/json/print never see setStatus`).not.toHaveBeenCalled();
    }
    // Startup reads configuration files only — never the registry.
    expect(face.registry.find).not.toHaveBeenCalled();
    expect(face.registry.getAvailable).not.toHaveBeenCalled();
    expect(face.registry.refreshModels).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(stdoutWrite).not.toHaveBeenCalled();
    // The route-log renderer registers in TUI only.
    expect(host.registerEntryRenderer).toHaveBeenCalledTimes(mode === "tui" ? 1 : 0);
  });

  it.each(MODES)("%s: a malformed config surfaces only through diagnostics", async (mode) => {
    await seedProjectLayer("{ not json");
    const host = createStartupHost();
    mod.default(host.api);
    const face = startupCtx(mode, project);

    host.fire("session_start", face.ctx);
    await vi.waitFor(() => {
      expect(mod.getRuntimeState()?.configLoad).toBeDefined();
    });

    const load = mod.getRuntimeState()?.configLoad;
    expect(load?.layers.project).toBe("invalid");
    expect(load?.problems.length ?? 0).toBeGreaterThan(0);
    // The problem stays on the diagnostics surface: no dialog, no notify,
    // no stderr/stdout noise at startup in any mode.
    expectDialogSilence(face, `mode=${mode} malformed`);
    expect(face.ui.setStatus, `mode=${mode}`).toHaveBeenCalledTimes(mode === "tui" ? 1 : 0);
    expect(consoleError).not.toHaveBeenCalled();
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it.each(MODES)("%s: repeated lifecycle events stay idempotent (§5.8)", async (mode) => {
    const host = createStartupHost();
    mod.default(host.api);
    const face = startupCtx(mode, project);

    host.fire("session_start", face.ctx);
    await vi.waitFor(() => {
      expect(mod.getRuntimeState()?.configLoad).toBeDefined();
    });
    host.fire("session_shutdown", face.ctx);
    host.fire("session_shutdown", face.ctx);

    if (mode === "tui") {
      // Exactly one set then one clear; the second shutdown clears nothing.
      expect(face.ui.setStatus.mock.calls).toEqual([
        [FOOTER_STATUS_KEY, "ts:auto/medium"],
        [FOOTER_STATUS_KEY, undefined],
      ]);
    } else {
      expect(face.ui.setStatus).not.toHaveBeenCalled();
    }
    expect(mod.getRuntimeState()?.shutdownAt).not.toBeNull();

    // Revive (double session_start): a fresh runtime re-owns the footer
    // exactly once more, with no dialogs anywhere.
    host.fire("session_start", face.ctx);
    await vi.waitFor(() => {
      expect(mod.getRuntimeState()?.shutdownAt).toBeNull();
    });
    expect(mod.getRuntimeState()?.startCount).toBe(2);
    if (mode === "tui") {
      expect(face.ui.setStatus.mock.calls).toHaveLength(3); // set, clear, set
    } else {
      expect(face.ui.setStatus).not.toHaveBeenCalled();
    }
    expectDialogSilence(face, `mode=${mode} revive`);
  });
});
