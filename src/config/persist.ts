import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { validateConfigLayer } from "./schema";
import type { ConfigFile } from "./types";

/**
 * Persistence (02-config.md §5.4–§5.6): the config module's only writer.
 *
 * saveConfigFile validates first (an invalid layer never touches the target —
 * not even the parent directory is created), creates the parent directory,
 * then runs behind a per-target promise tail so same-path saves never
 * interleave. Inside the tail it optionally copies the current target bytes
 * to a durable `.replaced-*` sibling (`backupExisting`), writes canonical
 * JSON into a same-directory temp file, fsyncs it, and renames it over the
 * target. Every failure before the rename leaves the previous target
 * byte-for-byte intact and removes the operation's temp file; a failed
 * rename never reports success, and the last known-good target is never
 * deleted to make room for a temp path (§5.4).
 *
 * quarantineFile is the §5.5 load-time recovery used by discover.ts when
 * JSON parsing fails: the original bytes go to a durable `.corrupt-*`
 * sibling first, and the original is removed only after the backup is on
 * disk, so the next load sees the target as missing. At most the three
 * newest backups per class (`corrupt-*` / `replaced-*`) per target survive
 * pruning; pruning is best-effort and never fails the operation.
 *
 * All filesystem access funnels through an injectable adapter seam. The
 * default adapter is the real `node:fs/promises`; tests inject failures at
 * the write/fsync/close/rename points through `__setFsForTests` without a
 * mock filesystem (§5.6). Errors carry the absolute target path, the
 * operation context, and a stable errno token (§7.3 item 2); messages never
 * embed raw file contents.
 */

