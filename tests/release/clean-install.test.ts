import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * F8.3 gated clean-install verification (08-release.md §3.6, §5.4, §7.3
 * hooks 1–9): the install path is proven from isolated environments, not
 * asserted from documentation.
 *
 *   hook 1–2  `pi install ./` exits 0; the isolated agent dir gains exactly
 *             one settings entry resolving to this checkout's
 *             `extensions/index.ts` (proven by the extension loading in a
 *             fresh session); `pi list` shows exactly this package; peer
 *             host packages are never copied into the agent dir.
 *   hook 3    a fresh session loads the extension with no import error and
 *             no duplicate-host warning; `pi --list-models` lists `ts/auto`
 *             with zero credentials in the environment.
 *   hook 4    `/ts status`, `/ts use pillar`, `/ts auto`, and `/ts doctor`
 *             answer in an isolated headless session (print mode dispatches
 *             extension commands from initial messages on this host).
 *   hook 5–6  print mode keeps stdout empty (protocol) and puts command
 *             text on stderr; RPC mode carries it as an
 *             `extension_ui_request` notify event over JSONL with
 *             `disposition: "handled"`; user+project config fixtures merge
 *             with project winning; command output carries no absolute
 *             paths and no credential-shaped values; fixtures are deleted
 *             after use.
 *   hook 7    `pi remove ./` exits 0, `pi list` shows nothing, the settings
 *             entry is gone, and the agent dir retains only classified host
 *             metadata (auth/models-store/session state) — never package
 *             files; `/ts …` no longer dispatches afterwards.
 *   hook 8    the whole install→load→command→remove loop repeats from a
 *             second, fully fresh isolated root — no first-round cache.
 *   hook 9    evidence is bounded (truncated assertion messages, no full
 *             output dumps committed); a missing `pi` CLI records blocked,
 *             never a fake pass.
 *
 * Host interaction discipline: every child process gets an explicit
 * environment (PATH only from the runner) with HOME and
 * PI_CODING_AGENT_DIR pointed at per-cycle temp roots under os.tmpdir(),
 * plus PI_OFFLINE=1 — nothing may write to the real home or agent dir, and
 * no network is available. All spawned commands are timeout-bounded.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const CHILD_TIMEOUT_MS = 90_000;
const TEST_TIMEOUT_MS = 150_000;

