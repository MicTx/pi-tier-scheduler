import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  CONFIG_CANCELLED_NOTICE,
  CONFIG_FLOW_ACTIVE_NOTICE,
  CONFIG_RELOAD_PENDING_NOTICE,
} from "../../src/commands/init";
import { CONFIG_NON_TUI_EDIT_NOTICE, CONFIG_USAGE_ERROR, handleConfig } from "../../src/commands/config";
import type { ConfigCommandDependencies } from "../../src/commands/init";
import { loadEffectiveConfig, readConfigLayerForEdit, saveConfigFile } from "../../src/config/index";
import { resolveConfigPaths } from "../../src/config/discover";
import type { ResolveConfigPathsInput } from "../../src/config/discover";
import type { ConfigLayerReadInput } from "../../src/config/layer-read";
import type { LoadResult } from "../../src/config/types";

/**
 * `/ts config` command-face lock (07-tui-modes.md §7.2 hooks 1–6, 8–9; F7.2
 * spec §7.2): scripted dialog traces drive the real view/menu/editor against
 * real temporary directories — the Phase 2 probe, writer, and loader are the
 * real implementations — while the runtime accessors are a stateful fake.
 * Asserts final target bytes stay partial (omission is inheritance), the
 * reset/replace/cancel matrix, the save/reload/revision chain with router
 * surfaces untouched, invalid-target guidance, and zero provider/registry
 * calls. No credentials, no network, no mock filesystem.
 */

type Scripted =
  | { select: string | undefined }
  | { input: string | undefined }
  | { confirm: boolean };

type Response = { message: string; severity: "info" | "warning" | "error" };

let home: string;
let project: string;
let agentDir: string;
let baseLoad: LoadResult;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ms-config-home-"));
  project = await mkdtemp(join(tmpdir(), "ms-config-project-"));
  agentDir = await mkdtemp(join(tmpdir(), "ms-config-agent-"));
  baseLoad = await loadEffectiveConfig({ cwd: project, env: {}, homeDir: home });
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
  reloadPending: boolean | undefined;
};

function makeDeps(options: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  saveOverride?: ConfigCommandDependencies["saveConfigFile"];
  loadOverride?: ConfigCommandDependencies["loadConfig"];
  runtime?: FakeRuntime;
  manualOverride?: "brain" | "pillar" | "crowd" | null;
} = {}) {
  const runtime: FakeRuntime = options.runtime ?? {
    closed: false,
    flowActive: false,
    configLoad: baseLoad,
    revision: 1,
    reloadPending: false,
  };
  const responses: Response[] = [];
  const env = options.env ?? {};
  const homeDir = options.homeDir ?? home;
  const targets = resolveConfigPaths({ cwd: project, env, homeDir });
  activeTargets = targets;
  const refreshFooter = vi.fn();
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
    getManualOverride: () => options.manualOverride ?? null,
    refreshFooter,
    setReloadPending: (pending) => {
      runtime.reloadPending = pending;
    },
  };
  return {
    deps,
    responses,
    runtime,
    refreshFooter,
    userTarget: targets.userPath,
    projectTarget: targets.projectPath,
  };
}