/** The write/sync/close surface of an exclusively created file. */
export interface PersistenceFileHandle {
  write(buffer: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** The filesystem seam every persist operation funnels through. */
export interface PersistenceFs {
  /** Creates the directory (and missing ancestors) when needed; idempotent. */
  mkdir(dir: string): Promise<void>;
  /** Throws ENOENT for a missing path; reports whether it is a regular file. */
  stat(path: string): Promise<{ isFile(): boolean }>;
  /** Raw bytes of a file, whatever its content. */
  readFile(path: string): Promise<Uint8Array>;
  /** Creates the file exclusively (fails if it exists) with mode 0600. */
  openExclusive(path: string): Promise<PersistenceFileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readdir(dir: string): Promise<string[]>;
  /** Best-effort directory fsync; must never throw. */
  syncDir(dir: string): Promise<void>;
}

const defaultConfigFs: PersistenceFs = {
  // 0o700 keeps newly created config directories private where supported.
  async mkdir(dir) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  },
  stat: (path) => stat(path),
  readFile: (path) => readFile(path),
  async openExclusive(path) {
    const handle = await open(path, "wx", 0o600);
    return {
      async write(buffer) {
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
          if (bytesWritten <= 0) throw new Error("write made no progress");
          offset += bytesWritten;
        }
      },
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  },
  rename: (from, to) => rename(from, to),
  unlink: (path) => unlink(path),
  readdir: (dir) => readdir(dir),
  async syncDir(path) {
    try {
      const handle = await open(path, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Best-effort: platforms that cannot fsync a directory skip it.
    }
  },
};

let activeFs: PersistenceFs = defaultConfigFs;

/**
 * Test-only injection seam for the filesystem adapter. A factory receives
 * the real default adapter and returns a wrapped one, so tests can record
 * or fail individual operations while everything else stays real. `null`
 * resets to the real adapter. Never call this outside tests.
 */
export function __setFsForTests(
  fs: PersistenceFs | ((base: PersistenceFs) => PersistenceFs) | null,
): void {
  activeFs =
    fs === null ? defaultConfigFs : typeof fs === "function" ? fs(defaultConfigFs) : fs;
}

/**
 * A contextual persistence failure: `operation` names the step, `target` is
 * the absolute path the operation was for, and `code` is a stable errno
 * token (EACCES, EISDIR, …) — node-style, so generic errno extraction works.
 * Raw file contents never appear anywhere on the error.
 */
export class PersistFsError extends Error {
  readonly operation: string;
  readonly target: string;
  readonly code: string;

  constructor(operation: string, target: string, code: string) {
    super(`${operation} of ${target} failed (${code})`);
    this.name = "PersistFsError";
    this.operation = operation;
    this.target = target;
    this.code = code;
  }
}

/** Extracts a stable errno token without the raw filesystem message. */
function errnoOf(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") return code;
  }
  return "UNKNOWN";
}

function fsError(operation: string, target: string, err: unknown): PersistFsError {
  return new PersistFsError(operation, target, errnoOf(err));
}

/** `.corrupt-` (§5.5 quarantine) and `.replaced-` (§5.4 pre-replace backup). */
type BackupKind = "corrupt" | "replaced";

const MAX_BACKUPS_PER_CLASS = 3;

/** Monotonic temp-file counter: names never repeat within a process (§5.6). */
let tempCounter = 0;

/**
 * Never issues the same millisecond stamp twice within a process, so backup
 * names stay unique even for quarantines or backups created in quick
 * succession (stamps can drift at most a few ms into the future).
 */
let lastBackupStampMs = 0;

/** ISO-like UTC stamp of fixed width, so names sort chronologically. */
function formatBackupStamp(epochMs: number): string {
  const t = new Date(epochMs);
  const pad = (value: number, width: number) => String(value).padStart(width, "0");
  return (
    `${pad(t.getUTCFullYear(), 4)}${pad(t.getUTCMonth() + 1, 2)}${pad(t.getUTCDate(), 2)}` +
    `T${pad(t.getUTCHours(), 2)}${pad(t.getUTCMinutes(), 2)}${pad(t.getUTCSeconds(), 2)}` +
    `.${pad(t.getUTCMilliseconds(), 3)}Z`
  );
}

function nextBackupStamp(): string {
  const now = Date.now();
  const stampMs = now > lastBackupStampMs ? now : lastBackupStampMs + 1;
  lastBackupStampMs = stampMs;
  return formatBackupStamp(stampMs);
}

/** Same-directory temp name, e.g. `tier-scheduler.json.<pid>.<counter>.tmp`. */
function tempPathFor(target: string): string {
  const counter = tempCounter;
  tempCounter += 1;
  return `${target}.${process.pid}.${counter}.tmp`;
}

/** Backup sibling, e.g. `tier-scheduler.json.corrupt-20261007T131500.123Z-4812`. */
function backupPathFor(target: string, kind: BackupKind): string {
  return `${target}.${kind}-${nextBackupStamp()}-${process.pid}`;
}

/**
 * Canonical serialization (§5.4): key order schemaVersion → tiers → policy →
 * retry, tier order brain → pillar → crowd, candidate fields provider → id,
 * candidate list order verbatim; 2-space indent and a trailing newline.
 * Presence is preserved exactly — a partial tier/policy/retry stays partial.
 */
function canonicalLayerJson(layer: ConfigFile): string {
  const out: Record<string, unknown> = {};
  out.schemaVersion = layer.schemaVersion;
  if (layer.tiers !== undefined) {
    const tiers: Record<string, unknown> = {};
    for (const name of ["brain", "pillar", "crowd"] as const) {
      const tier = layer.tiers[name];
      if (tier === undefined) continue;
      const tierOut: Record<string, unknown> = {};
      if (tier.candidates !== undefined) {
        tierOut.candidates = tier.candidates.map((candidate) => ({
          provider: candidate.provider,
          id: candidate.id,
        }));
      }
      tiers[name] = tierOut;
    }
    out.tiers = tiers;
  }
  if (layer.policy !== undefined) {
    const policy: Record<string, unknown> = {};
    if (layer.policy.defaultBias !== undefined) policy.defaultBias = layer.policy.defaultBias;
    if (layer.policy.sticky !== undefined) policy.sticky = layer.policy.sticky;
    out.policy = policy;
  }
  if (layer.retry !== undefined) {
    const retry: Record<string, unknown> = {};
    if (layer.retry.maxAttemptsPerRequest !== undefined) {
      retry.maxAttemptsPerRequest = layer.retry.maxAttemptsPerRequest;
    }
    if (layer.retry.maxTierSwitches !== undefined) {
      retry.maxTierSwitches = layer.retry.maxTierSwitches;
    }
    out.retry = retry;
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** Creates `path` exclusively (0600), writes all bytes, fsyncs, closes. */
async function writeDurableFile(path: string, bytes: Uint8Array): Promise<void> {
  let handle: PersistenceFileHandle | undefined;
  try {
    handle = await activeFs.openExclusive(path);
    await handle.write(bytes);
    await handle.sync();
    await handle.close();
  } catch (err) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Best-effort cleanup; the original error wins.
      }
    }
    throw err;
  }
}