/** Bounded evidence: never let a whole child output land in a failure message. */
function bounded(text: string, limit = 400): string {
  const flat = text.replaceAll("\n", " ⏎ ");
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…[${text.length} chars]`;
}

/** The pi CLI gate: present and executable on PATH. */
const piProbe = spawnSync("pi", ["--version"], {
  encoding: "utf8",
  timeout: 30_000,
});
const PI_AVAILABLE = piProbe.status === 0 && typeof piProbe.stdout === "string";
const PI_VERSION = PI_AVAILABLE ? piProbe.stdout.trim() : undefined;

/** Explicit isolated environment: no ambient secrets, no real home writes. */
function isolatedEnv(agentDir: string, homeDir: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: homeDir,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
  };
}

interface PiRun {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

function runPi(
  args: string[],
  opts: { cwd: string; agentDir: string; homeDir: string },
): PiRun {
  const result = spawnSync("pi", args, {
    cwd: opts.cwd,
    env: isolatedEnv(opts.agentDir, opts.homeDir),
    encoding: "utf8",
    timeout: CHILD_TIMEOUT_MS,
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    error: result.error === undefined ? undefined : String(result.error),
  };
}

/** Assert none of the concrete roots (or a plausible absolute path) leaks. */
function expectNoAbsolutePath(label: string, text: string, roots: string[]): void {
  for (const root of roots) {
    expect(text, `${label} must not leak the absolute root ${root}: ${bounded(text)}`).not.toContain(
      root,
    );
  }
}

/** Credential-shaped sweep over command output (doctor never prints values). */
function expectNoCredentialShape(label: string, text: string): void {
  expect(
    text,
    `${label} must not contain credential-shaped values: ${bounded(text)}`,
  ).not.toMatch(/sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{16,}|[a-f0-9]{32,}/);
}

/**
 * One RPC interaction: boot `pi --mode rpc`, let the fire-and-forget
 * session_start config load settle, send one `/ts` prompt, then close stdin
 * (the host exits cleanly on EOF). Returns parsed JSONL plus raw stderr.
 */
async function rpcTsCommand(opts: {
  cwd: string;
  agentDir: string;
  homeDir: string;
  command: string;
  startupMs?: number;
  settleMs?: number;
  watchdogMs?: number;
}): Promise<{ lines: unknown[]; stderr: string; exitCode: number | null; timedOut: boolean }> {
  const startupMs = opts.startupMs ?? 2_500;
  const settleMs = opts.settleMs ?? 2_500;
  const watchdogMs = opts.watchdogMs ?? 60_000;
  const child: ChildProcessWithoutNullStreams = spawn(
    "pi",
    ["--mode", "rpc", "--no-session", "--offline"],
    { cwd: opts.cwd, env: isolatedEnv(opts.agentDir, opts.homeDir) },
  );
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  let timedOut = false;
  const done = new Promise<{ exitCode: number | null }>((resolveDone) => {
    child.on("exit", (code) => resolveDone({ exitCode: code }));
  });
  const watchdog = new Promise<"timeout">((resolveTimeout) => {
    setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      resolveTimeout("timeout");
    }, watchdogMs).unref();
  });
  await sleep(startupMs);
  child.stdin.write(`${JSON.stringify({ id: "ms-rpc", type: "prompt", message: opts.command })}\n`);
  await sleep(settleMs);
  child.stdin.end();
  const outcome = await Promise.race([done, watchdog]);
  if (outcome === "timeout") {
    return { lines: [], stderr: Buffer.concat(stderrChunks).toString("utf8"), exitCode: null, timedOut: true };
  }
  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const lines: unknown[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    lines.push(JSON.parse(line));
  }
  return { lines, stderr: Buffer.concat(stderrChunks).toString("utf8"), exitCode: outcome.exitCode, timedOut: false };
}

function sleep(ts: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ts));
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Host session/config metadata the Pi CLI itself may leave — never package residue. */
const HOST_METADATA_FILES = new Set(["settings.json", "auth.json", "models-store.json"]);

/** Package-owned names that must never appear in the agent dir after removal. */
const PACKAGE_OWNED_NAMES = ["node_modules", "extensions", "src", "package.json", "pi-tier-scheduler"];

describe.skipIf(!PI_AVAILABLE)("F8.3 clean-install verification (host pi present)", () => {
  let gitBaseline: string;

  beforeAll(() => {
    // Repo-tree baseline: the cycles must not add or mutate anything here.
    const git = spawnSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" });
    gitBaseline = git.stdout;
  }, 30_000);

  for (const cycle of [1, 2] as const) {
    describe(`cycle ${cycle}: install → load → commands → remove in a fresh isolated root`, () => {
      let agentDir: string;
      let homeDir: string;
      let projectDir: string;

      beforeAll(() => {
        agentDir = mkdtempSync(join(tmpdir(), "msf83-agent-"));
        homeDir = mkdtempSync(join(tmpdir(), "msf83-home-"));
        projectDir = mkdtempSync(join(tmpdir(), "msf83-proj-"));
        for (const root of [agentDir, homeDir, projectDir]) {
          // Escape guard: every temp root lives under the system tmpdir.
          expect(relative(tmpdir(), root)).not.toMatch(/^\.\./);
        }
      }, 30_000);

      afterAll(() => {
        rmSync(agentDir, { recursive: true, force: true });
        rmSync(homeDir, { recursive: true, force: true });
        rmSync(projectDir, { recursive: true, force: true });
        // The temp roots must actually be gone — cleanup is asserted, not assumed.
        expect(existsSync(agentDir), `agent root ${agentDir} must be removed`).toBe(false);
        expect(existsSync(homeDir), `home root ${homeDir} must be removed`).toBe(false);
        expect(existsSync(projectDir), `project root ${projectDir} must be removed`).toBe(false);
      }, 30_000);

      it("hooks 1–2: pi install ./ succeeds, pi list shows exactly this package, settings gains one resolved entry", () => {
        const install = runPi(["install", "./"], { cwd: REPO_ROOT, agentDir, homeDir });
        expect(install.error).toBeUndefined();
        expect(install.status, `stderr: ${bounded(install.stderr)}`).toBe(0);

        // Install writes only the settings entry: the agent dir holds nothing else yet.
        const dirEntries = readdirNames(agentDir);
        expect(dirEntries, `agent dir after install: ${dirEntries.join(", ")}`).toEqual([
          "settings.json",
        ]);

        const settingsPath = join(agentDir, "settings.json");
        const packages = JSON.parse(readFileSync(settingsPath, "utf8")) as {
          packages?: unknown;
        };
        expect(Array.isArray(packages.packages)).toBe(true);
        const entries = packages.packages as string[];
        expect(entries).toHaveLength(1);
        // Local installs record the resolved source path (possibly relative to the agent dir).
        expect(resolve(agentDir, entries[0]!)).toBe(REPO_ROOT);

        const list = runPi(["list"], { cwd: projectDir, agentDir, homeDir });
        expect(list.status).toBe(0);
        expect(list.stdout).toContain("User packages:");
        // Local installs list by resolved source path (the checkout), not by package name.
        expect(list.stdout, bounded(list.stdout)).toContain(REPO_ROOT);
      }, TEST_TIMEOUT_MS);

      it("hook 3: a fresh session loads the extension cleanly (no import error, no duplicate-host warning)", () => {
        const run = runPi(
          ["--no-session", "--print", "/ts status"],
          { cwd: projectDir, agentDir, homeDir },
        );
        expect(run.error).toBeUndefined();
        expect(run.status, `stderr: ${bounded(run.stderr)}`).toBe(0);
        expect(run.stdout, "print stdout stays empty for a consumed extension command").toBe("");
        expect(run.stderr).toContain("pi-tier-scheduler status");
        expect(run.stderr, bounded(run.stderr)).not.toMatch(
          /duplicate|failed to load|error loading|cannot find/i,
        );
        expectNoAbsolutePath("status output", run.stderr, [agentDir, homeDir, projectDir, REPO_ROOT]);
      }, TEST_TIMEOUT_MS);

      it("hook 3: --list-models lists ts/auto with zero credentials in the environment", () => {
        const run = runPi(["--offline", "--list-models", "ts"], { cwd: projectDir, agentDir, homeDir });
        expect(run.error).toBeUndefined();
        expect(run.status, `stderr: ${bounded(run.stderr)}`).toBe(0);
        expect(run.stdout, bounded(run.stdout)).toMatch(/\bts\s+auto\b/);
      }, TEST_TIMEOUT_MS);

      it("hook 4: /ts status reports the virtual selection and built-in defaults before any config exists", () => {
        const run = runPi(["--no-session", "--print", "/ts status"], { cwd: projectDir, agentDir, homeDir });
        expect(run.status).toBe(0);
        expect(run.stdout).toBe("");
        expect(run.stderr).toContain("(ts) auto • ");
        expect(run.stderr).toContain("last: not recorded in this runtime");
        // No config fixtures exist yet: the documented not-loaded summary is the truth.
        expect(run.stderr).toContain("config: not loaded — built-in defaults in effect");
      }, TEST_TIMEOUT_MS);

      it("hook 4: /ts use pillar overrides routing inside one session and /ts auto releases it", () => {
        const use = runPi(
          ["--no-session", "--print", "/ts use pillar", "/ts status"],
          { cwd: projectDir, agentDir, homeDir },
        );
        expect(use.status, `stderr: ${bounded(use.stderr)}`).toBe(0);
        expect(use.stdout).toBe("");
        expect(use.stderr).toContain("pinned: pillar • medium");
        expect(use.stderr).toContain("(ts) pillar • medium");

        const release = runPi(
          ["--no-session", "--print", "/ts auto", "/ts status"],
          { cwd: projectDir, agentDir, homeDir },
        );
        expect(release.status, `stderr: ${bounded(release.stderr)}`).toBe(0);
        expect(release.stdout).toBe("");
        expect(release.stderr).toContain("auto routing • bias medium");
        expect(release.stderr).toContain("(ts) auto • medium");
        expectNoAbsolutePath("/ts use+auto output", use.stderr + release.stderr, [
          agentDir,
          homeDir,
          projectDir,
          REPO_ROOT,
        ]);
      }, TEST_TIMEOUT_MS);

      it("hook 4–5: /ts doctor reports health without credentials and keeps stdout protocol-clean", () => {
        const run = runPi(["--no-session", "--print", "/ts doctor"], { cwd: projectDir, agentDir, homeDir });
        expect(run.status, `stderr: ${bounded(run.stderr)}`).toBe(0);
        expect(run.stdout).toBe("");
        expect(run.stderr).toContain("pi-tier-scheduler doctor");
        // Zero credentials in the isolated environment: configured=0 is the expected proof.
        expect(run.stderr).toContain("credentials    pass      configured=0; missing=0; unknown=0");
        expect(run.stderr).toMatch(/router state   pass      state=absent; attempts=\d+\/\d+; tier-switches=\d+\/\d+/);
        expect(run.stderr).toMatch(
          /compatibility  pass      Pi \d+\.\d+\.\d+; required API surface present/,
        );
        if (PI_VERSION !== undefined && /^\d+\.\d+\.\d+$/.test(PI_VERSION)) {
          expect(run.stderr).toContain(`compatibility  pass      Pi ${PI_VERSION};`);
        }
        expectNoCredentialShape("doctor output", run.stderr);
        expectNoAbsolutePath("doctor output", run.stderr, [agentDir, homeDir, projectDir, REPO_ROOT]);
      }, TEST_TIMEOUT_MS);

      it("hooks 5–6: RPC carries /ts output as a handled notify event and project config wins over user config", async () => {
        // Fixtures: user sets bias low, project sets bias high plus one pillar candidate.
        const userFixture = join(agentDir, "tier-scheduler.json");
        const projectPiDir = join(projectDir, ".pi");
        const projectFixture = join(projectPiDir, "tier-scheduler.json");
        try {
          writeFileSync(
            userFixture,
            `${JSON.stringify({ schemaVersion: 1, policy: { defaultBias: "low" } }, null, 2)}\n`,
          );
          mkdirSync(projectPiDir, { recursive: true });
          writeFileSync(
            projectFixture,
            `${JSON.stringify(
              {
                schemaVersion: 1,
                policy: { defaultBias: "high" },
                tiers: {
                  pillar: { candidates: [{ provider: "anthropic", id: "claude-sonnet-4-5" }] },
                },
              },
              null,
              2,
            )}\n`,
          );

          const rpc = await rpcTsCommand({
            cwd: projectDir,
            agentDir,
            homeDir,
            command: "/ts status",
          });
          expect(rpc.timedOut).toBe(false);
          expect(rpc.exitCode).toBe(0);
          expect(rpc.stderr, `rpc stderr: ${bounded(rpc.stderr)}`).toBe("");

          const response = rpc.lines
            .map(asObject)
            .find((line) => line.type === "response" && line.id === "ms-rpc");
          expect(response, `rpc lines: ${JSON.stringify(rpc.lines.map((l) => asObject(l).type))}`)
            .toBeDefined();
          expect(response!.success).toBe(true);
          expect(asObject(response!.data).disposition).toBe("handled");

          const notify = rpc.lines
            .map(asObject)
            .find((line) => line.type === "extension_ui_request" && line.method === "notify");
          expect(notify, "an extension_ui_request notify event must carry the status text")
            .toBeDefined();
          const message = typeof notify!.message === "string" ? notify!.message : "";
          // Project layer wins the precedence: bias high, pillar candidate counted.
          expect(message, bounded(message)).toContain(
            "config: valid · user loaded · project loaded · bias high · sticky on",
          );
          expect(message).toContain("  brain   (none)");
          expect(message).toContain("  pillar  anthropic/claude-sonnet-4-5");
          expect(message).toContain("  crowd   (none)");
          expectNoAbsolutePath("rpc status message", message, [agentDir, homeDir, projectDir, REPO_ROOT]);
          expectNoCredentialShape("rpc status message", message);
        } finally {
          // Fixtures are deleted after use (hook 6).
          rmSync(userFixture, { force: true });
          rmSync(projectFixture, { force: true });
          rmSync(projectPiDir, { recursive: true, force: true });
        }
      }, TEST_TIMEOUT_MS);

      it("hook 7: pi remove ./ uninstalls cleanly and leaves only classified host metadata", () => {
        const remove = runPi(["remove", "./"], { cwd: REPO_ROOT, agentDir, homeDir });
        expect(remove.error).toBeUndefined();
        expect(remove.status, `stderr: ${bounded(remove.stderr)}`).toBe(0);

        const list = runPi(["list"], { cwd: projectDir, agentDir, homeDir });
        expect(list.status).toBe(0);
        expect(list.stdout).toContain("No packages installed.");

        const settingsPath = join(agentDir, "settings.json");
        expect(existsSync(settingsPath)).toBe(true);
        const packages = JSON.parse(readFileSync(settingsPath, "utf8")) as { packages?: unknown };
        expect(packages.packages).toEqual([]);

        // Residue classification: only host session/config metadata may remain —
        // never package files or a copied/bundled dependency tree.
        const remaining = readdirNames(agentDir);
        const unclassified = remaining.filter(
          (name) => !HOST_METADATA_FILES.has(name) && name !== "tier-scheduler.json",
        );
        expect(
          unclassified,
          `unclassified residue in agent dir (allowed host metadata: ${[...HOST_METADATA_FILES].join(", ")}): ${remaining.join(", ")}`,
        ).toEqual([]);
        for (const name of PACKAGE_OWNED_NAMES) {
          expect(remaining, `package-owned "${name}" must not remain after removal`).not.toContain(
            name,
          );
        }
      }, TEST_TIMEOUT_MS);

      it("hook 7: after removal, /ts no longer dispatches as an extension command", () => {
        const run = runPi(["--no-session", "--print", "/ts status"], { cwd: projectDir, agentDir, homeDir });
        // Without the extension the message falls through to the model and the
        // credential-less isolated session rejects it — the exact absence proof.
        expect(
          run.stderr,
          `post-remove stderr must not carry the extension status block: ${bounded(run.stderr)}`,
        ).not.toContain("pi-tier-scheduler status");
        expect(run.stdout).not.toContain("pi-tier-scheduler status");
      }, TEST_TIMEOUT_MS);
    });
  }

  it("hooks 8–9: both isolated cycles are torn down and the repo tree is unchanged", () => {
    const git = spawnSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" });
    const after = git.stdout;
    expect(after === gitBaseline, `git delta:\n--- before ---\n${gitBaseline}\n--- after ---\n${after}`).toBe(
      true,
    );
  }, TEST_TIMEOUT_MS);
});

describe("F8.3 blocked evidence (host pi absent)", () => {
  it.skipIf(PI_AVAILABLE)(
    "pi CLI missing on PATH: clean-install verification is blocked, not passed (hook 9)",
    () => {
      // Runs only when the host pi CLI is unavailable. This is a blocked
      // record, never a pass of the install path itself.
      expect(PI_AVAILABLE).toBe(false);
      expect(PI_VERSION).toBeUndefined();
    },
  );
});

function readdirNames(dir: string): string[] {
  return readdirSync(dir).sort();
}
