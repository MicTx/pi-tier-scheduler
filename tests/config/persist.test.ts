import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadEffectiveConfig, resolveConfigPaths, saveConfigFile } from "../../src/config/index";
import { __setFsForTests } from "../../src/config/persist";
import type { PersistenceFileHandle, PersistenceFs } from "../../src/config/persist";
import type { ConfigFile } from "../../src/config/types";

/**
 * Persistence tests (02-config.md §7.3 items 1, 2, 3, 6, and 7): real
 * temporary directories, no mock filesystem. Failures are injected at the
 * adapter seam (write/sync/close/rename and backup-create points) so the
 * real filesystem still models everything else — partial writes leave real
 * temp files that the cleanup path must remove.
 */

const isPosix = platform() !== "win32";

// Always restore the real adapter, whatever a test injected.
afterEach(() => {
  __setFsForTests(null);
});

type FsOp =
  | "mkdir"
  | "stat"
  | "readFile"
  | "openExclusive"
  | "write"
  | "sync"
  | "close"
  | "rename"
  | "unlink"
  | "readdir"
  | "syncDir";

interface OpRecord {
  op: FsOp;
  path: string;
}

/** Records every adapter operation; delegates everything to the base. */
function opLog(log: OpRecord[]): (base: PersistenceFs) => PersistenceFs {
  return (base) => {
    const wrapHandle = (handle: PersistenceFileHandle, path: string): PersistenceFileHandle => ({
      write: async (buffer) => {
        log.push({ op: "write", path });
        await handle.write(buffer);
      },
      sync: async () => {
        log.push({ op: "sync", path });
        await handle.sync();
      },
      close: async () => {
        log.push({ op: "close", path });
        await handle.close();
      },
    });
    return {
      mkdir: async (dir) => {
        log.push({ op: "mkdir", path: dir });
        await base.mkdir(dir);
      },
      stat: async (path) => {
        log.push({ op: "stat", path });
        return base.stat(path);
      },
      readFile: async (path) => {
        log.push({ op: "readFile", path });
        return base.readFile(path);
      },
      openExclusive: async (path) => {
        log.push({ op: "openExclusive", path });
        return wrapHandle(await base.openExclusive(path), path);
      },
      rename: async (from, to) => {
        log.push({ op: "rename", path: to });
        await base.rename(from, to);
      },
      unlink: async (path) => {
        log.push({ op: "unlink", path });
        await base.unlink(path);
      },
      readdir: async (dir) => {
        log.push({ op: "readdir", path: dir });
        return base.readdir(dir);
      },
      syncDir: async (path) => {
        log.push({ op: "syncDir", path });
        await base.syncDir(path);
      },
    };
  };
}

/** Returns an injected error the first time `match` hits, then disarms. */
function once(match: RegExp, code = "EIO"): (path: string) => Error | undefined {
  let armed = true;
  return (path) => {
    if (!armed || !match.test(path)) return undefined;
    armed = false;
    return Object.assign(new Error("injected filesystem failure"), { code });
  };
}

/**
 * Injects one-shot failures at adapter points. A failed write/sync leaves
 * the real temp file partial; a failed close releases the real descriptor
 * first; a failed rename/open never touches the real filesystem.
 */
function injectedFs(points: {
  openExclusive?: (path: string) => Error | undefined;
  write?: (path: string) => Error | undefined;
  sync?: (path: string) => Error | undefined;
  close?: (path: string) => Error | undefined;
  rename?: (to: string) => Error | undefined;
}): (base: PersistenceFs) => PersistenceFs {
  return (base) => {
    const wrapHandle = (handle: PersistenceFileHandle, path: string): PersistenceFileHandle => ({
      write: async (buffer) => {
        const err = points.write?.(path);
        if (err) throw err;
        await handle.write(buffer);
      },
      sync: async () => {
        const err = points.sync?.(path);
        if (err) throw err;
        await handle.sync();
      },
      close: async () => {
        const err = points.close?.(path);
        if (err) {
          await handle.close(); // release the real descriptor, then report failure
          throw err;
        }
        await handle.close();
      },
    });
    return {
      mkdir: (dir) => base.mkdir(dir),
      stat: (path) => base.stat(path),
      readFile: (path) => base.readFile(path),
      openExclusive: async (path) => {
        const err = points.openExclusive?.(path);
        if (err) throw err;
        return wrapHandle(await base.openExclusive(path), path);
      },
      rename: async (from, to) => {
        const err = points.rename?.(to);
        if (err) throw err;
        await base.rename(from, to);
      },
      unlink: (path) => base.unlink(path),
      readdir: (dir) => base.readdir(dir),
      syncDir: (path) => base.syncDir(path),
    };
  };
}