/**
 * Best-effort pruning (§5.5): keeps only the MAX_BACKUPS_PER_CLASS newest
 * `${basename}.${kind}-*` siblings of the target. Fixed-width stamps make
 * lexicographic order chronological. Never throws.
 */
async function pruneBackups(target: string, kind: BackupKind): Promise<void> {
  const dir = dirname(target);
  const prefix = `${basename(target)}.${kind}-`;
  let entries: string[];
  try {
    entries = await activeFs.readdir(dir);
  } catch {
    return;
  }
  const stale = entries
    .filter((entry) => entry.startsWith(prefix))
    .sort()
    .slice(0, -MAX_BACKUPS_PER_CLASS);
  for (const name of stale) {
    try {
      await activeFs.unlink(join(dir, name));
    } catch {
      // Best-effort: an unremovable stale backup is left behind.
    }
  }
}

/**
 * Per-target save tail (§5.6): same-path saves run strictly one after
 * another. A failed save does not poison the tail — the next save runs
 * regardless. The map entry is dropped once the tail settles and no newer
 * save has chained onto it.
 */
const saveTails = new Map<string, Promise<void>>();

function enqueueSave(target: string, operation: () => Promise<void>): Promise<void> {
  const previous = saveTails.get(target) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  saveTails.set(target, tail);
  void tail.then(() => {
    if (saveTails.get(target) === tail) saveTails.delete(target);
  });
  return run;
}

/**
 * The config module's sole writer (§5.4/§6.2). Validates the layer and
 * rejects before anything on disk is touched, creates the parent directory
 * when needed, then runs behind the per-target tail: optional `.replaced-*`
 * backup of the current bytes, canonical JSON into a same-directory temp
 * file, fsync, atomic rename, best-effort directory fsync. On any failure
 * before the rename the previous target stays byte-for-byte intact and the
 * temp file is removed.
 */
export async function saveConfigFile(
  targetPath: string,
  layer: ConfigFile,
  options?: { backupExisting?: boolean },
): Promise<void> {
  const target = resolve(targetPath);

  // Validation first (§5.4): stable codes and JSON paths only, never raw
  // values. The label is fixed "user" — this release's saves always write
  // user-layer content to an explicit target (§2.2).
  const validated = validateConfigLayer(layer, "user");
  if (!validated.ok) {
    const detail = validated.errors.map((e) => `${e.code}@${e.path}`).join(", ");
    throw new Error(`invalid config layer for save: ${detail}`);
  }

  // Serialize before enqueueing so the queued section sees a stable
  // snapshot even if the caller mutates the object afterwards.
  const bytes = Buffer.from(canonicalLayerJson(validated.value), "utf8");

  try {
    await activeFs.mkdir(dirname(target));
  } catch (err) {
    throw fsError("config save: create parent directory", target, err);
  }

  const backupExisting = options?.backupExisting === true;
  await enqueueSave(target, async () => {
    if (backupExisting) {
      await backupExistingTarget(target);
    }
    await saveBytesAtomically(target, bytes);
  });
}

