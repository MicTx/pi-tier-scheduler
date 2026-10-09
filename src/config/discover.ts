import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { quarantineFile } from "./persist";
import { validateConfigLayer } from "./schema";
import type { ConfigProblem, ReadLayerResult } from "./types";

/**
 * Path resolution and filesystem layer reads (02-config.md §5.2).
 *
 * Discovery is read-mostly: the only write path is the §5.5 load-time
 * quarantine of malformed JSON, delegated to persist.ts helpers (the
 * original bytes are copied to a durable `.corrupt-*` sibling first, and
 * only then is the original removed). A schema-invalid document is never
 * renamed — it stays the source of truth the user must repair while the
 * layer is skipped.
 *
 * File-level problems (NOT_JSON, unreadable, and later the merge-invariant
 * violation) record `path: ""` — `ConfigProblem.path` uses the JSON-path
 * vocabulary of `ConfigError`, never a filesystem path (§2.4). Messages carry
 * at most a stable errno token (EACCES, EISDIR, …); raw filesystem error text
 * embeds absolute paths and never enters a problem.
 */

/** The two file-layer source labels a read can carry (02-config.md §4.2). */
export type LayerFileSource = "user" | "project";

export interface ResolveConfigPathsInput {
  cwd: string;
  /** Injected for tests; production omits it and reads `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Injected for tests; production omits it and reads `os.homedir()`. */
  homeDir?: string;
}

export interface ResolvedConfigPaths {
  userPath: string;
  projectPath: string;
}

/**
 * Pure path derivation, no filesystem access: an empty or absent
 * `PI_CODING_AGENT_DIR` falls back to `<homeDir>/.pi/agent`, and the project
 * path is always exactly `<cwd>/.pi/tier-scheduler.json` — never an upward
 * search through parent directories (§7.2 item 4).
 */
export function resolveConfigPaths(input: ResolveConfigPathsInput): ResolvedConfigPaths {
  const env = input.env ?? process.env;
  const home = input.homeDir ?? homedir();
  const agentDirOverride = env.PI_CODING_AGENT_DIR;
  const agentDir =
    typeof agentDirOverride === "string" && agentDirOverride !== ""
      ? agentDirOverride
      : resolve(home, ".pi", "agent");
  return {
    userPath: resolve(agentDir, "tier-scheduler.json"),
    projectPath: resolve(input.cwd, ".pi", "tier-scheduler.json"),
  };
}

/** Extracts a stable errno token (EACCES, EISDIR, …) without the raw message. */
function errnoOf(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") return code;
  }
  return "UNKNOWN";
}

/** A file-level problem: JSON path "" because the source file itself is at fault. */
function fileProblem(
  source: LayerFileSource,
  severity: ConfigProblem["severity"],
  code: string,
  message: string,
): ConfigProblem {
  return { source, path: "", severity, code, message };
}

/** An unreadable layer: stat/read failure or a non-regular target (§5.2). */
function unreadableResult(
  source: LayerFileSource,
  path: string,
  message: string,
): ReadLayerResult {
  return {
    kind: "unreadable",
    source,
    path,
    problems: [fileProblem(source, "error", "UNREADABLE_FILE", message)],
  };
}

/**
 * Reads one config layer and classifies it into exactly one of four kinds
 * (§4.3): missing (normal, not a problem), valid, invalid (JSON or schema),
 * or unreadable (I/O, permissions, or a non-regular target).
 *
 * stat runs first and follows symlinks: a symlink to a regular file reads as
 * that file. Malformed JSON is quarantined through persist.ts (§5.5) — the
 * bytes move to a `.corrupt-*` sibling and the next read sees the target as
 * missing; every other classification leaves the file untouched.
 */
export async function readLayer(path: string, source: LayerFileSource): Promise<ReadLayerResult> {
  let info;
  try {
    info = await stat(path);
  } catch (err) {
    if (errnoOf(err) === "ENOENT") {
      return { kind: "missing", source, path };
    }
    return unreadableResult(
      source,
      path,
      `config target could not be inspected on the file system (${errnoOf(err)})`,
    );
  }
  if (!info.isFile()) {
    return unreadableResult(source, path, "config target is not a regular file");
  }

  // Raw bytes first: the §5.5 quarantine must preserve the original bytes
  // byte-for-byte, including invalid UTF-8 that a utf8 decode would replace.
  let fileBytes: Buffer;
  try {
    fileBytes = await readFile(path);
  } catch (err) {
    return unreadableResult(
      source,
      path,
      `config layer could not be read (${errnoOf(err)})`,
    );
  }
  const text = fileBytes.toString("utf8");

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // NOT_JSON belongs to the discover layer, not the schema validators
    // (config-contract-layer-notes). The parse error text can quote fragments
    // of the raw file, so only the stable code is reported. §5.5 quarantine:
    // the original bytes are copied to a durable `.corrupt-*` sibling first
    // and the original is removed only afterwards, so the next load sees the
    // target as missing while defaults and lower layers keep applying. When
    // the bytes cannot be preserved, the original stays in place and the
    // problem escalates to an error (BACKUP_FAILED).
    try {
      const backupPath = await quarantineFile(path, fileBytes);
      return {
        kind: "invalid",
        source,
        path,
        problems: [
          {
            ...fileProblem(source, "warning", "NOT_JSON", "config layer is not valid JSON"),
            backupPath,
          },
        ],
      };
    } catch (quarantineErr) {
      return {
        kind: "invalid",
        source,
        path,
        problems: [
          fileProblem(
            source,
            "error",
            "BACKUP_FAILED",
            `config layer is not valid JSON and could not be quarantined (${errnoOf(quarantineErr)})`,
          ),
        ],
      };
    }
  }

  const validated = validateConfigLayer(raw, source);
  if (validated.ok) {
    return { kind: "valid", source, path, value: validated.value };
  }
  return {
    kind: "invalid",
    source,
    path,
    problems: validated.errors.map(
      (e): ConfigProblem => ({
        source,
        path: e.path,
        severity: "error",
        code: e.code,
        message: e.message,
      }),
    ),
  };
}