describe("saveConfigFile validation (§5.4)", () => {
  let work: string;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "ms-persist-validate-"));
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("rejects an invalid layer before anything on disk is touched", async () => {
    const target = resolve(work, "deep", "nested", "tier-scheduler.json");
    await expect(
      saveConfigFile(target, { schemaVersion: 2 } as unknown as ConfigFile),
    ).rejects.toThrow(/invalid config layer for save: SCHEMA_VERSION_UNSUPPORTED@schemaVersion/);
    // Validation precedes even parent-directory creation (§5.4).
    expect(await readdir(work)).toEqual([]);
  });

  it("aggregates every violation's stable code and JSON path", async () => {
    const target = resolve(work, "tier-scheduler.json");
    const layer = {
      schemaVersion: 1,
      policy: { defaultBias: 5 },
      retry: { maxAttemptsPerRequest: "many" },
    } as unknown as ConfigFile;
    await expect(saveConfigFile(target, layer)).rejects.toThrow(
      /invalid config layer for save: TYPE_MISMATCH@policy\.defaultBias, TYPE_MISMATCH@retry\.maxAttemptsPerRequest/,
    );
    expect(await readdir(work)).toEqual([]);
  });
});

describe("canonical atomic save (§7.3 item 1)", () => {
  let work: string;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "ms-persist-save-"));
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("creates missing parent directories and writes canonical JSON", async () => {
    const target = resolve(work, "a", "b", "tier-scheduler.json");
    // Shuffled keys and id-first candidates: the save must normalize to the
    // canonical order without touching any value (§5.4).
    const layer: ConfigFile = {
      schemaVersion: 1,
      tiers: {
        crowd: { candidates: [{ id: "cheap-2", provider: "z-ai" }] },
        pillar: { candidates: [] },
        brain: {
          candidates: [
            { id: "gpt-5", provider: "openai" },
            { id: "claude-x", provider: "anthropic" },
          ],
        },
      },
      policy: { sticky: false, defaultBias: "low" },
      retry: { maxTierSwitches: 1, maxAttemptsPerRequest: 4 },
    };
    await saveConfigFile(target, layer);
    const expected = [
      "{",
      '  "schemaVersion": 1,',
      '  "tiers": {',
      '    "brain": {',
      '      "candidates": [',
      "        {",
      '          "provider": "openai",',
      '          "id": "gpt-5"',
      "        },",
      "        {",
      '          "provider": "anthropic",',
      '          "id": "claude-x"',
      "        }",
      "      ]",
      "    },",
      '    "pillar": {',
      '      "candidates": []',
      "    },",
      '    "crowd": {',
      '      "candidates": [',
      "        {",
      '          "provider": "z-ai",',
      '          "id": "cheap-2"',
      "        }",
      "      ]",
      "    }",
      "  },",
      '  "policy": {',
      '    "defaultBias": "low",',
      '    "sticky": false',
      "  },",
      '  "retry": {',
      '    "maxAttemptsPerRequest": 4,',
      '    "maxTierSwitches": 1',
      "  }",
      "}",
      "",
    ].join("\n");
    expect(await readFile(target, "utf8")).toBe(expected);
    // No temp file residue (§7.3 item 1).
    expect(await readdir(resolve(work, "a", "b"))).toEqual(["tier-scheduler.json"]);
  });

  it("preserves partial layers exactly: only present keys are serialized", async () => {
    const target = resolve(work, "tier-scheduler.json");
    await saveConfigFile(target, { schemaVersion: 1, tiers: { brain: {} } });
    expect(await readFile(target, "utf8")).toBe(
      '{\n  "schemaVersion": 1,\n  "tiers": {\n    "brain": {}\n  }\n}\n',
    );
  });

  it.runIf(isPosix)(
    "creates the target owner-only and parents without group/other access bits",
    async () => {
      const target = resolve(work, "private", "tier-scheduler.json");
      await saveConfigFile(target, { schemaVersion: 1 });
      // Umask-independent check: no group/other access bits survive creation.
      expect((await stat(target)).mode & 0o077).toBe(0);
      expect((await stat(resolve(work, "private"))).mode & 0o077).toBe(0);
    },
  );

  it("replaces an existing target's bytes only via flush + rename", async () => {
    const target = resolve(work, "tier-scheduler.json");
    await writeFile(
      target,
      JSON.stringify({ schemaVersion: 1, policy: { defaultBias: "high" } }, null, 4),
      "utf8",
    );
    await saveConfigFile(target, { schemaVersion: 1 });
    expect(await readFile(target, "utf8")).toBe('{\n  "schemaVersion": 1\n}\n');
    expect(await readdir(work)).toEqual(["tier-scheduler.json"]);
  });
});

