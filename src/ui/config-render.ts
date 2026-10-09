import type {
  CandidateRef,
  ConfigFile,
  ConfigSource,
  EffectiveConfig,
  LayerStatus,
  LoadResult,
  ThinkingBias,
  TierName,
} from "../config/types";
import type { ConfigScope } from "../config/layer-read";
import type { ManualTier } from "../commands/types";

/**
 * Pure configuration preview renderer (07-tui-modes.md §3.3 step 5, §6.2;
 * F7.1 spec §2.4).
 *
 * Renders the complete proposed target layer: stable labels, plain text, no
 * ANSI sequences, and never a filesystem path — the scope label stands in
 * for the target. Candidate lists are bounded (`...(+N more)`), scalar
 * fields carry a one-value contrast against the current effective config so
 * the user sees what the save would change. Nothing here reads files,
 * touches a registry, or throws; absent draft sections render as inherited
 * rather than fabricated.
 *
 * F7.2 adds the effective-view projection on the same rules (07 §3.5/§4.4):
 * `buildConfigView` is a pure function over the runtime `LoadResult` plus
 * the branch manual override; `renderConfigView` emits the canonical view
 * text with the four Phase 2 `LayerStatus` literals (never folding
 * `unreadable`), leaf provenance, bounded tier lists, and the session
 * override note — no paths, no secrets, no raw error text.
 */

/** Candidates shown per tier before the stable overflow marker. */
const PREVIEW_CANDIDATES_SHOWN = 6;

const TIER_ORDER: readonly TierName[] = ["brain", "pillar", "crowd"];

function candidateIdentity(candidate: CandidateRef): string {
  return `${candidate.provider}/${candidate.id}`;
}

function renderCandidates(list: readonly CandidateRef[] | undefined): string {
  if (list === undefined) return "inherited (not set in this layer)";
  if (list.length === 0) return "none";
  const shown = list.slice(0, PREVIEW_CANDIDATES_SHOWN).map(candidateIdentity);
  const rest = list.length - shown.length;
  return rest > 0 ? `${shown.join(", ")}, ...(+${rest} more)` : shown.join(", ");
}

/**
 * Render the preview block for one proposed target layer. `effective` is
 * the current in-memory effective config (the pre-save baseline for the
 * scalar contrasts); `draft` is the complete layer the flow would save.
 */
