import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readLayer, resolveConfigPaths } from "../../src/config/discover";
import { DEFAULT_CONFIG, loadEffectiveConfig, mergeConfig } from "../../src/config/index";
import { layerStatusOf } from "../../src/config/types";

/**
 * Discovery tests (02-config.md §7.2 items 1 and 4): real temporary
 * directories, no mock filesystem. Classification matrix:
 * missing / valid / invalid(JSON) / invalid(schema) / unreadable(dir) /
 * unreadable(chmod 000), plus PI_CODING_AGENT_DIR precedence, the §5.5
 * quarantine of malformed JSON (bytes preserved in a `.corrupt-*` sibling,
 * next load sees missing), the BACKUP_FAILED escalation when quarantine
 * cannot write, and the stays-in-place guarantee for schema-invalid layers.
 */

// POSIX-only APIs are guarded so the same file compiles and runs on Windows.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const supportsChmodDeny = platform() !== "win32" && !isRoot;
const supportsSymlink = platform() !== "win32";

describe("resolveConfigPaths", () => {
  // Non-existent directories prove the derivation is pure path math: no
  // stat, no existence probing, no filesystem writes (§5.2).
  const homeDir = resolve(tmpdir(), "ms-discover-home-does-not-exist");
  const cwd = resolve(tmpdir(), "ms-discover-cwd-does-not-exist");

  it("derives user and project paths from homeDir and cwd when no env override is set (§7.2 item 1)", () => {
    const paths = resolveConfigPaths({ cwd, env: {}, homeDir });
    expect(paths.userPath).toBe(resolve(homeDir, ".pi", "agent", "tier-scheduler.json"));
    expect(paths.projectPath).toBe(resolve(cwd, ".pi", "tier-scheduler.json"));
  });

  it("replaces only the user path when PI_CODING_AGENT_DIR is a non-empty string (§7.2 item 1)", () => {
    const agentDir = resolve(tmpdir(), "ms-discover-agent-override");
    const paths = resolveConfigPaths({
      cwd,
      env: { PI_CODING_AGENT_DIR: agentDir },
      homeDir,
    });
    expect(paths.userPath).toBe(resolve(agentDir, "tier-scheduler.json"));
    expect(paths.projectPath).toBe(resolve(cwd, ".pi", "tier-scheduler.json"));
  });

  it("treats an empty PI_CODING_AGENT_DIR as unset and falls back to homeDir (§7.2 item 1)", () => {
    const paths = resolveConfigPaths({
      cwd,
      env: { PI_CODING_AGENT_DIR: "" },
      homeDir,
    });
    expect(paths.userPath).toBe(resolve(homeDir, ".pi", "agent", "tier-scheduler.json"));
    expect(paths.projectPath).toBe(resolve(cwd, ".pi", "tier-scheduler.json"));
  });

  it("never searches upward: the project path is exactly <cwd>/.pi/tier-scheduler.json (§7.2 item 4)", () => {
    const deepCwd = resolve(tmpdir(), "ms-discover-parent", "child", "grandchild");
    const paths = resolveConfigPaths({ cwd: deepCwd, env: {}, homeDir });
    expect(paths.projectPath).toBe(resolve(deepCwd, ".pi", "tier-scheduler.json"));
  });
});

