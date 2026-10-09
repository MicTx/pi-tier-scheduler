import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  CONFIG_CANCELLED_NOTICE,
  CONFIG_DEGRADED_NOTICE,
  CONFIG_FLOW_ACTIVE_NOTICE,
  CONFIG_RELOAD_PENDING_NOTICE,
  CONFIG_SAVE_FAILED_NOTICE,
  INIT_NON_TUI_NOTICE,
  INIT_USAGE_ERROR,
  handleInit,
  type ConfigCommandDependencies,
} from "../../src/commands/init";
import { respond } from "../../src/ui/respond";
import { loadEffectiveConfig, readConfigLayerForEdit, saveConfigFile } from "../../src/config/index";
import { resolveConfigPaths } from "../../src/config/discover";
import type { ResolveConfigPathsInput } from "../../src/config/discover";
import type { ConfigLayerReadInput } from "../../src/config/layer-read";
import type { LoadResult } from "../../src/config/types";

/**
 * `/ts init` command-face lock (07-tui-modes.md §7.1 hooks 1–9; F7.1 spec
 * §7.2): scripted dialog traces drive the real wizard against real
 * temporary directories — the Phase 2 probe and writer are the real
 * implementations — while the runtime accessors are a stateful fake.
 * Asserts final target bytes, the cancellation matrix (escape, exhaustion,
 * shutdown mid-flow, declined replacement, declined commit), the
 * save/reload/revision chain, the flow mutex, the mode guards, and that no
 * provider/model/branch surface is ever touched. No credentials, no
 * network, no mock filesystem.
 */

const ADD = "add a candidate";
const KEEP = "keep this tier as shown";

type Scripted =
  | { select: string | undefined }
  | { input: string | undefined }
  | { confirm: boolean };

type Response = { message: string; severity: "info" | "warning" | "error" };

let home: string;
let project: string;
let agentDir: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ms-init-home-"));
  project = await mkdtemp(join(tmpdir(), "ms-init-project-"));
  agentDir = await mkdtemp(join(tmpdir(), "ms-init-agent-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
  await rm(agentDir, { recursive: true, force: true });
});

/** Stateful fake runtime: the fields the real wiring owns, mirrored. */
type FakeRuntime = {
  closed: boolean;
  flowActive: boolean;
  configLoad: LoadResult | undefined;
  revision: number | undefined;
};

function makeDeps(options: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  saveOverride?: ConfigCommandDependencies["saveConfigFile"];
  loadOverride?: ConfigCommandDependencies["loadConfig"];
  runtime?: FakeRuntime;
} = {}) {
  const runtime: FakeRuntime = options.runtime ?? {
    closed: false,
    flowActive: false,
    configLoad: undefined,
    revision: undefined,
  };
  const responses: Response[] = [];
  const env = options.env ?? {};
  const homeDir = options.homeDir ?? home;
  const targets = resolveConfigPaths({ cwd: project, env, homeDir });
  activeTargets = targets;
  const deps: ConfigCommandDependencies = {
    getConfig: () => runtime.configLoad,
    respond: (_ctx, message, severity = "info") => {
      responses.push({ message, severity });
    },
    readConfigLayerForEdit: (input: ConfigLayerReadInput) =>
      readConfigLayerForEdit({ ...input, env, homeDir }),
    loadConfig:
      options.loadOverride ??
      ((input: ResolveConfigPathsInput) => loadEffectiveConfig({ ...input, env, homeDir })),
    saveConfigFile:
      options.saveOverride ??
      ((target: string, layer: Parameters<typeof saveConfigFile>[1], saveOptions?: { backupExisting?: boolean }) =>
        saveConfigFile(target, layer, saveOptions)),
    isRuntimeClosed: () => runtime.closed,
    isFlowActive: () => runtime.flowActive,
    setFlowActive: (active) => {
      runtime.flowActive = active;
    },
    getConfigRevision: () => runtime.revision ?? 1,
    applyConfigReload: (load) => {
      if (runtime.closed) return { applied: false, revision: runtime.revision ?? 1 };
      runtime.configLoad = load;
      runtime.revision = (runtime.revision ?? 1) + 1;
      return { applied: true, revision: runtime.revision };
    },
    enqueueConfigSave: <T>(operation: () => Promise<T>) => operation(),
    // F7.2 additions: benign defaults for the wizard, which never reads them.
    getManualOverride: () => null,
    refreshFooter: () => {},
    setReloadPending: () => {},
  };
  return { deps, responses, runtime, userTarget: targets.userPath, projectTarget: targets.projectPath };
}