/** Command ctx with a scripted ui; `closeAfterDialog` flips the runtime closed. */
function makeCtx(
  steps: Scripted[],
  options: {
    mode?: "tui" | "rpc" | "json" | "print";
    runtime?: FakeRuntime;
    cwd?: string;
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
  const setStatus = vi.fn();
  const setModel = vi.fn(async (): Promise<boolean> => true);
  const setThinkingLevel = vi.fn();
  const appendEntry = vi.fn();
  const find = vi.fn(() => undefined);
  const mode = options.mode ?? "tui";
  const shape = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd: options.cwd ?? project,
    signal: undefined,
    ui: { select, confirm, input, notify, setStatus },
    model: undefined,
    sessionManager: { getBranch: () => [] },
    modelRegistry: { find },
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
    setStatus,
    setModel,
    setThinkingLevel,
    appendEntry,
    find,
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

describe("/ts config — guard surface", () => {
  it("rejects trailing arguments with the stable usage error and no dialogs", async () => {
    const { deps, responses } = makeDeps();
    const face = makeCtx([]);
    await handleConfig("extra", face.ctx, deps);
    expect(responses).toEqual([{ message: CONFIG_USAGE_ERROR, severity: "warning" }]);
    expect(face.select).not.toHaveBeenCalled();
  });

  it("rejects a second config while a flow is active, without opening a dialog", async () => {
    const runtime = { closed: false, flowActive: true, configLoad: baseLoad, revision: 1, reloadPending: false };
    const { deps, responses } = makeDeps({ runtime });
    const face = makeCtx([], { runtime });
    await handleConfig("", face.ctx, deps);
    expect(responses).toEqual([{ message: CONFIG_FLOW_ACTIVE_NOTICE, severity: "warning" }]);
    expect(face.select).not.toHaveBeenCalled();
  });

  it("renders the fixed not-loaded view when the runtime has no load yet", async () => {
    const runtime = { closed: false, flowActive: false, configLoad: undefined, revision: undefined, reloadPending: false };
    const { deps, responses } = makeDeps({ runtime });
    const face = makeCtx([{ select: "cancel" }], { runtime });
    await handleConfig("", face.ctx, deps);
    expect(responses[0]).toEqual({
      message: "pi-tier-scheduler configuration\neffective: not loaded (built-in defaults in effect)",
      severity: "info",
    });
    expect(responses[1]).toEqual({ message: CONFIG_CANCELLED_NOTICE, severity: "info" });
  });
});

describe("/ts config — view and menu (hooks 1, 8)", () => {
  it("renders the effective view, then re-renders it for the view option", async () => {
    await seedProjectLayer(
      `${JSON.stringify({
        schemaVersion: 1,
        tiers: { pillar: { candidates: [{ provider: "acme", id: "pillar-1" }] } },
      })}\n`,
    );
    const load = await loadEffectiveConfig({ cwd: project, env: {}, homeDir: home });
    const { deps, responses } = makeDeps({ runtime: { closed: false, flowActive: false, configLoad: load, revision: 1, reloadPending: false } });
    const face = makeCtx([{ select: "view effective configuration" }]);
    await handleConfig("", face.ctx, deps);
    const view = responses[0]?.message ?? "";
    expect(view).toContain("pi-tier-scheduler configuration");
    expect(view).toContain("sources: user=missing; project=loaded");
    expect(view).toContain("pillar candidates (project, 1): acme/pillar-1");
    expect(view).toContain("crowd candidates (defaults, 0): none");
    expect(view).toContain("session override: automatic");
    // The view option answers the same text again; nothing else happens.
    expect(responses[1]?.message).toBe(view);
    expect(face.select).toHaveBeenCalledTimes(1);
  });

  it("reports the branch manual override in the session-override line", async () => {
    const { deps, responses } = makeDeps({ manualOverride: "brain" });
    const face = makeCtx([{ select: "cancel" }]);
    await handleConfig("", face.ctx, deps);
    expect(responses[0]?.message).toContain("session override: brain");
    expect(responses[1]).toEqual({ message: CONFIG_CANCELLED_NOTICE, severity: "info" });
  });

  it("menu cancel discards everything with the stable cancel notice and zero writes", async () => {
    const { deps, responses } = makeDeps();
    const face = makeCtx([{ select: "cancel" }]);
    await handleConfig("", face.ctx, deps);
    expect(responses).toHaveLength(2);
    expect(responses[0]?.message).toContain("pi-tier-scheduler configuration");
    expect(responses[1]).toEqual({ message: CONFIG_CANCELLED_NOTICE, severity: "info" });
    expect(await readTarget("project")).toBeUndefined();
    expect(await readTarget("user")).toBeUndefined();
  });
});

describe("/ts config — partial-layer editing (hooks 2, 3, 4)", () => {
  it("edits one tier of a missing target and saves a partial layer (hook 2)", async () => {
    const { deps, responses, runtime } = makeDeps();
    const face = makeCtx([
      { select: "edit project layer" },
      { select: "candidates" },
      { select: "brain" },
      { select: "add a candidate" },
      { input: " acme " },
      { input: " brain-1 " },
      { select: "back" },
      { select: "save" },
      { confirm: true },
    ]);
    await handleConfig("", face.ctx, deps);
    // The saved document stays partial: only the edited tier exists.
    const saved = JSON.parse((await readTarget("project")) ?? "{}");
    expect(saved).toEqual({
      schemaVersion: 1,
      tiers: { brain: { candidates: [{ provider: "acme", id: "brain-1" }] } },
    });
    expect(responses.at(-1)?.message).toBe(
      "configuration saved; effective config reloaded (scope: project, revision: 2)",
    );
    expect(runtime.revision).toBe(2);
    expect(runtime.configLoad?.effective.tiers.brain.candidates).toEqual([
      { provider: "acme", id: "brain-1" },
    ]);
    // Router/session surfaces are never driven by a config save (hooks 6/9).
    expect(face.setModel).not.toHaveBeenCalled();
    expect(face.setThinkingLevel).not.toHaveBeenCalled();
    expect(face.appendEntry).not.toHaveBeenCalled();
    expect(face.find).not.toHaveBeenCalled();
  });

  it("an untouched inherited tier stays inherited when another tier is edited (hook 2)", async () => {
    const { deps } = makeDeps();
    const face = makeCtx([
      { select: "edit project layer" },
      { select: "candidates" },
      { select: "crowd" },
      { select: "back" }, // untouched: key absent, not dirty → stays inherited
      { select: "candidates" },
      { select: "brain" },
      { select: "add a candidate" },
      { input: "acme" },
      { input: "b-1" },
      { select: "back" },
      { select: "save" },
      { confirm: true },
    ]);
    await handleConfig("", face.ctx, deps);
    const saved = JSON.parse((await readTarget("project")) ?? "{}");
    expect(saved.tiers).toEqual({ brain: { candidates: [{ provider: "acme", id: "b-1" }] } });
  });

  it("reset-to-inherit deletes the tier key and saves {schemaVersion: 1} when nothing remains (hook 3)", async () => {
    await seedProjectLayer(
      `${JSON.stringify({
        schemaVersion: 1,
        tiers: { brain: { candidates: [{ provider: "acme", id: "b1" }] } },
      })}\n`,
    );
    const { deps } = makeDeps();
    const face = makeCtx([
      { select: "edit project layer" },
      { select: "candidates" },
      { select: "brain" },
      { select: "reset tier to inherit" },
      { select: "save" },
      { confirm: true },
    ]);
    await handleConfig("", face.ctx, deps);
    expect(await readTarget("project")).toBe(`${JSON.stringify({ schemaVersion: 1 }, null, 2)}\n`);
  });

  it("replace-list re-enters the whole ordered list, rejecting within-tier duplicates (hook 4)", async () => {
    await seedProjectLayer(
      `${JSON.stringify({
        schemaVersion: 1,
        tiers: { brain: { candidates: [{ provider: "acme", id: "old" }] } },
      })}\n`,
    );
    const { deps } = makeDeps();
    const face = makeCtx([
      { select: "edit project layer" },
      { select: "candidates" },
      { select: "brain" },
      { select: "replace the ordered list" },
      { select: "add a candidate" },
      { input: "acme" },
      { input: "z-model" },
      { select: "add a candidate" },
      { input: "acme" },
      { input: "z-model" }, // duplicate within the new list → invalid, budget 1/3
      { input: "a-model" }, // corrected on re-ask
      { select: "done" },
      { select: "back" },
      { select: "save" },
      { confirm: true },
    ]);
    await handleConfig("", face.ctx, deps);
    const saved = JSON.parse((await readTarget("project")) ?? "{}");
    expect(saved.tiers.brain.candidates).toEqual([
      { provider: "acme", id: "z-model" },
      { provider: "acme", id: "a-model" },
    ]);
  });

  it("policy set keeps unrelated partial fields and adds the edited one (hook 3)", async () => {
    await mkdir(resolve(home, ".pi", "agent"), { recursive: true });
    await writeFile(
      resolve(home, ".pi", "agent", "tier-scheduler.json"),
      `${JSON.stringify({ schemaVersion: 1, policy: { defaultBias: "high" } })}\n`,
      "utf8",
    );
    const load = await loadEffectiveConfig({ cwd: project, env: {}, homeDir: home });
    const { deps } = makeDeps({
      runtime: { closed: false, flowActive: false, configLoad: load, revision: 1, reloadPending: false },
    });
    const face = makeCtx([
      { select: "edit user layer" },
      { select: "policy" },
      { select: "set sticky" },
      { confirm: true },
      { select: "save" },
      { confirm: true },
    ]);
    await handleConfig("", face.ctx, deps);
    const saved = JSON.parse((await readTarget("user")) ?? "{}");
    expect(saved).toEqual({
      schemaVersion: 1,
      policy: { defaultBias: "high", sticky: true },
    });
  });

  it("retry reset removes the leaf key while the sibling stays (hook 3)", async () => {
    await seedProjectLayer(
      `${JSON.stringify({
        schemaVersion: 1,
        retry: { maxAttemptsPerRequest: 5, maxTierSwitches: 1 },
      })}\n`,
    );
    const { deps } = makeDeps();
    const face = makeCtx([
      { select: "edit project layer" },
      { select: "retry" },
      { select: "reset maxAttemptsPerRequest to inherit" },
      { select: "save" },
      { confirm: true },
    ]);
    await handleConfig("", face.ctx, deps);
    const saved = JSON.parse((await readTarget("project")) ?? "{}");
    expect(saved.retry).toEqual({ maxTierSwitches: 1 });
    // The effective attempts fall back to the default 3 after the reload.
    expect(JSON.parse((await readTarget("project")) ?? "{}").retry).not.toHaveProperty("maxAttemptsPerRequest");
  });

  it("a user-layer edit keeps the project layer above it (precedence through the real save)", async () => {
    await seedProjectLayer(`${JSON.stringify({ schemaVersion: 1, policy: { sticky: false } })}\n`);
    const { deps, runtime } = makeDeps();
    const face = makeCtx([
      { select: "edit user layer" },
      { select: "policy" },
      { select: "set defaultBias" },
      { select: "low" },
      { select: "save" },
      { confirm: true },
    ]);
    await handleConfig("", face.ctx, deps);
    const saved = JSON.parse((await readTarget("user")) ?? "{}");
    expect(saved).toEqual({ schemaVersion: 1, policy: { defaultBias: "low" } });
    // Effective: user defaultBias=low applies (project silent), project sticky=false wins.
    expect(runtime.configLoad?.effective.policy.defaultBias).toBe("low");
    expect(runtime.configLoad?.effective.policy.sticky).toBe(false);
  });

  it("preview renders and returns to the editor without writing (hook 5)", async () => {
    const { deps, responses } = makeDeps();
    const face = makeCtx([
      { select: "edit project layer" },
      { select: "preview" },
      { confirm: true }, // dismiss the preview
      { select: "cancel" },
    ]);
    await handleConfig("", face.ctx, deps);
    expect(face.confirm.mock.calls[0]?.[0]).toBe("configuration preview (answering returns to the editor)");
    expect(String(face.confirm.mock.calls[0]?.[1])).toContain("pi-tier-scheduler configuration preview");
    expect(String(face.confirm.mock.calls[0]?.[1])).toContain("scope: project");
    expect(responses.at(-1)).toEqual({ message: CONFIG_CANCELLED_NOTICE, severity: "info" });
    expect(await readTarget("project")).toBeUndefined();
  });
});

describe("/ts config — target guards and cancellation (hooks 5, 9)", () => {
  it("an invalid target is never edited: guidance to /ts init, bytes intact, editor closed", async () => {
    const original = `${JSON.stringify({ schemaVersion: 1, retry: { maxAttemptsPerRequest: 99 } })}\n`;
    await seedProjectLayer(original);
    const { deps, responses } = makeDeps();
    const face = makeCtx([{ select: "edit project layer" }]);
    await handleConfig("", face.ctx, deps);
    expect(responses[1]?.message).toContain("the project layer is invalid");
    expect(responses[1]?.message).toContain("/ts init");
    expect(responses[1]?.severity).toBe("warning");
    expect(await readTarget("project")).toBe(original);
    expect(face.select).toHaveBeenCalledTimes(1); // only the main menu
    const entries = await readdir(resolve(project, ".pi"));
    expect(entries.some((entry) => entry.startsWith("tier-scheduler.json.replaced-"))).toBe(false);
  });

  it("a declined commit performs no save at all (hook 6)", async () => {
    let saves = 0;
    const saveOverride = async (...args: Parameters<typeof saveConfigFile>) => {
      saves += 1;
      return saveConfigFile(...args);
    };
    const { deps, responses } = makeDeps({ saveOverride });
    const face = makeCtx([
      { select: "edit project layer" },
      { select: "save" },
      { confirm: false },
    ]);
    await handleConfig("", face.ctx, deps);
    expect(responses.at(-1)).toEqual({ message: CONFIG_CANCELLED_NOTICE, severity: "info" });
    expect(saves).toBe(0);
    expect(await readTarget("project")).toBeUndefined();
  });

  it("escape at the main menu discards everything with the stable cancel notice", async () => {
    const { deps, responses } = makeDeps();
    const face = makeCtx([{ select: undefined }]);
    await handleConfig("", face.ctx, deps);
    expect(responses).toHaveLength(2);
    expect(responses[1]).toEqual({ message: CONFIG_CANCELLED_NOTICE, severity: "info" });
  });

  it("invalid-input exhaustion cancels with a warning and no write", async () => {
    const { deps, responses } = makeDeps();
    const face = makeCtx([
      { select: "edit project layer" },
      { select: "candidates" },
      { select: "brain" },
      { select: "add a candidate" },
      { input: "" },
      { input: " " },
      { input: "bad\u0000name" },
    ]);
    await handleConfig("", face.ctx, deps);
    expect(responses.at(-1)).toEqual({ message: CONFIG_CANCELLED_NOTICE, severity: "warning" });
    expect(await readTarget("project")).toBeUndefined();
  });

  it("shutdown observed mid-flow cancels before any write", async () => {
    const runtime = { closed: false, flowActive: false, configLoad: baseLoad, revision: 1, reloadPending: false };
    const { deps, responses } = makeDeps({ runtime });
    const face = makeCtx([{ select: "edit project layer" }], { runtime, closeAfterDialog: 1 });
    await handleConfig("", face.ctx, deps);
    expect(responses.at(-1)).toEqual({ message: CONFIG_CANCELLED_NOTICE, severity: "info" });
    expect(await readTarget("project")).toBeUndefined();
    expect(runtime.revision).toBe(1);
  });
});

describe("/ts config — save and reload semantics (hooks 6, 9)", () => {
  it("a reload failure after a successful save reports pending and marks the runtime", async () => {
    const runtime = { closed: false, flowActive: false, configLoad: baseLoad, revision: 1, reloadPending: false };
    const { deps, responses } = makeDeps({
      runtime,
      loadOverride: async () => {
        throw new Error("reload failure");
      },
    });
    const face = makeCtx([
      { select: "edit project layer" },
      { select: "retry" },
      { select: "set maxTierSwitches" },
      { select: "3" },
      { select: "save" },
      { confirm: true },
    ]);
    await handleConfig("", face.ctx, deps);
    expect(await readTarget("project")).toBeDefined(); // the save itself succeeded
    expect(responses.at(-1)).toEqual({ message: CONFIG_RELOAD_PENDING_NOTICE, severity: "warning" });
    expect(runtime.reloadPending).toBe(true);
    expect(runtime.configLoad).toBe(baseLoad); // old snapshot retained
    expect(runtime.revision).toBe(1);
  });

  it("a save failure reports the stable error and keeps the old snapshot", async () => {
    const runtime = { closed: false, flowActive: false, configLoad: baseLoad, revision: 1, reloadPending: false };
    const { deps, responses } = makeDeps({
      runtime,
      saveOverride: async () => {
        throw new Error("persist failure");
      },
    });
    const face = makeCtx([
      { select: "edit project layer" },
      { select: "save" },
      { confirm: true },
    ]);
    await handleConfig("", face.ctx, deps);
    expect(responses.at(-1)).toEqual({
      message: "configuration save failed; no changes made",
      severity: "error",
    });
    expect(runtime.configLoad).toBe(baseLoad);
    expect(runtime.revision).toBe(1);
    expect(runtime.reloadPending).toBe(false);
  });

  it("a degraded other layer is reported after a successful save", async () => {
    // Parseable but schema-invalid: survives the probe byte-for-byte and
    // reports a stable problem on every load (malformed JSON would be
    // quarantined by the first read instead).
    await seedProjectLayer(`${JSON.stringify({ schemaVersion: 1, retry: { maxAttemptsPerRequest: 99 } })}\n`);
    const { deps, responses } = makeDeps();
    const face = makeCtx([
      { select: "edit user layer" },
      { select: "save" },
      { confirm: true },
    ]);
    await handleConfig("", face.ctx, deps);
    expect(await readTarget("user")).toBeDefined();
    expect(responses.at(-1)).toEqual({
      message: "configuration saved; effective config degraded",
      severity: "warning",
    });
  });
});
