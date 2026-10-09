/**
 * Registry snapshotting (03-catalog.md §3.1/§5.1, spec §2.2).
 *
 * One `getAvailable()` sample plus one `find()` per unique configured ref,
 * frozen into a `CatalogSnapshot`. This is the only module that talks to the
 * `ModelRegistry` type; `resolve.ts` consumes pure snapshots.
 *
 * Registry exceptions never propagate: each failure is recorded as a
 * `RegistrySnapshotProblem`, and the raw exception goes only to `console.debug`
 * (the local debug channel — never into results, route state, or persistence),
 * so resolution can proceed on partial data and no diagnostic ever carries
 * exception text (03-catalog.md §3.3).
 */
import type { CandidateRef, EffectiveConfig } from "../config/types";

import { CATALOG_TIER_ORDER } from "./constants";
import type {
  CandidateKey,
  CatalogRegistry,
  CatalogSnapshot,
  PhysicalChatModel,
  RegistrySnapshotProblem,
} from "./types";

/**
 * Identity key of a candidate: `provider + "\0" + id` (03-catalog.md §3.1).
 * The NUL separator cannot occur in either field, so distinct refs never
 * collide across a field boundary.
 */
export function candidateKey(ref: CandidateRef): CandidateKey {
  return `${ref.provider}\0${ref.id}`;
}

/**
 * Snapshot the registry for one resolution: a single `getAvailable()` sample,
 * then one `find()` per unique configured ref collected in fixed tier order so
 * problem order is deterministic. If `getAvailable()` throws, lookups still
 * run and the available set is empty — availability is unknown, never assumed
 * (spec §2.2). Failures are recorded, never thrown.
 */
export function snapshotRegistry(config: EffectiveConfig, registry: CatalogRegistry): CatalogSnapshot {
  const problems: RegistrySnapshotProblem[] = [];

  let available = new Set<CandidateKey>();
  try {
    available = new Set<CandidateKey>(registry.getAvailable().map(candidateKey));
  } catch (error) {
    problems.push({ operation: "availability_snapshot" });
    console.debug("[tier-scheduler] catalog availability snapshot failed:", error);
  }

  // One find() per unique ref, deduplicated across tiers and repeats; the same
  // ref found through any tier shares this single lookup result (spec §2.2).
  const models = new Map<CandidateKey, PhysicalChatModel | undefined>();
  for (const tier of CATALOG_TIER_ORDER) {
    for (const ref of config.tiers[tier].candidates) {
      const key = candidateKey(ref);
      if (models.has(key)) {
        continue;
      }
      try {
        models.set(key, registry.find(ref.provider, ref.id));
      } catch (error) {
        models.set(key, undefined);
        problems.push({ operation: "model_lookup", ref });
        console.debug(`[tier-scheduler] catalog model lookup failed for ${ref.provider}/${ref.id}:`, error);
      }
    }
  }

  return { models, available, problems };
}