/** Command ctx with a scripted ui; `close` steps flip the runtime closed. */
function makeCtx(
  steps: Scripted[],
  options: {
    mode?: "tui" | "rpc" | "json" | "print";
    runtime?: FakeRuntime;
    cwd?: string;
    /** Flip the runtime closed once this many dialog calls have resolved. */
    closeAfterDialog?: number;
  } = {},
) {
  const queue = [...steps];
  const runtime = options.runtime;
  const take = (kind: "select" | "input" | "confirm"): unknown => {
    const next = queue.shift();
    if (next === undefined || !(kind in next)) {
      throw new Error(`unexpected ${kind} dialog; next step: ${JSON.stringify(next ?? null)}`);
    }
    return (next as Record<string, unknown>)[kind];
  };
  let dialogCount = 0;
  const bump = (): void => {
    dialogCount += 1;
    if (runtime !== undefined && options.closeAfterDialog === dialogCount) {
      runtime.closed = true;
    }
  };
  const select = vi.fn(async (_title: string, _options?: readonly string[]): Promise<string | undefined> => {
    const value = take("select") as string | undefined;
    bump();
    return value;
  });
  const confirm = vi.fn(async (_title: string, _message?: string): Promise<boolean> => {
    const value = take("confirm") as boolean;
    bump();
    return value;
  });
  const input = vi.fn(async (_title: string): Promise<string | undefined> => {
    const value = take("input") as string | undefined;
    bump();
    return value;
  });
  const notify = vi.fn();
  const setModel = vi.fn(async (): Promise<boolean> => true);
  const setThinkingLevel = vi.fn();
  const appendEntry = vi.fn();
  const mode = options.mode ?? "tui";
  const shape = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd: options.cwd ?? project,
    signal: undefined,
    ui: { select, confirm, input, notify },
    model: undefined,
    sessionManager: { getBranch: () => [] },
    modelRegistry: { find: vi.fn(() => undefined) },
    setModel,
    setThinkingLevel,
    appendEntry,
  };
  return {
    ctx: shape as unknown as ExtensionCommandContext,
    select,
    confirm,
    input,
    notify,
    setModel,
    setThinkingLevel,
    appendEntry,
  };
}

/** Targets of the most recent makeDeps call; every test builds deps before reading. */
let activeTargets: { userPath: string; projectPath: string };

async function readTarget(scope: "user" | "project"): Promise<string | undefined> {
  const target = scope === "user" ? activeTargets.userPath : activeTargets.projectPath;
  try {
    return await readFile(target, "utf8");
  } catch {
    return undefined;
  }
}

async function seedProjectLayer(raw: string): Promise<void> {
  await mkdir(resolve(project, ".pi"), { recursive: true });
  await writeFile(resolve(project, ".pi", "tier-scheduler.json"), raw, "utf8");
}

function happyPath(from: "missing" | "valid" | "invalid"): Scripted[] {
  const prologue: Scripted[] =
    from === "missing" ? [] : from === "valid" ? [{ confirm: true }] : [{ confirm: true }];
  return [
    { select: "project" },
    ...prologue,
    { select: KEEP }, // brain
    { select: KEEP }, // pillar
    { select: KEEP }, // crowd
    { select: "medium" },
    { confirm: true }, // sticky
    { select: "3" },
    { select: "2" },
    { confirm: true }, // commit
  ];
}