describe("readLayer classification", () => {
  let home: string;
  let projectDir: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ms-discover-home-"));
    projectDir = await mkdtemp(join(tmpdir(), "ms-discover-project-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it("classifies an absent file as missing without a problem", async () => {
    const path = resolve(home, "tier-scheduler.json");
    const result = await readLayer(path, "user");
    expect(result).toEqual({ kind: "missing", source: "user", path });
    expect(layerStatusOf(result)).toBe("missing");
  });

  it("classifies a minimal {\"schemaVersion\": 1} layer as valid (§7.2 item 2)", async () => {
    const path = resolve(home, "tier-scheduler.json");
    await writeFile(path, JSON.stringify({ schemaVersion: 1 }), "utf8");
    const result = await readLayer(path, "user");
    expect(result.kind).toBe("valid");
    expect(layerStatusOf(result)).toBe("loaded");
    if (result.kind !== "valid") throw new Error("unreachable");
    expect(result.source).toBe("user");
    expect(result.path).toBe(path);
    expect(result.value).toEqual({ schemaVersion: 1 });
  });

  it("classifies a partial layer with a policy override as valid", async () => {
    const path = resolve(home, "tier-scheduler.json");
    const layer = { schemaVersion: 1, policy: { defaultBias: "low" } };
    await writeFile(path, JSON.stringify(layer), "utf8");
    const result = await readLayer(path, "user");
    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") throw new Error("unreachable");
    expect(result.value).toEqual(layer);
  });

  it("quarantines malformed JSON to a .corrupt-* sibling and reports a NOT_JSON warning (§5.5)", async () => {
    const path = resolve(home, "tier-scheduler.json");
    const rawBytes = '{"schemaVersion": 1, "not json';
    await writeFile(path, rawBytes, "utf8");
    const result = await readLayer(path, "user");
    expect(result.kind).toBe("invalid");
    expect(layerStatusOf(result)).toBe("invalid");
    if (result.kind !== "invalid") throw new Error("unreachable");
    expect(result.problems).toEqual([
      {
        source: "user",
        path: "",
        severity: "warning",
        code: "NOT_JSON",
        message: "config layer is not valid JSON",
        backupPath: expect.stringMatching(/\.corrupt-\d{8}T\d{6}\.\d{3}Z-\d+$/),
      },
    ]);
    // §5.5: the original moved away and its exact bytes live in the backup.
    const entries = await readdir(home);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^tier-scheduler\.json\.corrupt-\d{8}T\d{6}\.\d{3}Z-\d+$/);
    expect(await readFile(join(home, entries[0]), "utf8")).toBe(rawBytes);
    // The next read sees the target as missing — not a problem (§3.3).
    const next = await readLayer(path, "user");
    expect(next).toEqual({ kind: "missing", source: "user", path });
    expect(layerStatusOf(next)).toBe("missing");
  });

  it("preserves non-UTF-8 bytes byte-for-byte in the quarantine backup (§5.5)", async () => {
    const path = resolve(home, "tier-scheduler.json");
    const rawBytes = Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x7d, 0x89]); // '{"' + invalid UTF-8 + '}'
    await writeFile(path, rawBytes);
    const result = await readLayer(path, "user");
    expect(result.kind).toBe("invalid");
    const entries = await readdir(home);
    expect(entries).toHaveLength(1);
    const backup = join(home, entries[0]);
    expect(backup).toMatch(/\.corrupt-/);
    expect(await readFile(backup)).toEqual(rawBytes);
  });

  it.runIf(supportsChmodDeny)(
    "keeps the malformed file and escalates to BACKUP_FAILED when quarantine cannot write (§5.5)",
    async () => {
      const path = resolve(home, "tier-scheduler.json");
      const rawBytes = "{not json at all";
      await writeFile(path, rawBytes, "utf8");
      await chmod(home, 0o555); // readable but not writable: the backup cannot be created
      try {
        const result = await readLayer(path, "user");
        expect(result.kind).toBe("invalid");
        if (result.kind !== "invalid") throw new Error("unreachable");
        expect(result.problems).toHaveLength(1);
        expect(result.problems[0]).toMatchObject({
          source: "user",
          path: "",
          severity: "error",
          code: "BACKUP_FAILED",
        });
        expect(result.problems[0].message).toContain("EACCES");
        expect(result.problems[0].backupPath).toBeUndefined();
        // The original bytes stay in place — nothing was lost (§5.5).
        expect(await readFile(path, "utf8")).toBe(rawBytes);
      } finally {
        await chmod(home, 0o755);
      }
    },
  );

  it("keeps at most the three newest .corrupt-* backups per target (§5.5 pruning)", async () => {
    const path = resolve(home, "tier-scheduler.json");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await writeFile(path, `{"attempt": ${attempt}, "still": "not json"`, "utf8");
      const result = await readLayer(path, "user");
      expect(result.kind).toBe("invalid");
    }
    const backups = (await readdir(home))
      .filter((entry) => entry.startsWith("tier-scheduler.json.corrupt-"))
      .sort();
    expect(backups).toHaveLength(3);
    // The newest backup holds the last quarantined bytes; the two oldest were pruned.
    const newest = backups[backups.length - 1];
    expect(await readFile(join(home, newest), "utf8")).toContain('"attempt": 4');
    // Nothing else remains in the directory.
    expect(await readdir(home)).toEqual(backups);
  });

  it("classifies a schema-invalid layer as invalid with severity-error problems, file kept in place (§3.3)", async () => {
    const path = resolve(home, "tier-scheduler.json");
    const raw = JSON.stringify({ schemaVersion: 1, unknownRoot: 1 });
    await writeFile(path, raw, "utf8");
    const result = await readLayer(path, "user");
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") throw new Error("unreachable");
    expect(result.problems).toEqual([
      {
        source: "user",
        path: "unknownRoot",
        severity: "error",
        code: "UNKNOWN_KEY",
        message: 'unknown root key "unknownRoot"',
      },
    ]);
    // An actionable typo stays where the user can edit it (§3.3).
    expect(await readFile(path, "utf8")).toBe(raw);
    expect(await readdir(home)).toEqual(["tier-scheduler.json"]);
  });

  it("reports a schemaVersion mismatch with the stable unsupported-version code (§3.2)", async () => {
    const path = resolve(home, "tier-scheduler.json");
    await writeFile(path, JSON.stringify({ schemaVersion: 2 }), "utf8");
    const result = await readLayer(path, "user");
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") throw new Error("unreachable");
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({
      source: "user",
      path: "schemaVersion",
      severity: "error",
      code: "SCHEMA_VERSION_UNSUPPORTED",
    });
  });

  it("classifies a directory target as unreadable, not missing (§5.2)", async () => {
    const path = resolve(projectDir, ".pi");
    await mkdir(path);
    const result = await readLayer(path, "project");
    expect(result.kind).toBe("unreadable");
    expect(layerStatusOf(result)).toBe("unreadable");
    if (result.kind !== "unreadable") throw new Error("unreachable");
    expect(result.problems).toEqual([
      {
        source: "project",
        path: "",
        severity: "error",
        code: "UNREADABLE_FILE",
        message: "config target is not a regular file",
      },
    ]);
  });

  it.runIf(supportsChmodDeny)("classifies a permission-denied file as unreadable (chmod 000)", async () => {
    const path = resolve(home, "tier-scheduler.json");
    await writeFile(path, JSON.stringify({ schemaVersion: 1 }), "utf8");
    await chmod(path, 0o000);
    try {
      const result = await readLayer(path, "user");
      expect(result.kind).toBe("unreadable");
      if (result.kind !== "unreadable") throw new Error("unreachable");
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]).toMatchObject({
        source: "user",
        path: "",
        severity: "error",
        code: "UNREADABLE_FILE",
      });
      // Message carries the errno token, never the raw fs text or a path.
      expect(result.problems[0].message).toContain("EACCES");
      expect(result.problems[0].message).not.toContain(path);
    } finally {
      await chmod(path, 0o644);
    }
  });

  it.runIf(supportsSymlink)("follows a symlink to a regular file (stat, not lstat)", async () => {
    const target = resolve(home, "real-config.json");
    const link = resolve(home, "tier-scheduler.json");
    await writeFile(target, JSON.stringify({ schemaVersion: 1 }), "utf8");
    await symlink(target, link);
    const result = await readLayer(link, "user");
    expect(result.kind).toBe("valid");
    if (result.kind !== "valid") throw new Error("unreachable");
    expect(result.path).toBe(link);
    expect(result.value).toEqual({ schemaVersion: 1 });
  });
});