describe("failure injection before rename (§7.3 item 2)", () => {
  let work: string;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "ms-persist-fail-"));
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  const OLD_BYTES = '{\n    "schemaVersion": 1,\n    "policy": { "defaultBias": "high" }\n}\n';

  async function seedTarget(): Promise<string> {
    const target = resolve(work, "tier-scheduler.json");
    await writeFile(target, OLD_BYTES, "utf8");
    return target;
  }

  it("leaves the target byte-identical and removes the temp file when the write fails", async () => {
    const target = await seedTarget();
    __setFsForTests(injectedFs({ write: once(/\.tmp$/) }));
    await expect(
      saveConfigFile(target, { schemaVersion: 1, policy: { defaultBias: "low" } }),
    ).rejects.toThrow(`config save: write temp file of ${target} failed (EIO)`);
    expect(await readFile(target, "utf8")).toBe(OLD_BYTES);
    expect(await readdir(work)).toEqual(["tier-scheduler.json"]);
  });

  it("leaves the target byte-identical and removes the temp file when the fsync fails", async () => {
    const target = await seedTarget();
    __setFsForTests(injectedFs({ sync: once(/\.tmp$/) }));
    await expect(
      saveConfigFile(target, { schemaVersion: 1, policy: { defaultBias: "low" } }),
    ).rejects.toThrow(`config save: sync temp file of ${target} failed (EIO)`);
    expect(await readFile(target, "utf8")).toBe(OLD_BYTES);
    expect(await readdir(work)).toEqual(["tier-scheduler.json"]);
  });

  it("leaves the target byte-identical and removes the temp file when the close fails", async () => {
    const target = await seedTarget();
    __setFsForTests(injectedFs({ close: once(/\.tmp$/) }));
    await expect(
      saveConfigFile(target, { schemaVersion: 1, policy: { defaultBias: "low" } }),
    ).rejects.toThrow(`config save: close temp file of ${target} failed (EIO)`);
    expect(await readFile(target, "utf8")).toBe(OLD_BYTES);
    expect(await readdir(work)).toEqual(["tier-scheduler.json"]);
  });

  it("surfaces a failed rename with the target path and operation context", async () => {
    const target = await seedTarget();
    __setFsForTests(injectedFs({ rename: once(/tier-scheduler\.json$/) }));
    await expect(saveConfigFile(target, { schemaVersion: 1 })).rejects.toThrow(
      `config save: rename onto target of ${target} failed (EIO)`,
    );
    expect(await readFile(target, "utf8")).toBe(OLD_BYTES);
    // The temp file was removed, not left behind (§7.3 item 2).
    expect(await readdir(work)).toEqual(["tier-scheduler.json"]);
  });
});

