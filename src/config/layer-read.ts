import { readLayer, resolveConfigPaths } from "./discover";
import type { ResolveConfigPathsInput } from "./discover";
import type { ConfigFile } from "./types";

/**
 * Read-only layer inspection seam for the Phase 7 configuration flows
 * (07-tui-modes.md §4.2; F7.1 spec §2.2).
 *
 * The adapter composes the Phase 2 authorities — path resolution, layer
 * read, validation — behind one narrow read-only call so a wizard can
 * classify a target layer without duplicating any of them. It never writes,
 * never refreshes models, and never returns raw file bytes.
 *
 * Notes inherited from Phase 2, not re-decided here:
 * - A malformed-JSON target is quarantined by the Phase 2 §5.5 load-path
 *   recovery (`readLayer` moves the bytes to a `.corrupt-*` sibling), so a
 *   probe of such a target reports `invalid` with `NOT_JSON` while the
 *   original bytes stay recoverable and the target itself is gone.
 * - A schema-invalid (but parseable) target is left byte-for-byte in place;
 *   it is the source of truth the user must explicitly replace.
 */

/** The two file-layer scopes a wizard may target. */
export type ConfigScope = "user" | "project";

/** Raw `ReadLayerResult.kind` vocabulary (07 §4.1), never folded. */
export type ConfigLayerStatus = "missing" | "valid" | "invalid" | "unreadable";

/** Adapter input; `env`/`homeDir` are injected for tests (discover.ts §5.2). */
export type ConfigLayerReadInput = {
  scope: ConfigScope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

/**
 * What a configuration flow needs to know about one target layer. The
 * `value` is a clone: `{ schemaVersion: 1 }` for a missing target, a deep
 * clone of the validated document for a valid one. `problemCodes` are the
 * stable Phase 2 codes, deduplicated and bounded.
 *
 * `targetPath` exists so the save step writes exactly what was probed — one
 * resolution serves both. It is internal plumbing: it never crosses a
 * renderer or command-response boundary (07 §4.2).
 */
export type EditableConfigLayer = {
  scope: ConfigScope;
  status: ConfigLayerStatus;
  value: ConfigFile;
  problemCodes: readonly string[];
  targetPath: string;
};

function missingLayer(input: ConfigLayerReadInput, targetPath: string): EditableConfigLayer {
  return { scope: input.scope, status: "missing", value: { schemaVersion: 1 }, problemCodes: [], targetPath };
}

/**
 * Read and classify one target layer through the Phase 2 path resolver and
 * layer reader. Classification is the raw four-state vocabulary; a valid
 * document is cloned before it can enter any draft.
 */
export async function readConfigLayerForEdit(
  input: ConfigLayerReadInput,
): Promise<EditableConfigLayer> {
  const pathsInput: ResolveConfigPathsInput = {
    cwd: input.cwd,
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
  };
  const paths = resolveConfigPaths(pathsInput);
  const targetPath = input.scope === "user" ? paths.userPath : paths.projectPath;

  const result = await readLayer(targetPath, input.scope);
  switch (result.kind) {
    case "missing":
      return missingLayer(input, targetPath);
    case "valid":
      return {
        scope: input.scope,
        status: "valid",
        value: structuredClone(result.value),
        problemCodes: [],
        targetPath,
      };
    case "invalid":
    case "unreadable": {
      const codes: string[] = [];
      for (const problem of result.problems) {
        if (!codes.includes(problem.code)) codes.push(problem.code);
      }
      return {
        scope: input.scope,
        status: result.kind,
        value: { schemaVersion: 1 },
        problemCodes: codes,
        targetPath,
      };
    }
  }
}
