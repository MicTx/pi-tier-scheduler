import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { CONFIG_NON_TUI_EDIT_NOTICE, handleConfig } from "../../src/commands/config";
import type { ConfigCommandDependencies } from "../../src/commands/init";
import { respond } from "../../src/ui/respond";
import { loadEffectiveConfig } from "../../src/config/index";
import { resolveConfigPaths } from "../../src/config/discover";
import type { LoadResult } from "../../src/config/types";

/**
 * `/ts config` mode matrix (07-tui-modes.md §3.1 step 4, §5.7; F7.2 spec
 * §7.2 hook 8; the F7.3 deep matrix stays in its own package): the
 * read-only effective view renders in rpc/json/print with the
 * editing-requires-TUI notice appended; JSON/print write only to stderr
 * with zero `ctx.ui` calls of any kind; RPC notifies plainly and never
 * receives `setStatus`; no mode without TUI opens a dialog or writes a
 * configuration file.
 */

let home: string;
let project: string;
let baseLoad: LoadResult;
let targets: { userPath: string; projectPath: string };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ms-config-mode-home-"));
  project = await mkdtemp(join(tmpdir(), "ms-config-mode-project-"));
  baseLoad = await loadEffectiveConfig({ cwd: project, env: {}, homeDir: home });
  targets = resolveConfigPaths({ cwd: project, env: {}, homeDir: home });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

function makeDeps() {
  const deps: ConfigCommandDependencies = {
    getConfig: () => baseLoad,
    respond,
    readConfigLayerForEdit: async () => {
      throw new Error("non-TUI modes must never probe a layer");
    },
    loadConfig: async () => {
      throw new Error("non-TUI modes must never reload");
    },
    saveConfigFile: async () => {
      throw new Error("non-TUI modes must never save");
    },
    isRuntimeClosed: () => false,
    isFlowActive: () => false,
    setFlowActive: (active) => {
      expect(active).toBe(false); // the TUI-only branch is never entered
    },
    getConfigRevision: () => 1,
    applyConfigReload: () => ({ applied: false, revision: 1 }),
    enqueueConfigSave: <T>(operation: () => Promise<T>) => operation(),
    getManualOverride: () => null,
    refreshFooter: () => {},
    setReloadPending: () => {
      throw new Error("non-TUI modes never reach the save path");
    },
  };
  return deps;
}

/** Full ctx.ui spy surface; every method is expected to stay untouched. */
function makeCtx(mode: "rpc" | "json" | "print") {
  const spies = {
    select: vi.fn(async (): Promise<string | undefined> => {
      throw new Error("select must not be called");
    }),
    confirm: vi.fn(async (): Promise<boolean> => {
      throw new Error("confirm must not be called");
    }),
    input: vi.fn(async (): Promise<string | undefined> => {
      throw new Error("input must not be called");
    }),
    notify: vi.fn(),
    setStatus: vi.fn(),
    custom: vi.fn(async (): Promise<never> => {
      throw new Error("custom must not be called");
    }),
  };
  const shape = {
    mode,
    hasUI: mode === "rpc",
    cwd: project,
    signal: undefined,
    ui: spies,
    model: undefined,
    sessionManager: { getBranch: () => [] },
    modelRegistry: { find: vi.fn(() => undefined) },
  };
  return { ctx: shape as unknown as ExtensionCommandContext, spies };
}

describe("/ts config — non-TUI mode matrix (hook 8)", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  let stdoutWrite: MockInstance<typeof process.stdout.write>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["rpc", "json", "print"] as const)(
    "%s renders the view plus the editing notice and opens nothing",
    async (mode) => {
      const { ctx, spies } = makeCtx(mode);
      await handleConfig("", ctx, makeDeps());
      const text =
        mode === "rpc"
          ? String(spies.notify.mock.calls[0]?.[0])
          : String(consoleError.mock.calls[0]?.[0]);
      expect(text).toContain("pi-tier-scheduler configuration");
      expect(text).toContain("sources: user=missing; project=missing");
      expect(text).toContain("session override: automatic");
      expect(text.endsWith(CONFIG_NON_TUI_EDIT_NOTICE)).toBe(true);
      // No dialog, no status write, no probe, no write of any file.
      expect(spies.select).not.toHaveBeenCalled();
      expect(spies.confirm).not.toHaveBeenCalled();
      expect(spies.input).not.toHaveBeenCalled();
      expect(spies.setStatus).not.toHaveBeenCalled();
      expect(stdoutWrite).not.toHaveBeenCalled();
      await expect(readFile(targets.userPath, "utf8")).rejects.toThrow();
      await expect(readFile(targets.projectPath, "utf8")).rejects.toThrow();
    },
  );

  it("rpc answers through exactly one plain notify; json/print only on stderr", async () => {
    const rpc = makeCtx("rpc");
    await handleConfig("", rpc.ctx, makeDeps());
    expect(rpc.spies.notify).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();

    const json = makeCtx("json");
    await handleConfig("", json.ctx, makeDeps());
    expect(json.spies.notify).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it("trailing arguments are rejected in every mode before any view work", async () => {
    const rpc = makeCtx("rpc");
    await handleConfig("extra", rpc.ctx, makeDeps());
    expect(rpc.spies.notify).toHaveBeenCalledTimes(1);
    expect(rpc.spies.notify.mock.calls[0]).toEqual([
      "invalid arguments for 'config'; usage: /ts config",
      "warning",
    ]);
    expect(rpc.spies.setStatus).not.toHaveBeenCalled();

    for (const mode of ["json", "print"] as const) {
      const { ctx, spies } = makeCtx(mode);
      await handleConfig("extra", ctx, makeDeps());
      expect(spies.notify).not.toHaveBeenCalled();
      expect(spies.setStatus).not.toHaveBeenCalled();
    }
    expect(consoleError).toHaveBeenCalledTimes(2); // json + print only; rpc went to notify
    for (const call of consoleError.mock.calls) {
      expect(String(call?.[0])).toBe("invalid arguments for 'config'; usage: /ts config");
    }
  });

  it("never touches custom() in any non-TUI mode (F7.3)", async () => {
    for (const mode of ["rpc", "json", "print"] as const) {
      const { ctx, spies } = makeCtx(mode);
      await handleConfig("", ctx, makeDeps());
      expect(spies.custom, `mode=${mode}: custom is a TUI-only surface`).not.toHaveBeenCalled();
    }
  });
});