describe("concurrent same-path saves (§7.3 item 3)", () => {
  let work: string;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "ms-persist-concurrent-"));
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("serializes concurrent saves: the final file is one complete valid save", async () => {
    const target = resolve(work, "tier-scheduler.json");
    const layers: ConfigFile[] = [1, 2, 3, 4, 5, 6].map((i) => ({
      schemaVersion: 1,
      tiers: { brain: { candidates: [{ provider: "openai", id: `model-${i}` }] } },
    }));
    const log: OpRecord[] = [];
    __setFsForTests(opLog(log));
    await Promise.all(layers.map((layer) => saveConfigFile(target, layer)));
    __setFsForTests(null);

    // One complete valid save: byte-identical to a clean save of the winner.
    const finalText = await readFile(target, "utf8");
    const parsed = JSON.parse(finalText) as ConfigFile;
    const winner = layers.find((layer) => JSON.stringify(parsed) === JSON.stringify(layer));
    expect(winner).toBeDefined();
    const witnessDir = await mkdtemp(join(tmpdir(), "ms-persist-witness-"));
    try {
      const witness = resolve(witnessDir, "witness.json");
      await saveConfigFile(witness, winner!);
      expect(finalText).toBe(await readFile(witness, "utf8"));
    } finally {
      await rm(witnessDir, { recursive: true, force: true });
    }
    expect(await readdir(work)).toEqual(["tier-scheduler.json"]);

    // Serialization proof (§5.6): temp-opens and renames strictly alternate.
    const stream = log
      .filter(
        (record) =>
          record.op === "rename" ||
          (record.op === "openExclusive" && record.path.endsWith(".tmp")),
      )
      .map((record) => (record.op === "rename" ? "rename" : "open"));
    const expected: string[] = [];
    for (let i = 0; i < 6; i += 1) expected.push("open", "rename");
    expect(stream).toEqual(expected);
  });

  it("does not poison the queue: the save after a failed save still succeeds", async () => {
    const target = resolve(work, "tier-scheduler.json");
    await writeFile(target, "old bytes", "utf8");
    __setFsForTests(injectedFs({ write: once(/\.tmp$/) }));
    const layers: [ConfigFile, ConfigFile] = [
      { schemaVersion: 1, policy: { defaultBias: "high" } },
      { schemaVersion: 1, policy: { defaultBias: "low" } },
    ];
    // Enqueue order is not pinned (mkdir suspends before enqueue); only the
    // survival contract is: exactly one failure, one complete save, and no
    // interleaved bytes.
    const outcomes = await Promise.allSettled(layers.map((layer) => saveConfigFile(target, layer)));
    __setFsForTests(null);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === "rejected");
    expect(rejected).toBeDefined();
    expect(rejected && rejected.status === "rejected" && String(rejected.reason)).toContain(
      "config save: write temp file",
    );
    const winnerIndex = outcomes.findIndex((o) => o.status === "fulfilled");
    expect(winnerIndex).toBeGreaterThanOrEqual(0);
    const witnessDir = await mkdtemp(join(tmpdir(), "ms-persist-witness-"));
    try {
      const witness = resolve(witnessDir, "witness.json");
      await saveConfigFile(witness, layers[winnerIndex]);
      expect(await readFile(target, "utf8")).toBe(await readFile(witness, "utf8"));
    } finally {
      await rm(witnessDir, { recursive: true, force: true });
    }
    // No temp residue from the failed save.
    expect((await readdir(work)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });
});