describe("loadEffectiveConfig layers — per-layer status derivation (F5.1 seam)", () => {
  let homeRoot: string;
  let projectRoot: string;

  beforeEach(async () => {
    homeRoot = await mkdtemp(join(tmpdir(), "ms-layers-home-"));
    projectRoot = await mkdtemp(join(tmpdir(), "ms-layers-project-"));
  });

  afterEach(async () => {
    await rm(homeRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  const userPath = () => resolve(homeRoot, ".pi", "agent", "tier-scheduler.json");
  const projectPath = () => resolve(projectRoot, ".pi", "tier-scheduler.json");

  async function writeLayer(path: string, raw: string): Promise<void> {
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, raw, "utf8");
  }

  function load() {
    return loadEffectiveConfig({ cwd: projectRoot, env: {}, homeDir: homeRoot });
  }

  it("reports both layers as missing when no file exists", async () => {
    const result = await load();
    expect(result.layers).toEqual({ user: "missing", project: "missing" });
  });

  it("derives loaded/missing from the layer reads, not from problems", async () => {
    await writeLayer(userPath(), JSON.stringify({ schemaVersion: 1 }));
    const result = await load();
    expect(result.layers).toEqual({ user: "loaded", project: "missing" });
    expect(result.problems).toEqual([]);
  });

  it("reports invalid for a schema-invalid layer alongside a valid one", async () => {
    await writeLayer(userPath(), JSON.stringify({ schemaVersion: 1, nonsense: true }));
    await writeLayer(projectPath(), JSON.stringify({ schemaVersion: 1 }));
    const result = await load();
    expect(result.layers).toEqual({ user: "invalid", project: "loaded" });
  });

  it("reports unreadable distinctly from invalid (directory target)", async () => {
    await writeLayer(userPath(), JSON.stringify({ schemaVersion: 1 }));
    await mkdir(resolve(projectRoot, ".pi"), { recursive: true });
    await mkdir(projectPath()); // directory target at the project layer path
    const result = await load();
    expect(result.layers).toEqual({ user: "loaded", project: "unreadable" });
  });

  it("never puts the layer paths or raw text into the layers field", async () => {
    const result = await load();
    expect(JSON.stringify(result.layers)).not.toContain(homeRoot);
    expect(JSON.stringify(result.layers)).not.toContain(projectRoot);
  });
});

describe("loadEffectiveConfig integration (§7.2 items 2/4/5)", () => {
  let homeRoot: string;
  let projectRoot: string;

  beforeEach(async () => {
    homeRoot = await mkdtemp(join(tmpdir(), "ms-load-home-"));
    projectRoot = await mkdtemp(join(tmpdir(), "ms-load-project-"));
  });

  afterEach(async () => {
    await rm(homeRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  const userPath = () => resolve(homeRoot, ".pi", "agent", "tier-scheduler.json");
  const projectPath = () => resolve(projectRoot, ".pi", "tier-scheduler.json");

  async function writeUserLayer(raw: string): Promise<void> {
    await mkdir(resolve(homeRoot, ".pi", "agent"), { recursive: true });
    await writeFile(userPath(), raw, "utf8");
  }

  async function writeProjectLayer(raw: string): Promise<void> {
    await mkdir(resolve(projectRoot, ".pi"), { recursive: true });
    await writeFile(projectPath(), raw, "utf8");
  }

  function load(): Promise<Awaited<ReturnType<typeof loadEffectiveConfig>>> {
    return loadEffectiveConfig({ cwd: projectRoot, env: {}, homeDir: homeRoot });
  }

  it("returns the defaults baseline with no problems when both layers are missing (§7.2 item 2)", async () => {
    const result = await load();
    expect(result.problems).toEqual([]);
    expect(result.paths.userPath).toBe(userPath());
    expect(result.paths.projectPath).toBe(projectPath());
    expect(result.effective).toEqual(mergeConfig(DEFAULT_CONFIG));
    expect(result.effective.provenance["policy.defaultBias"]).toBe("defaults");
  });

  it("applies a valid user layer over defaults (§7.2 item 2)", async () => {
    await writeUserLayer(JSON.stringify({ schemaVersion: 1, policy: { defaultBias: "low" } }));
    const result = await load();
    expect(result.problems).toEqual([]);
    expect(result.effective.policy).toEqual({ defaultBias: "low", sticky: true });
    expect(result.effective.provenance["policy.defaultBias"]).toBe("user");
    expect(result.effective.provenance["policy.sticky"]).toBe("defaults");
  });

  it("lets project override user while unmentioned leaves inherit (§7.2 item 2)", async () => {
    await writeUserLayer(
      JSON.stringify({
        schemaVersion: 1,
        policy: { defaultBias: "low" },
        tiers: { brain: { candidates: [{ provider: "openai", id: "gpt-5" }] } },
      }),
    );
    await writeProjectLayer(
      JSON.stringify({
        schemaVersion: 1,
        policy: { defaultBias: "high" },
        retry: { maxAttemptsPerRequest: 5 },
      }),
    );
    const result = await load();
    expect(result.problems).toEqual([]);
    expect(result.effective.policy).toEqual({ defaultBias: "high", sticky: true });
    expect(result.effective.tiers.brain.candidates).toEqual([{ provider: "openai", id: "gpt-5" }]);
    expect(result.effective.retry).toEqual({ maxAttemptsPerRequest: 5, maxTierSwitches: 2 });
    expect(result.effective.provenance).toEqual({
      schemaVersion: "project",
      "tiers.brain.candidates": "user",
      "tiers.pillar.candidates": "defaults",
      "tiers.crowd.candidates": "defaults",
      "policy.defaultBias": "project",
      "policy.sticky": "defaults",
      "retry.maxAttemptsPerRequest": "project",
      "retry.maxTierSwitches": "defaults",
    });
  });

  it("never searches parent directories for the project layer (§7.2 item 4)", async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), "ms-load-parent-"));
    try {
      await mkdir(resolve(parentRoot, ".pi"), { recursive: true });
      await writeFile(
        resolve(parentRoot, ".pi", "tier-scheduler.json"),
        JSON.stringify({
          schemaVersion: 1,
          tiers: { brain: { candidates: [{ provider: "parent", id: "parent-only" }] } },
        }),
        "utf8",
      );
      const childRoot = resolve(parentRoot, "child");
      await mkdir(childRoot);
      const result = await loadEffectiveConfig({ cwd: childRoot, env: {}, homeDir: homeRoot });
      expect(result.paths.projectPath).toBe(resolve(childRoot, ".pi", "tier-scheduler.json"));
      // The parent's candidate was never read; the child has no layer of its own.
      expect(result.effective.tiers.brain.candidates).toEqual([]);
      expect(result.problems).toEqual([]);
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  it("reports an invalid user layer but still merges the valid project layer (§7.2 item 5)", async () => {
    await writeUserLayer(JSON.stringify({ schemaVersion: 1, unknownRoot: true }));
    await writeProjectLayer(JSON.stringify({ schemaVersion: 1, policy: { defaultBias: "high" } }));
    const result = await load();
    expect(result.problems).toEqual([
      {
        source: "user",
        path: "unknownRoot",
        severity: "error",
        code: "UNKNOWN_KEY",
        message: 'unknown root key "unknownRoot"',
      },
    ]);
    expect(result.effective.policy.defaultBias).toBe("high");
    expect(result.effective.provenance["policy.defaultBias"]).toBe("project");
    expect(result.effective.policy.sticky).toBe(true);
  });

  it("reports a version-mismatched layer and keeps lower layers usable (§7.2 item 5)", async () => {
    await writeUserLayer(JSON.stringify({ schemaVersion: 2 }));
    await writeProjectLayer(JSON.stringify({ schemaVersion: 1, policy: { defaultBias: "low" } }));
    const result = await load();
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({
      source: "user",
      path: "schemaVersion",
      severity: "error",
      code: "SCHEMA_VERSION_UNSUPPORTED",
    });
    expect(result.effective.policy.defaultBias).toBe("low");
    expect(result.effective.provenance["policy.defaultBias"]).toBe("project");
  });

  it("reports an unreadable project layer (directory target) while the user layer still applies (§7.2 item 5)", async () => {
    await writeUserLayer(JSON.stringify({ schemaVersion: 1, policy: { defaultBias: "low" } }));
    await mkdir(resolve(projectRoot, ".pi"), { recursive: true });
    await mkdir(projectPath()); // the layer path itself is a directory
    const result = await load();
    expect(result.problems).toEqual([
      {
        source: "project",
        path: "",
        severity: "error",
        code: "UNREADABLE_FILE",
        message: "config target is not a regular file",
      },
    ]);
    expect(result.effective.policy.defaultBias).toBe("low");
    expect(result.effective.provenance["policy.defaultBias"]).toBe("user");
  });

  it("quarantines a non-JSON user layer as a warning and falls back to defaults (§7.2 item 5)", async () => {
    const raw = '{"schemaVersion": 1, "oops';
    await writeUserLayer(raw);
    const result = await load();
    expect(result.problems).toEqual([
      {
        source: "user",
        path: "",
        severity: "warning",
        code: "NOT_JSON",
        message: "config layer is not valid JSON",
        backupPath: expect.stringMatching(/\.corrupt-\d{8}T\d{6}\.\d{3}Z-\d+$/),
      },
    ]);
    expect(result.effective).toEqual(mergeConfig(DEFAULT_CONFIG));
    const agentDir = resolve(homeRoot, ".pi", "agent");
    const entries = await readdir(agentDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^tier-scheduler\.json\.corrupt-/);
    expect(await readFile(join(agentDir, entries[0]), "utf8")).toBe(raw);
  });

  it("quarantines a malformed project layer and keeps the user layer's values (§7.2 item 5)", async () => {
    await writeUserLayer(JSON.stringify({ schemaVersion: 1, policy: { defaultBias: "low" } }));
    await writeProjectLayer("{oops");
    const result = await load();
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({
      source: "project",
      path: "",
      severity: "warning",
      code: "NOT_JSON",
    });
    expect(result.problems[0].backupPath).toMatch(/\.corrupt-/);
    expect(result.effective.policy.defaultBias).toBe("low");
    expect(result.effective.provenance["policy.defaultBias"]).toBe("user");
    const entries = await readdir(resolve(projectRoot, ".pi"));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^tier-scheduler\.json\.corrupt-/);
  });

  it("quarantines the malformed user layer but leaves the schema-invalid project file in place (§5.5)", async () => {
    await writeUserLayer("{not json at all");
    await writeProjectLayer(JSON.stringify({ schemaVersion: 1, nonsense: 1 }));
    await load();
    const userEntries = await readdir(resolve(homeRoot, ".pi", "agent"));
    expect(userEntries).toHaveLength(1);
    expect(userEntries[0]).toMatch(/^tier-scheduler\.json\.corrupt-/);
    // Schema-invalid JSON is never renamed: it stays the user's repairable
    // source of truth while the layer is skipped (§5.5).
    expect(await readdir(resolve(projectRoot, ".pi"))).toEqual(["tier-scheduler.json"]);
    expect(JSON.parse(await readFile(projectPath(), "utf8"))).toEqual({
      schemaVersion: 1,
      nonsense: 1,
    });
  });
});
