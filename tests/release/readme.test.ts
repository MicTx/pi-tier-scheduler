import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseTsCommand } from "../../src/commands/parser";
import { validateConfigLayer } from "../../src/config/schema";
import { MINIMUM_PI_VERSION } from "../../src/diag/compatibility";

/**
 * README executable-documentation smoke (08-release.md §3.5 closing rule,
 * §5.3, §7.2 hooks 1/4/9): the README is treated as a contract, not prose.
 *
 *   - every fenced config JSON block is validated by the real Phase 2 schema
 *     validator, so a snippet can never drift from `tier-scheduler.json`'s
 *     actual shape;
 *   - every fenced shell command must resolve against the real package.json
 *     scripts, the registered `/ts` command grammar, or the documented Pi
 *     install/remove surface;
 *   - the documented command forms must all be present;
 *   - every relative markdown link target must exist in the tree;
 *   - the private/secret scan keeps release-facing text leak-free.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const readme = readFileSync(resolve(REPO_ROOT, "README.md"), "utf8");
const changelog = readFileSync(resolve(REPO_ROOT, "CHANGELOG.md"), "utf8");
const packageJson = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
  version: string;
  scripts: Record<string, string>;
};

type Fence = { lang: string; body: string };

function fencedBlocks(markdown: string): Fence[] {
  const fences: Fence[] = [];
  const pattern = /```(\w*)\n([\s\S]*?)```/g;
  for (const match of markdown.matchAll(pattern)) {
    fences.push({ lang: match[1] ?? "", body: match[2] ?? "" });
  }
  return fences;
}

describe("README config snippets validate against the real schema", () => {
  const configFences = fencedBlocks(readme).filter((fence) => {
    if (fence.lang !== "json") return false;
    try {
      return typeof JSON.parse(fence.body) === "object";
    } catch {
      return false;
    }
  });

  it("has at least one config example", () => {
    expect(configFences.length).toBeGreaterThan(0);
  });

  it("validates every config snippet with the Phase 2 layer validator", () => {
    for (const fence of configFences) {
      const parsed: unknown = JSON.parse(fence.body);
      const result = validateConfigLayer(parsed, "readme-snippet");
      expect(result.ok, JSON.stringify(result)).toBe(true);
    }
  });

  it("the complete example shows every documented config field (hook 3)", () => {
    const example = configFences.at(-1)!.body;
    const config = JSON.parse(example) as {
      schemaVersion: number;
      tiers: Record<string, { candidates: unknown[] }>;
      policy: Record<string, unknown>;
      retry: Record<string, unknown>;
    };
    expect(config.schemaVersion).toBe(1);
    expect(Object.keys(config.tiers).sort()).toEqual(["brain", "crowd", "pillar"]);
    expect(config.policy).toHaveProperty("defaultBias");
    expect(config.policy).toHaveProperty("sticky");
    expect(config.retry).toHaveProperty("maxAttemptsPerRequest");
    expect(config.retry).toHaveProperty("maxTierSwitches");
    // Example IDs are provider/id pairs the schema can actually express.
    for (const tier of Object.values(config.tiers)) {
      expect(tier.candidates.length).toBeGreaterThan(0);
    }
  });
});

describe("README shell snippets align with the real command surface", () => {
  /** Commands the README may legitimately document outside npm//ts. */
  const PI_COMMAND_ALLOWLIST: readonly string[] = [
    "pi install ./",
    "pi remove ./",
    "pi -e ./",
    // Public channels (README "Public channels"); both verified end to end
    // with isolated install/load/remove cycles before being documented.
    "pi install git:github.com/MicTx/pi-tier-scheduler@v0.2.0",
    "pi install npm:pi-tier-scheduler",
  ];

  const shellFences = fencedBlocks(readme).filter((fence) => fence.lang === "sh");

  it("documents both installation paths (hook 2)", () => {
    const commands = shellFences.flatMap((fence) =>
      fence.body
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("$ "))
        .map((line) => line.slice(2).trim()),
    );
    expect(commands).toContain("pi install ./");
    expect(commands).toContain("pi -e ./");
  });

  it("resolves every shell command against scripts, the /ts grammar, or the Pi allowlist", () => {
    for (const fence of shellFences) {
      for (const rawLine of fence.body.split("\n")) {
        const line = rawLine.trim();
        if (line === "" || !line.startsWith("$ ")) continue;
        const command = line.slice(2).trim();
        expect(shellFences.length).toBeGreaterThan(0);

        if (PI_COMMAND_ALLOWLIST.includes(command)) continue;
        if (command === "npm install") continue;

        const npmRun = /^npm run (.+)$/.exec(command);
        if (npmRun) {
          expect(packageJson.scripts, `script '${npmRun[1]}' exists`).toHaveProperty(npmRun[1]);
          continue;
        }
        if (command === "npm test") {
          expect(packageJson.scripts).toHaveProperty("test");
          continue;
        }

        const ms = /^\/ts(?:\s+(.*))?$/.exec(command);
        if (ms) {
          const parsed = parseTsCommand((ms[1] ?? "").trim());
          expect(parsed.ok, `'/ts ${ms[1] ?? ""}' parses`).toBe(true);
          continue;
        }

        throw new Error(`README shell snippet is not covered by any known surface: '${command}'`);
      }
    }
  });
});

describe("README names the shipped identities (hooks 1 and 4)", () => {
  it("carries the package, virtual model, floor, and config paths", () => {
    expect(readme).toContain("pi-tier-scheduler");
    expect(readme).toContain("ts/auto");
    expect(readme).toContain(MINIMUM_PI_VERSION);
    expect(readme).toContain("pi install ./");
    expect(readme).toContain("tier-scheduler.json");
    expect(readme).toContain(".pi/tier-scheduler.json");
  });

  it("documents every registered command form (hook 4)", () => {
    const documentedForms: readonly string[] = [
      "/ts status",
      "/ts use <tier>",
      "/ts brain",
      "/ts pillar",
      "/ts crowd",
      "/ts auto",
      "/ts init",
      "/ts config",
      "/ts doctor",
    ];
    for (const form of documentedForms) {
      expect(readme, `${form} documented`).toContain(form);
    }
  });

  it("keeps the registered grammar parseable for every documented tier form", () => {
    for (const tier of ["brain", "pillar", "crowd"] as const) {
      expect(parseTsCommand(`use ${tier}`).ok).toBe(true);
      expect(parseTsCommand(tier).ok).toBe(true);
    }
  });
});

describe("README links and CHANGELOG anchor (hooks 8 and 9)", () => {
  it("every relative link target exists in the tree", () => {
    const targets = [...readme.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
      .map((match) => match[1]!)
      .filter((target) => !target.startsWith("#") && !target.startsWith("http"));
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(existsSync(resolve(REPO_ROOT, target)), `${target} exists`).toBe(true);
    }
  });

  it("CHANGELOG records the released version and compatibility floor (hook 8)", () => {
    expect(changelog).toContain(`## ${packageJson.version}`);
    expect(changelog).toContain(MINIMUM_PI_VERSION);
    expect(readme).toContain("CHANGELOG.md");
  });
});

describe("release text stays free of private and secret material", () => {
  const FORBIDDEN: readonly (string | RegExp)[] = [
    /sk-[A-Za-z0-9]/,
    "/Users/",
    "/home/",
    "Bearer ",
    /api[_-]?token/i,
  ];

  it("README and CHANGELOG match no forbidden pattern", () => {
    for (const doc of [readme, changelog]) {
      for (const pattern of FORBIDDEN) {
        expect(doc.match(pattern), `${String(pattern)} absent`).toBeNull();
      }
    }
  });
});
