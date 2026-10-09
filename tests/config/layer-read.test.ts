import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readConfigLayerForEdit } from "../../src/config/layer-read";
import type { EditableConfigLayer } from "../../src/config/layer-read";

/**
 * Read-only layer adapter tests (07-tui-modes.md §7.1 hook 1/2; F7.1 spec
 * §7.2 hooks 1–2): the four-state classification over real temporary
 * directories, PI_CODING_AGENT_DIR honored through the Phase 2 path
 * resolver, stable problem codes, clone isolation for valid layers, and
 * the stays-in-place guarantee a declined replacement depends on. No mock
 * filesystem; the malformed-JSON case documents the inherited Phase 2 §5.5
 * quarantine rather than re-testing its byte-level contract.
 */

let home: string;
let project: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ms-layerread-home-"));
  project = await mkdtemp(join(tmpdir(), "ms-layerread-project-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

async function writeProjectLayer(raw: string): Promise<string> {
  await mkdir(resolve(project, ".pi"), { recursive: true });
  const target = resolve(project, ".pi", "tier-scheduler.json");
  await writeFile(target, raw, "utf8");
  return target;
}

async function readProjectTarget(): Promise<string | undefined> {
  try {
    return await readFile(resolve(project, ".pi", "tier-scheduler.json"), "utf8");
  } catch {
    return undefined;
  }
}

function probe(
  scope: "user" | "project",
  overrides: { env?: NodeJS.ProcessEnv; homeDir?: string } = {},
): Promise<EditableConfigLayer> {
  return readConfigLayerForEdit({
    scope,
    cwd: project,
    ...(overrides.env !== undefined ? { env: overrides.env } : {}),
    ...(overrides.homeDir !== undefined ? { homeDir: overrides.homeDir } : {}),
  });
}

describe("readConfigLayerForEdit — classification matrix", () => {
  it("classifies a missing project target and starts from { schemaVersion: 1 } (hook 1)", async () => {
    const layer = await probe("project", { env: {}, homeDir: home });
    expect(layer.status).toBe("missing");
    expect(layer.scope).toBe("project");
    expect(layer.value).toEqual({ schemaVersion: 1 });
    expect(layer.problemCodes).toEqual([]);
    expect(layer.targetPath).toBe(resolve(project, ".pi", "tier-scheduler.json"));
  });

  it("resolves a missing user target under the injected agent directory; PI_CODING_AGENT_DIR wins (hook 1)", async () => {
    const agentDir = resolve(home, "agent-override");
    const layer = await probe("user", { env: { PI_CODING_AGENT_DIR: agentDir }, homeDir: home });
    expect(layer.status).toBe("missing");
    expect(layer.targetPath).toBe(resolve(agentDir, "tier-scheduler.json"));

    const fallback = await probe("user", { env: {}, homeDir: home });
    expect(fallback.targetPath).toBe(resolve(home, ".pi", "agent", "tier-scheduler.json"));
  });

  it("clones a valid partial layer without flattening or reordering it (hook 2)", async () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      tiers: {
        brain: { candidates: [{ provider: "acme", id: "b2" }, { provider: "acme", id: "b1" }] },
      },
      policy: { defaultBias: "high" },
    });
    await writeProjectLayer(raw);

    const layer = await probe("project", { env: {}, homeDir: home });
    expect(layer.status).toBe("valid");
    expect(layer.problemCodes).toEqual([]);
    expect(layer.value).toEqual(JSON.parse(raw));
    // Authored order is preserved verbatim, not sorted or deduplicated.
    expect(layer.value.tiers?.brain?.candidates?.map((c) => c.id)).toEqual(["b2", "b1"]);
    // Partial-layer semantics survive: nothing was filled in from defaults.
    expect(layer.value.tiers?.pillar).toBeUndefined();
    expect(layer.value.policy).toEqual({ defaultBias: "high" });
    expect(layer.value.retry).toBeUndefined();
  });

  it("returns a fresh clone per call: mutating the result never corrupts the source", async () => {
    await writeProjectLayer(
      JSON.stringify({ schemaVersion: 1, policy: { sticky: false } }),
    );
    const first = await probe("project", { env: {}, homeDir: home });
    const second = await probe("project", { env: {}, homeDir: home });
    expect(first.value).not.toBe(second.value);
    expect(first.value.policy).not.toBe(second.value.policy);

    first.value.policy!.sticky = true;
    expect(second.value.policy?.sticky).toBe(false);
    expect(await readProjectTarget()).toBe(
      JSON.stringify({ schemaVersion: 1, policy: { sticky: false } }),
    );
  });

  it("reports a schema-invalid layer with stable codes and leaves it byte-for-byte in place (hook 2)", async () => {
    const raw = `${JSON.stringify({
      schemaVersion: 1,
      retry: { maxAttemptsPerRequest: 99 },
    })}\n`;
    await writeProjectLayer(raw);

    const layer = await probe("project", { env: {}, homeDir: home });
    expect(layer.status).toBe("invalid");
    expect(layer.problemCodes).toContain("BOUNDS_EXCEEDED");
    // A declined replacement performs no write: the bytes are untouched.
    expect(await readProjectTarget()).toBe(raw);
  });

  it("reports an unreadable target (non-regular file) with the stable code", async () => {
    await mkdir(resolve(project, ".pi", "tier-scheduler.json"), { recursive: true });
    const layer = await probe("project", { env: {}, homeDir: home });
    expect(layer.status).toBe("unreadable");
    expect(layer.problemCodes).toEqual(["UNREADABLE_FILE"]);
    expect(layer.value).toEqual({ schemaVersion: 1 });
  });

  it("reports malformed JSON as invalid with NOT_JSON; the Phase 2 quarantine preserves the bytes", async () => {
    await writeProjectLayer("{ not json");
    const layer = await probe("project", { env: {}, homeDir: home });
    expect(layer.status).toBe("invalid");
    expect(layer.problemCodes).toEqual(["NOT_JSON"]);

    // Inherited Phase 2 §5.5 load-path recovery: the probe quarantined the
    // malformed target, so the original bytes survive in a `.corrupt-*`
    // sibling and the target itself is gone for the save step.
    const dirEntries = await readdir(resolve(project, ".pi"));
    expect(dirEntries.some((entry) => entry.startsWith("tier-scheduler.json.corrupt-"))).toBe(true);
    expect(await readProjectTarget()).toBeUndefined();
  });

  it("never lets the target path leak into a problem code list (bounded codes only)", async () => {
    await writeProjectLayer(JSON.stringify({ schemaVersion: 2 }));
    const layer = await probe("project", { env: {}, homeDir: home });
    expect(layer.status).toBe("invalid");
    for (const code of layer.problemCodes) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(code).not.toContain("/");
    }
  });
});