export function renderConfigPreview(
  effective: EffectiveConfig,
  scope: ConfigScope,
  draft: ConfigFile,
): string {
  const lines: string[] = [
    "pi-tier-scheduler configuration preview",
    `scope: ${scope}`,
  ];
  for (const tier of TIER_ORDER) {
    const list = draft.tiers?.[tier]?.candidates;
    const count = list?.length ?? 0;
    lines.push(`${tier} candidates (${count}): ${renderCandidates(list)}`);
  }
  const bias = draft.policy?.defaultBias;
  lines.push(
    `policy: defaultBias=${bias ?? "inherited"} (current: ${effective.policy.defaultBias}); ` +
      `sticky=${draft.policy?.sticky ?? "inherited"} (current: ${effective.policy.sticky})`,
  );
  const attempts = draft.retry?.maxAttemptsPerRequest;
  const switches = draft.retry?.maxTierSwitches;
  lines.push(
    `retry: attempts=${attempts ?? "inherited"} (current: ${effective.retry.maxAttemptsPerRequest}); ` +
      `tier-switches=${switches ?? "inherited"} (current: ${effective.retry.maxTierSwitches})`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// F7.2 effective configuration view (07-tui-modes.md §3.5/§4.4).
// ---------------------------------------------------------------------------

/** Candidates shown per tier before the stable overflow marker. */
export const VIEW_CANDIDATES_SHOWN = 6;

/**
 * Effective configuration view model (07 §4.4, frozen shape). The Phase 2
 * `LayerStatus` vocabulary is imported as-is; `omittedCount` is the number
 * of candidates hidden by the display bound (the `+N` in `...(+N more)`),
 * so the renderer stays a pure function of this record.
 */
export type ConfigView = {
  health: "valid" | "degraded";
  sourceStatus: Record<"user" | "project", LayerStatus>;
  policy: {
    defaultBias: ThinkingBias;
    defaultBiasSource: ConfigSource;
    sticky: boolean;
    stickySource: ConfigSource;
  };
  retry: {
    maxAttemptsPerRequest: number;
    attemptsSource: ConfigSource;
    maxTierSwitches: number;
    tierSwitchesSource: ConfigSource;
  };
  tiers: Record<
    TierName,
    { candidates: readonly CandidateRef[]; source: ConfigSource; omittedCount: number }
  >;
  sessionOverride: ManualTier | null;
  problemCount: number;
};

function tierView(
  effective: EffectiveConfig,
  tier: TierName,
): ConfigView["tiers"][TierName] {
  const candidates = effective.tiers[tier].candidates;
  return {
    candidates,
    source: effective.provenance[`tiers.${tier}.candidates`] ?? "defaults",
    omittedCount: Math.max(0, candidates.length - VIEW_CANDIDATES_SHOWN),
  };
}

/**
 * Pure projection of one runtime load into the view model (07 §3.5). Leaf
 * provenance comes from the Phase 2 merge record; a leaf no layer wrote
 * reads as `defaults`. The manual override is passed in by the caller
 * (router state, not file configuration — 02 §3.2).
 */
export function buildConfigView(
  load: LoadResult,
  manualOverride: ManualTier | null,
): ConfigView {
  const effective = load.effective;
  const sourceOf = (key: string): ConfigSource => effective.provenance[key] ?? "defaults";
  return {
    health: load.problems.length > 0 ? "degraded" : "valid",
    sourceStatus: { user: load.layers.user, project: load.layers.project },
    policy: {
      defaultBias: effective.policy.defaultBias,
      defaultBiasSource: sourceOf("policy.defaultBias"),
      sticky: effective.policy.sticky,
      stickySource: sourceOf("policy.sticky"),
    },
    retry: {
      maxAttemptsPerRequest: effective.retry.maxAttemptsPerRequest,
      attemptsSource: sourceOf("retry.maxAttemptsPerRequest"),
      maxTierSwitches: effective.retry.maxTierSwitches,
      tierSwitchesSource: sourceOf("retry.maxTierSwitches"),
    },
    tiers: {
      brain: tierView(effective, "brain"),
      pillar: tierView(effective, "pillar"),
      crowd: tierView(effective, "crowd"),
    },
    sessionOverride: manualOverride,
    problemCount: load.problems.length,
  };
}

/**
 * Pure text renderer of the effective view (07 §3.5 canonical form).
 * Every `LayerStatus` renders as its literal label; bounded tier lists use
 * the stable `...(+N more)` marker; `session override` reports the router
 * control state (`automatic` when no manual tier is active). Problem
 * counts render as a count, never raw parser text (§3.9).
 */
export function renderConfigView(view: ConfigView): string {
  const lines: string[] = [
    "pi-tier-scheduler configuration",
    `effective: ${view.health}`,
    `sources: user=${view.sourceStatus.user}; project=${view.sourceStatus.project}`,
    `policy: defaultBias=${view.policy.defaultBias} (${view.policy.defaultBiasSource}); ` +
      `sticky=${view.policy.sticky} (${view.policy.stickySource})`,
    `retry: attempts=${view.retry.maxAttemptsPerRequest} (${view.retry.attemptsSource}); ` +
      `tier-switches=${view.retry.maxTierSwitches} (${view.retry.tierSwitchesSource})`,
  ];
  for (const tier of TIER_ORDER) {
    const entry = view.tiers[tier];
    let list: string;
    if (entry.candidates.length === 0) {
      list = "none";
    } else {
      const shown = entry.candidates.slice(0, VIEW_CANDIDATES_SHOWN).map(candidateIdentity);
      list =
        entry.omittedCount > 0
          ? `${shown.join(", ")}, ...(+${entry.omittedCount} more)`
          : shown.join(", ");
    }
    lines.push(`${tier} candidates (${entry.source}, ${entry.candidates.length}): ${list}`);
  }
  lines.push(`session override: ${view.sessionOverride ?? "automatic"}`);
  if (view.problemCount > 0) {
    lines.push(`problems: ${view.problemCount}`);
  }
  return lines.join("\n");
}