describe("/ts init — guard surface", () => {
  it("rejects trailing arguments with the stable usage error and no dialogs", async () => {
    const { deps, responses } = makeDeps();
    const face = makeCtx([]);
    await handleInit("extra", face.ctx, deps);
    expect(responses).toEqual([{ message: INIT_USAGE_ERROR, severity: "warning" }]);
    expect(face.select).not.toHaveBeenCalled();
  });

  it.each(["rpc", "json", "print"] as const)("answers %s with the TUI-required notice and zero ui calls", async (mode) => {
    const { deps, responses } = makeDeps();
    const face = makeCtx([], { mode });
    await handleInit("", face.ctx, deps);
    expect(responses).toEqual([{ message: INIT_NON_TUI_NOTICE, severity: "info" }]);
    expect(face.select).not.toHaveBeenCalled();
    expect(face.confirm).not.toHaveBeenCalled();
    expect(face.input).not.toHaveBeenCalled();
    expect(face.notify).not.toHaveBeenCalled();
  });

  it("rejects a second init while a flow is active, without opening a dialog", async () => {
    const runtime = { closed: false, flowActive: true, configLoad: undefined, revision: undefined };
    const { deps, responses } = makeDeps({ runtime });
    const face = makeCtx([]);
    await handleInit("", face.ctx, deps);
    expect(responses).toEqual([{ message: CONFIG_FLOW_ACTIVE_NOTICE, severity: "warning" }]);
    expect(face.select).not.toHaveBeenCalled();
  });

  it("answers rpc through ui.notify only when wired through the real responder (F7.3)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { deps } = makeDeps();
      deps.respond = respond; // the production wiring, not the capture fake
      const face = makeCtx([], { mode: "rpc" });
      await handleInit("", face.ctx, deps);
      expect(face.notify).toHaveBeenCalledTimes(1);
      expect(face.notify.mock.calls[0]?.[0]).toBe(INIT_NON_TUI_NOTICE);
      expect(face.notify.mock.calls[0]?.[1]).toBe("info");
      expect(consoleError).not.toHaveBeenCalled();
      expect(face.select).not.toHaveBeenCalled();
      expect(face.confirm).not.toHaveBeenCalled();
      expect(face.input).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("/ts init — success path (hooks 1, 6, 7)", () => {
  it("saves a complete layer from defaults for a missing project target and reloads it", async () => {
    const { deps, responses, runtime } = makeDeps();
    const face = makeCtx([
      { select: "project" },
      { select: ADD },
      { input: " acme " },
      { input: " brain-1 " },
      { select: KEEP },
      { select: KEEP }, // pillar
      { select: KEEP }, // crowd
      { select: "high" },
      { confirm: false }, // sticky=false is an answer, not a cancel
      { select: "5" },
      { select: "3" },
      { confirm: true },
    ]);

    await handleInit("", face.ctx, deps);

    const saved = await readTarget("project");
    expect(saved).toBe(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          tiers: {
            brain: { candidates: [{ provider: "acme", id: "brain-1" }] },
            pillar: { candidates: [] },
            crowd: { candidates: [] },
          },
          policy: { defaultBias: "high", sticky: false },
          retry: { maxAttemptsPerRequest: 5, maxTierSwitches: 3 },
        },
        null,
        2,
      )}\n`,
    );
    expect(responses.at(-1)?.message).toBe(
      "configuration saved; effective config reloaded (scope: project, revision: 2)",
    );
    expect(responses.at(-1)?.severity).toBe("info");
    // The reload result is installed and versioned.
    expect(runtime.configLoad?.effective.tiers.brain.candidates).toEqual([
      { provider: "acme", id: "brain-1" },
    ]);
    expect(runtime.revision).toBe(2);
    // Hook 7 spy assertions: no model, thinking, or branch surface is touched.
    expect(face.setModel).not.toHaveBeenCalled();
    expect(face.setThinkingLevel).not.toHaveBeenCalled();
    expect(face.appendEntry).not.toHaveBeenCalled();
  });

  it("resolves the user target through PI_CODING_AGENT_DIR end to end (hook 1)", async () => {
    const { deps, responses } = makeDeps({ env: { PI_CODING_AGENT_DIR: agentDir } });
    const face = makeCtx([
      { select: "user" },
      { select: KEEP },
      { select: KEEP },
      { select: KEEP },
      { select: "medium" },
      { confirm: true },
      { select: "3" },
      { select: "2" },
      { confirm: true },
    ]);
    await handleInit("", face.ctx, deps);
    const saved = await readTarget("user");
    expect(saved).toBeDefined();
    expect(saved).toContain('"policy"');
    expect(responses.at(-1)?.message).toContain("scope: user, revision: 2");
  });

  it("clones a valid target without flattening or reordering it (hook 2)", async () => {
    await seedProjectLayer(
      `${JSON.stringify({
        schemaVersion: 1,
        tiers: {
          brain: { candidates: [{ provider: "acme", id: "b2" }, { provider: "acme", id: "b1" }] },
        },
        policy: { defaultBias: "high" },
      })}\n`,
    );
    const { deps } = makeDeps();
    // edit-existing confirm → keep every tier → re-choose the same policy values.
    const face = makeCtx([
      { select: "project" },
      { confirm: true },
      { select: KEEP },
      { select: KEEP },
      { select: KEEP },
      { select: "high" },
      { confirm: true },
      { select: "3" },
      { select: "2" },
      { confirm: true },
    ]);
    await handleInit("", face.ctx, deps);
    const saved = JSON.parse((await readTarget("project")) ?? "{}");
    expect(saved.tiers.brain.candidates.map((c: { id: string }) => c.id)).toEqual(["b2", "b1"]);
    expect(saved.policy.defaultBias).toBe("high");
  });

  it("replaces an invalid target only after confirmation, keeping the bytes in a .replaced-* backup", async () => {
    const original = `${JSON.stringify({ schemaVersion: 1, retry: { maxAttemptsPerRequest: 99 } })}\n`;
    await seedProjectLayer(original);
    const { deps, responses } = makeDeps();
    const face = makeCtx([
      { select: "project" },
      { confirm: true }, // deliberate replacement
      { select: KEEP },
      { select: KEEP },
      { select: KEEP },
      { select: "medium" },
      { confirm: true },
      { select: "3" },
      { select: "2" },
      { confirm: true },
    ]);
    await handleInit("", face.ctx, deps);
    const saved = JSON.parse((await readTarget("project")) ?? "{}");
    expect(saved.retry.maxAttemptsPerRequest).toBe(3);
    const entries = await readdir(resolve(project, ".pi"));
    const backup = entries.find((entry) => entry.startsWith("tier-scheduler.json.replaced-"));
    expect(backup).toBeDefined();
    expect(await readFile(resolve(project, ".pi", backup!), "utf8")).toBe(original);
    expect(responses.at(-1)?.severity).toBe("info");
  });

  it("reports a degraded effective config when the other layer has problems", async () => {
    // Invalid project layer + save to the (missing) user layer.
    await seedProjectLayer("{ this is not json");
    const { deps, responses } = makeDeps();
    const face = makeCtx([
      { select: "user" },
      { select: KEEP },
      { select: KEEP },
      { select: KEEP },
      { select: "medium" },
      { confirm: true },
      { select: "3" },
      { select: "2" },
      { confirm: true },
    ]);
    await handleInit("", face.ctx, deps);
    expect(await readTarget("user")).toBeDefined();
    expect(responses.at(-1)).toEqual({ message: CONFIG_DEGRADED_NOTICE, severity: "warning" });
  });
});

describe("/ts init — cancellation matrix (hook 5)", () => {
  it("escape at the scope dialog discards everything with the stable cancel notice", async () => {
    const { deps, responses, runtime } = makeDeps();
    const face = makeCtx([{ select: undefined }]);
    await handleInit("", face.ctx, deps);
    expect(responses).toEqual([{ message: CONFIG_CANCELLED_NOTICE, severity: "info" }]);
    expect(await readTarget("project")).toBeUndefined();
    expect(runtime.configLoad).toBeUndefined();
    expect(runtime.revision).toBeUndefined();
    expect(runtime.flowActive).toBe(false);
  });

  it("invalid-input exhaustion cancels with a warning and no write", async () => {
    const { deps, responses } = makeDeps();
    const face = makeCtx([
      { select: "project" },
      { select: ADD },
      { input: "" },
      { input: " " },
      { input: "bad\u0000provider" },
    ]);
    await handleInit("", face.ctx, deps);
    expect(responses).toEqual([{ message: CONFIG_CANCELLED_NOTICE, severity: "warning" }]);
    expect(await readTarget("project")).toBeUndefined();
  });

  it("shutdown observed mid-flow cancels before any write", async () => {
    const runtime = { closed: false, flowActive: false, configLoad: undefined, revision: undefined };
    const { deps, responses } = makeDeps({ runtime });
    // The runtime closes once the scope dialog resolves; the next
    // checkpoint (after the layer probe) observes it and cancels.
    const face = makeCtx([{ select: "project" }], { runtime, closeAfterDialog: 1 });
    await handleInit("", face.ctx, deps);
    expect(responses).toEqual([{ message: CONFIG_CANCELLED_NOTICE, severity: "info" }]);
    expect(await readTarget("project")).toBeUndefined();
    expect(runtime.revision).toBeUndefined();
  });

  it("a declined replacement leaves an invalid target byte-for-byte intact (hook 2)", async () => {
    const original = `${JSON.stringify({ schemaVersion: 1, policy: { sticky: "yes" } })}\n`;
    await seedProjectLayer(original);
    const { deps, responses } = makeDeps();
    const face = makeCtx([{ select: "project" }, { confirm: false }]);
    await handleInit("", face.ctx, deps);
    expect(responses).toEqual([{ message: CONFIG_CANCELLED_NOTICE, severity: "info" }]);
    expect(await readTarget("project")).toBe(original);
    const entries = await readdir(resolve(project, ".pi"));
    expect(entries.some((entry) => entry.startsWith("tier-scheduler.json.replaced-"))).toBe(false);
  });

  it("a declined commit confirmation performs no save at all (hook 6)", async () => {
    let saves = 0;
    const saveOverride = async (...args: Parameters<typeof saveConfigFile>) => {
      saves += 1;
      return saveConfigFile(...args);
    };
    const { deps, responses, runtime } = makeDeps({ saveOverride });
    const face = makeCtx(happyPath("missing").slice(0, -1).concat([{ confirm: false }]));
    await handleInit("", face.ctx, deps);
    expect(responses).toEqual([{ message: CONFIG_CANCELLED_NOTICE, severity: "info" }]);
    expect(saves).toBe(0);
    expect(await readTarget("project")).toBeUndefined();
    expect(runtime.revision).toBeUndefined();
  });
});

describe("/ts init — failure and reload semantics (hooks 6, 7)", () => {
  it("a save failure reports the stable error, keeps the old snapshot, and never claims success", async () => {
    const runtime = { closed: false, flowActive: false, configLoad: undefined, revision: undefined };
    const { deps, responses } = makeDeps({
      runtime,
      saveOverride: async () => {
        throw new Error("persist failure");
      },
    });
    const face = makeCtx(happyPath("missing"));
    await handleInit("", face.ctx, deps);
    expect(responses.at(-1)).toEqual({ message: CONFIG_SAVE_FAILED_NOTICE, severity: "error" });
    expect(await readTarget("project")).toBeUndefined();
    expect(runtime.configLoad).toBeUndefined();
    expect(runtime.revision).toBeUndefined();
  });

  it("a reload failure after a successful save reports reload-pending and keeps the old snapshot", async () => {
    const runtime = { closed: false, flowActive: false, configLoad: undefined, revision: undefined };
    const { deps, responses } = makeDeps({
      runtime,
      loadOverride: async () => {
        throw new Error("reload failure");
      },
    });
    const face = makeCtx(happyPath("missing"));
    await handleInit("", face.ctx, deps);
    expect(await readTarget("project")).toBeDefined(); // the save itself succeeded
    expect(responses.at(-1)).toEqual({
      message: CONFIG_RELOAD_PENDING_NOTICE,
      severity: "warning",
    });
    expect(runtime.configLoad).toBeUndefined();
    expect(runtime.revision).toBeUndefined();
  });
});
