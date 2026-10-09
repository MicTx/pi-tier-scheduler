import { SCHEMA_VERSION } from "./constants";
import { validateConfigLayer } from "./schema";
import type {
  CompleteConfig,
  ConfigFile,
  ConfigSource,
  EffectiveConfig,
  SessionConfigPatch,
} from "./types";

/**
 * Priority merge (02-config.md §3.2): defaults < user < project, plus the
 * reserved session seam. mergeConfig is a pure function — inputs are never
 * mutated, and the produced tree shares no mutable structure with any input
 * (the only shared values are immutable scalars), so callers can treat the
 * result as their own working state.
 *
 * Merge rules:
 * - plain objects merge key-recursively; a key absent in a higher layer
 *   inherits the lower layer's value
 * - arrays (candidate lists) replace wholesale — never concatenated,
 *   reordered, or deduplicated
 * - scalars replace; `schemaVersion` is deliberately not special-cased
 *   (§2.4): every participating layer is version 1 or it never got past
 *   layer validation, so it records provenance like any other leaf
 *
 * Provenance records the highest writer per leaf, keyed by dot path with
 * candidate arrays as one whole key (`tiers.brain.candidates`), matching
 * the whole-replace rule.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Leaves are scalars or arrays. Arrays deep-clone; scalars are immutable. */
function cloneLeaf(value: unknown): unknown {
  return Array.isArray(value) ? structuredClone(value) : value;
}

/**
 * Rebuilds `value` as a fresh tree, recording every leaf's provenance.
 * Containers produce no provenance entry of their own.
 */
function buildFresh(
  value: unknown,
  prefix: string,
  source: ConfigSource,
  provenance: Record<string, ConfigSource>,
): unknown {
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      out[key] = buildFresh(value[key], path, source, provenance);
    }
    return out;
  }
  if (prefix !== "") provenance[prefix] = source;
  return cloneLeaf(value);
}

/**
 * Applies one layer's patch onto the working tree. Every leaf the patch
 * writes records `source` as its highest writer; keys the patch omits keep
 * whatever the lower layers already established.
 */
function mergePatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
  prefix: string,
  source: ConfigSource,
  provenance: Record<string, ConfigSource>,
): void {
  for (const key of Object.keys(patch)) {
    const value: unknown = patch[key];
    // JSON layers cannot carry undefined; a hand-crafted object that does is
    // treated as absent so the lower layer's value is inherited.
    if (value === undefined) continue;
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (isPlainObject(value)) {
      const existing: unknown = target[key];
      if (isPlainObject(existing)) {
        mergePatch(existing, value, path, source, provenance);
      } else {
        const fresh: Record<string, unknown> = {};
        mergePatch(fresh, value, path, source, provenance);
        target[key] = fresh;
      }
    } else {
      target[key] = cloneLeaf(value);
      provenance[path] = source;
    }
  }
}

/**
 * Merges defaults with the (already validated) user and project layers in
 * priority order. Callers pass `defaultConfig()` in production; tests may
 * pass any CompleteConfig. Layers skip validation here — readLayer already
 * gated them and the load orchestrator runs the net-shape check (§5.1).
 */
export function mergeConfig(
  defaults: CompleteConfig,
  user?: ConfigFile,
  project?: ConfigFile,
): EffectiveConfig {
  const provenance: Record<string, ConfigSource> = {};
  const working = buildFresh(defaults, "", "defaults", provenance) as Record<string, unknown>;
  if (user !== undefined) {
    mergePatch(working, user as Record<string, unknown>, "", "user", provenance);
  }
  if (project !== undefined) {
    mergePatch(working, project as Record<string, unknown>, "", "project", provenance);
  }
  return { ...working, provenance } as EffectiveConfig;
}

/**
 * Clones a tree of plain config values without touching any provenance map —
 * arrays deep-clone, scalars pass through, objects rebuild key by key.
 */
function cloneTree(value: unknown): unknown {
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = cloneTree(value[key]);
    }
    return out;
  }
  return cloneLeaf(value);
}

/**
 * Reserved session seam (§4.3): declared, versioned, and tested, but with no
 * first-release caller — the session tier is filled from router state by
 * Phase 4/5, not by persisting a patch. The patch uses the same vocabulary
 * and layer validation as file layers: `SCHEMA_VERSION` is injected solely to
 * satisfy validation and is stripped before merging, so only patch-authored
 * leaves take the `session` mark and untouched leaves keep their provenance.
 *
 * Pure: neither input is mutated, and the result shares no mutable structure
 * with either. Throws when the patch violates the layer schema.
 */
export function applySessionOverride(
  effective: EffectiveConfig,
  patch: SessionConfigPatch,
): EffectiveConfig {
  const validated = validateConfigLayer(
    { ...patch, schemaVersion: SCHEMA_VERSION },
    "session",
  );
  if (!validated.ok) {
    // Stable codes and JSON paths only — never raw patch values.
    const detail = validated.errors.map((e) => `${e.code}@${e.path}`).join(", ");
    throw new Error(`invalid session override: ${detail}`);
  }
  const { schemaVersion: _injected, ...patchBody } = validated.value;
  const { provenance: originalProvenance, ...configPart } = effective;
  const working = cloneTree(configPart) as Record<string, unknown>;
  const provenance: Record<string, ConfigSource> = { ...originalProvenance };
  mergePatch(working, patchBody, "", "session", provenance);
  return { ...working, provenance } as EffectiveConfig;
}