/**
 * §5.4 `backupExisting`: copies the current target bytes — whatever they
 * are — to a durable `.replaced-*` sibling before the write. A missing
 * target (fresh init, or already quarantined by §5.5) is a no-op; a target
 * whose bytes cannot be read is never replaced, because a caller that asked
 * for recoverability never gets a destructive rename.
 */
async function backupExistingTarget(target: string): Promise<void> {
  let isFile: boolean;
  try {
    isFile = (await activeFs.stat(target)).isFile();
  } catch (err) {
    if (errnoOf(err) === "ENOENT") return;
    throw fsError("config save: back up existing target", target, err);
  }
  if (!isFile) {
    // A non-regular target has no file bytes to preserve.
    throw fsError(
      "config save: back up existing target",
      target,
      Object.assign(new Error("target is not a regular file"), { code: "EISDIR" }),
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await activeFs.readFile(target);
  } catch (err) {
    throw fsError("config save: back up existing target", target, err);
  }

  const backupPath = backupPathFor(target, "replaced");
  try {
    await writeDurableFile(backupPath, bytes);
  } catch (err) {
    try {
      await activeFs.unlink(backupPath);
    } catch {
      // Best-effort removal of the partial backup; the save error wins.
    }
    throw fsError("config save: back up existing target", target, err);
  }
  await pruneBackups(target, "replaced");
}

/**
 * The queued core of a save: temp file → fsync → close → atomic rename →
 * best-effort directory fsync. The temp file is removed on every failure
 * before the rename; after a successful rename the save succeeds even if
 * the directory fsync is skipped.
 */
async function saveBytesAtomically(target: string, bytes: Uint8Array): Promise<void> {
  const tempPath = tempPathFor(target);
  let handle: PersistenceFileHandle | undefined;
  try {
    try {
      handle = await activeFs.openExclusive(tempPath);
    } catch (err) {
      throw fsError("config save: create temp file", target, err);
    }
    try {
      await handle.write(bytes);
    } catch (err) {
      throw fsError("config save: write temp file", target, err);
    }
    try {
      await handle.sync();
    } catch (err) {
      throw fsError("config save: sync temp file", target, err);
    }
    try {
      await handle.close();
    } catch (err) {
      handle = undefined;
      throw fsError("config save: close temp file", target, err);
    }
    handle = undefined;
    try {
      await activeFs.rename(tempPath, target);
    } catch (err) {
      throw fsError("config save: rename onto target", target, err);
    }
    try {
      await activeFs.syncDir(dirname(target));
    } catch {
      // Best-effort: the bytes are already in place.
    }
  } catch (err) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Best-effort cleanup; the original error wins.
      }
    }
    try {
      await activeFs.unlink(tempPath);
    } catch {
      // Best-effort cleanup; the original error wins.
    }
    throw err;
  }
}

/**
 * §5.5 load-time quarantine, used by discover.ts when JSON parsing fails.
 * The original bytes are copied to a durable `.corrupt-*` sibling first;
 * only after the backup is on disk is the original removed, so the next
 * load sees the target as missing. If either step fails the original stays
 * in place (its bytes are never lost) and the error escalates to the
 * caller, which reports BACKUP_FAILED instead of recovery.
 */
export async function quarantineFile(path: string, bytes: Uint8Array): Promise<string> {
  const target = resolve(path);
  const backupPath = backupPathFor(target, "corrupt");

  try {
    await writeDurableFile(backupPath, bytes);
  } catch (err) {
    try {
      await activeFs.unlink(backupPath);
    } catch {
      // Best-effort removal of the partial backup; the quarantine error wins.
    }
    throw fsError("config load quarantine", target, err);
  }

  try {
    await activeFs.unlink(target);
  } catch (err) {
    // The original could not be removed: it stays in place with its bytes
    // intact, and the durable backup stays as an extra copy.
    throw fsError("config load quarantine", target, err);
  }

  await pruneBackups(target, "corrupt");
  return backupPath;
}
