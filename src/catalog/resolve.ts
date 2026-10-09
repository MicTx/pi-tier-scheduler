/**
 * Candidate admission and tier resolution (03-catalog.md §3.2/§5.2/§5.4, spec §2.2).
 *
 * `resolveCatalogSnapshot` walks tiers in the fixed order and applies the
 * admission chain to every configured candidate: lookup-problem -> not-found ->
 * identity-mismatch -> virtual -> non-chat -> not-available -> ResolvedCandidate.
 * The virtual check runs before the chat gate on purpose: virtual entries are
 * chat-shaped `Model<Api>` objects (no `type` field), so type-checking first
 * would let them through (spec §2.2).
 *
 * Diagnostics are deterministic: per tier, tier-level records first
 * (`registry_snapshot_failed`, then `tier_empty` or `tier_exhausted`), then
 * candidate-level skips in authored order. Tier-level records never enter
 * `ResolvedTier.skipped`. Snapshot problems are carried through separately and
 * never expanded into diagnostics.
 *
 * Both entry points are pure over their inputs: no I/O, no cache, no
 * module-level state — a fresh resolution per call (03-catalog.md §5.1).
 */
import { isModelType } from "@earendil-works/pi-ai";

import type { CandidateRef, EffectiveConfig, TierName } from "../config/types";

import { CATALOG_TIER_ORDER, PI_VIRTUAL_API } from "./constants";
import { candidateKey, snapshotRegistry } from "./snapshot";
import type {
  CatalogDiagnostic,
  CatalogRegistry,
  CatalogResolution,
  CatalogSnapshot,
  CandidateKey,
  CandidateResolutionCode,
  ResolvedCandidate,
  ResolvedTier,
} from "./types";

/** Keys whose registry lookup threw: definitive failures, availability-independent. */
function lookupFailedKeys(snapshot: CatalogSnapshot): Set<CandidateKey> {
  const keys = new Set<CandidateKey>();
  for (const problem of snapshot.problems) {
    if (problem.operation === "model_lookup" && problem.ref !== undefined) {
      keys.add(candidateKey(problem.ref));
    }
  }
  return keys;
}

/**
 * Resolve one config against one registry snapshot (03-catalog.md §5.2).
 * The result is structurally complete even when the availability snapshot
 * failed: all three tier keys are present, every found candidate is
 * conservatively skipped as `candidate_not_available` (unknown availability is
 * never turned into availability), and not-found / lookup-failed candidates
 * keep their definitive verdicts (03-catalog.md §5.4).
 */
export function resolveCatalogSnapshot(
  snapshot: CatalogSnapshot,
  config: EffectiveConfig,
): CatalogResolution {
  const failedLookups = lookupFailedKeys(snapshot);
  const availabilityFailed = snapshot.problems.some(
    (problem) => problem.operation === "availability_snapshot",
  );

  // CATALOG_TIER_ORDER covers the full TierName union; every key is set below.
  const tiers = {} as Record<TierName, ResolvedTier>;
  const diagnostics: CatalogDiagnostic[] = [];

  for (const tier of CATALOG_TIER_ORDER) {
    const configured = config.tiers[tier].candidates;
    const candidates: ResolvedCandidate[] = [];
    const skipped: CatalogDiagnostic[] = [];
    const tierDiagnostics: CatalogDiagnostic[] = [];

    if (availabilityFailed) {
      tierDiagnostics.push({
        tier,
        code: "registry_snapshot_failed",
        severity: "error",
        operation: "availability_snapshot",
      });
    }

    const skip = (
      candidateIndex: number,
      ref: CandidateRef,
      code: CandidateResolutionCode,
      severity: CatalogDiagnostic["severity"],
      operation?: CatalogDiagnostic["operation"],
    ): void => {
      const diagnostic: CatalogDiagnostic = { tier, candidateIndex, ref, code, severity };
      if (operation !== undefined) {
        diagnostic.operation = operation;
      }
      skipped.push(diagnostic);
    };

    configured.forEach((ref, candidateIndex) => {
      const key = candidateKey(ref);
      const found = snapshot.models.get(key);

      if (failedLookups.has(key)) {
        skip(candidateIndex, ref, "candidate_lookup_failed", "error", "model_lookup");
      } else if (found === undefined) {
        skip(candidateIndex, ref, "candidate_not_found", "warning");
      } else if (found.provider !== ref.provider || found.id !== ref.id) {
        skip(candidateIndex, ref, "candidate_identity_mismatch", "warning");
      } else if (found.api === PI_VIRTUAL_API) {
        skip(candidateIndex, ref, "candidate_virtual_model", "info");
      } else if (!isModelType(found, "chat")) {
        skip(candidateIndex, ref, "candidate_non_chat_model", "warning");
      } else if (!snapshot.available.has(key)) {
        skip(candidateIndex, ref, "candidate_not_available", "warning");
      } else {
        candidates.push({ tier, configIndex: candidateIndex, ref, key, model: found });
      }
    });

    if (configured.length === 0) {
      tierDiagnostics.push({ tier, code: "tier_empty", severity: "info" });
    } else if (candidates.length === 0) {
      tierDiagnostics.push({ tier, code: "tier_exhausted", severity: "warning" });
    }

    tiers[tier] = { tier, configured, candidates, skipped };
    diagnostics.push(...tierDiagnostics, ...skipped);
  }

  return { tiers, diagnostics, snapshotProblems: snapshot.problems };
}

/**
 * Resolve one config against one registry: snapshot the registry fresh, then
 * resolve the snapshot. Composite entry point for later phases — called at the
 * start of every routing or diagnostic operation (03-catalog.md §6.2).
 */
export function resolveCatalog(config: EffectiveConfig, registry: CatalogRegistry): CatalogResolution {
  return resolveCatalogSnapshot(snapshotRegistry(config, registry), config);
}
