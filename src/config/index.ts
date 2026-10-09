import { defaultConfig } from "./defaults";
import { readLayer, resolveConfigPaths } from "./discover";
import { mergeConfig } from "./merge";
import { validateEffectiveConfig } from "./schema";
import type { ResolveConfigPathsInput } from "./discover";
import type { ConfigFile, ConfigProblem, EffectiveConfig, LoadResult } from "./types";
import { layerStatusOf } from "./types";

/**
 * Load orchestration (02-config.md §5.1) and the config module's public
 * surface (§6.1). Loading reads exactly two layers — user then project —
 * merges them over the built-in defaults, and runs one defensive net-shape
 * check on the result. The only write on the load path is the §5.5
 * quarantine of malformed JSON, delegated to persist.ts.
 *
 * Barrel note: persist.ts (F2.3) joins the surface with `saveConfigFile` —
 * the config module's only writer — plus the `quarantineFile` helper that
 * readLayer's NOT_JSON branch uses for §5.5 recovery.
 */

export * from "./constants";
export * from "./defaults";
export * from "./discover";
export * from "./edit";
export * from "./layer-read";
export * from "./merge";
export * from "./persist";
export * from "./schema";
export * from "./types";

/**
 * Reads both layers, reports problems without failing the load, and merges
 * valid layers in priority order. A layer that is invalid or unreadable
 * simply does not participate; defaults and any lower valid layer still
 * apply (fail-soft, §3.3). The result is attached to runtime state by the
 * caller — no file observation and no reload command exist in this release.
 */
export async function loadEffectiveConfig(input: ResolveConfigPathsInput): Promise<LoadResult> {
  const paths = resolveConfigPaths(input);
  const [userLayer, projectLayer] = await Promise.all([
    readLayer(paths.userPath, "user"),
    readLayer(paths.projectPath, "project"),
  ]);

  // Stable user→project problem order; missing layers are not problems.
  const problems: ConfigProblem[] = [];
  for (const layer of [userLayer, projectLayer]) {
    if (layer.kind === "invalid" || layer.kind === "unreadable") {
      problems.push(...layer.problems);
    }
  }

  const user: ConfigFile | undefined = userLayer.kind === "valid" ? userLayer.value : undefined;
  const project: ConfigFile | undefined =
    projectLayer.kind === "valid" ? projectLayer.value : undefined;

  let effective: EffectiveConfig = mergeConfig(defaultConfig(), user, project);

  // Defensive net-shape check (§5.1): both layers already passed layer
  // validation and defaults-only is pinned valid by the schema tests, so a
  // violation here means the merge itself is broken. Fail soft: restore the
  // built-in defaults and report. The problem's source is the highest
  // participating layer; with no layer participating (unreachable) the
  // "user" fallback is nominal.
  const { provenance: _recorded, ...netShape } = effective;
  const checked = validateEffectiveConfig(netShape, "merge");
  if (!checked.ok) {
    effective = mergeConfig(defaultConfig());
    problems.push({
      source: project !== undefined ? "project" : "user",
      path: "",
      severity: "error",
      code: "MERGE_INVARIANT_VIOLATION",
      message: `merged config failed effective validation (${checked.errors
        .map((e) => e.code)
        .join(", ")}); built-in defaults restored`,
    });
  }

  return {
    effective,
    problems,
    paths,
    // Per-layer status is derived once from the layer reads, not from the
    // problem list: `missing` layers carry no problem, and `invalid` vs
    // `unreadable` cannot be told apart from `problems` alone.
    layers: {
      user: layerStatusOf(userLayer),
      project: layerStatusOf(projectLayer),
    },
  };
}
