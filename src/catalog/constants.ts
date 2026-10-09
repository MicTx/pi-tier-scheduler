/**
 * Catalog-owned constants (03-catalog.md §3.1/§6.3).
 *
 * Catalog-owned values are self-held on purpose: the package boundary forbids
 * touching `src/config/**` (so no shared tier-order constant exists), and the
 * Pi SDK does not root-export its virtual-model sentinel. The TierName union
 * in `src/config/types.ts` remains the single type source of truth; the array
 * below just fixes one deterministic walk order for snapshotting, resolution,
 * and diagnostic aggregation.
 */
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { TierName } from "../config/types";

/**
 * Sentinel `api` of Pi virtual catalog entries. The catalog must never admit
 * them as candidates: they route to ts/auto inside the Pi host, which would
 * break deterministic routing (03-catalog.md §3.2).
 *
 * Anchor: pi-coding-agent `dist/core/virtual-models.js` sets `api: "pi-virtual"`
 * via its `VIRTUAL_MODEL_API`, which is not root-exported. If a Pi upgrade ever
 * changes this value, this is the single place to re-check.
 */
export const PI_VIRTUAL_API = "pi-virtual";

/**
 * Fixed tier walk order (brain -> pillar -> crowd) for snapshot ref collection,
 * resolution, and the tier-group order of `resolution.diagnostics`.
 */
export const CATALOG_TIER_ORDER: readonly TierName[] = ["brain", "pillar", "crowd"];

/**
 * Pi's fixed thinking-level order. `EXTENDED_THINKING_LEVELS` is private to
 * pi-ai's models module, so keep this compatibility anchor locally.
 */
export const THINKING_LEVEL_ORDER: readonly ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