describe("backupExisting pre-replace backups (§7.3 item 6)", () => {
  let work: string;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "ms-persist-backup-"));
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("backs up the current bytes to a .replaced-* sibling before the rename", async () => {
    const target = resolve(work, "tier-scheduler.json");
    const oldBytes = "not even close to json {{{";
    await writeFile(target, oldBytes, "utf8");
    await saveConfigFile(
      target,
      { schemaVersion: 1, policy: { defaultBias: "low" } },
      { backupExisting: true },
    );
    const backups = (await readdir(work)).filter((entry) =>
      entry.startsWith("tier-scheduler.json.replaced-"),
    );
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^tier-scheduler\.json\.replaced-\d{8}T\d{6}\.\d{3}Z-\d+$/);
    expect(await readFile(join(work, backups[0]), "utf8")).toBe(oldBytes);
    expect(await readFile(target, "utf8")).toBe(
      '{\n  "schemaVersion": 1,\n  "policy": {\n    "defaultBias": "low"\n  }\n}\n',
    );
  });

  it("fails the whole save, target untouched, when the backup cannot be created", async () => {
    const target = resolve(work, "tier-scheduler.json");
    const oldBytes = "{ schemaVersion: definitely not json";
    await writeFile(target, oldBytes, "utf8");
    __setFsForTests(injectedFs({ openExclusive: once(/\.replaced-/, "EACCES") }));
    await expect(
      saveConfigFile(target, { schemaVersion: 1 }, { backupExisting: true }),
    ).rejects.toThrow(`config save: back up existing target of ${target} failed (EACCES)`);
    expect(await readFile(target, "utf8")).toBe(oldBytes);
    expect((await readdir(work)).filter((entry) => entry.includes(".replaced-"))).toEqual([]);
  });

  it("performs no backup for a missing target and still succeeds", async () => {
    const target = resolve(work, "tier-scheduler.json");
    await saveConfigFile(target, { schemaVersion: 1 }, { backupExisting: true });
    expect(await readdir(work)).toEqual(["tier-scheduler.json"]);
  });

  it("performs no new backup for a loader-quarantined target and still succeeds", async () => {
    const projectDir = resolve(work, "proj");
    const paths = resolveConfigPaths({ cwd: projectDir, env: {}, homeDir: work });
    await mkdir(dirname(paths.userPath), { recursive: true });
    await writeFile(paths.userPath, "{malformed", "utf8");
    const loaded = await loadEffectiveConfig({ cwd: projectDir, env: {}, homeDir: work });
    expect(loaded.problems[0]).toMatchObject({ code: "NOT_JSON", severity: "warning" });
    await saveConfigFile(paths.userPath, { schemaVersion: 1 }, { backupExisting: true });
    const entries = await readdir(dirname(paths.userPath));
    expect(entries.filter((entry) => entry.includes(".replaced-"))).toEqual([]);
    expect(entries.filter((entry) => entry.includes(".corrupt-"))).toHaveLength(1);
    expect(await readFile(paths.userPath, "utf8")).toBe('{\n  "schemaVersion": 1\n}\n');
  });

  it("keeps at most the three newest .replaced-* backups per target (§5.5 pruning)", async () => {
    const target = resolve(work, "tier-scheduler.json");
    await writeFile(target, "seed", "utf8");
    for (let i = 0; i < 5; i += 1) {
      await saveConfigFile(
        target,
        { schemaVersion: 1, policy: { defaultBias: "low" } },
        { backupExisting: true },
      );
    }
    const backups = (await readdir(work))
      .filter((entry) => entry.startsWith("tier-scheduler.json.replaced-"))
      .sort();
    expect(backups).toHaveLength(3);
    // The newest backup holds the bytes the target had before the last save.
    const witnessDir = await mkdtemp(join(tmpdir(), "ms-persist-prune-"));
    try {
      const witness = resolve(witnessDir, "witness.json");
      await saveConfigFile(witness, { schemaVersion: 1, policy: { defaultBias: "low" } });
      expect(await readFile(join(work, backups[backups.length - 1]), "utf8")).toBe(
        await readFile(witness, "utf8"),
      );
    } finally {
      await rm(witnessDir, { recursive: true, force: true });
    }
  });

  it("refuses to replace a directory target even with backupExisting", async () => {
    const target = resolve(work, "tier-scheduler.json");
    await mkdir(target);
    await expect(
      saveConfigFile(target, { schemaVersion: 1 }, { backupExisting: true }),
    ).rejects.toThrow(`config save: back up existing target of ${target} failed (EISDIR)`);
    expect((await stat(target)).isDirectory()).toBe(true);
  });
});

describe("load → save → load round-trip (§7.3 item 7)", () => {
  let work: string;
  let home2: string;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "ms-persist-roundtrip-"));
    home2 = await mkdtemp(join(tmpdir(), "ms-persist-roundtrip2-"));
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
    await rm(home2, { recursive: true, force: true });
  });

  it("produces semantically equal effective values and preserved candidate order", async () => {
    const projectDir = resolve(work, "proj");
    const paths = resolveConfigPaths({ cwd: projectDir, env: {}, homeDir: work });
    await mkdir(dirname(paths.userPath), { recursive: true });
    // Noisy on-disk formatting: shuffled keys, 4-space indent — the save
    // normalizes to canonical JSON but the loaded values must not care.
    await writeFile(
      paths.userPath,
      JSON.stringify(
        {
          policy: { defaultBias: "low", sticky: false },
          schemaVersion: 1,
          tiers: {
            crowd: { candidates: [{ id: "glm-4", provider: "z-ai" }] },
            brain: {
              candidates: [
                { id: "gpt-5", provider: "openai" },
                { id: "claude-x", provider: "anthropic" },
              ],
            },
          },
          retry: { maxTierSwitches: 3, maxAttemptsPerRequest: 4 },
        },
        null,
        4,
      ),
      "utf8",
    );
    const first = await loadEffectiveConfig({ cwd: projectDir, env: {}, homeDir: work });
    expect(first.problems).toEqual([]);
    const { provenance: _first, ...configPart } = first.effective;

    const paths2 = resolveConfigPaths({ cwd: projectDir, env: {}, homeDir: home2 });
    await saveConfigFile(paths2.userPath, configPart);

    const second = await loadEffectiveConfig({ cwd: projectDir, env: {}, homeDir: home2 });
    expect(second.problems).toEqual([]);
    const { provenance: _second, ...roundTripped } = second.effective;
    expect(roundTripped).toEqual(configPart);
    // Candidate order survives the round-trip verbatim (§7.3 item 7).
    expect(roundTripped.tiers.brain.candidates).toEqual(configPart.tiers.brain.candidates);
  });
});
