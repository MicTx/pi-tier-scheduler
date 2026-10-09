import type { EditableConfigLayer } from "./layer-read";
import { defaultConfig } from "./defaults";
import { mergeConfig } from "./merge";
import type {
  CandidateRef,
  CompleteConfig,
  ConfigFile,
  EffectiveConfig,
  RetryConfig,
  TierName,
  ThinkingBias,
} from "./types";

/**
 * Pure draft operations for the Phase 7 configuration flows
 * (07-tui-modes.md §4.5; F7.1 spec §2.2).
 *
 * Every helper returns a new value — a deep clone with exactly one field
 * replaced — and never mutates its input, `DEFAULT_CONFIG`, an effective
 * runtime object, or a layer snapshot. The helpers do not validate: input
 * dialogs bound what a user may enter, and `validateConfigLayer` remains
 * the authoritative schema check before preview and persistence.
 *
 * F7.1 uses the init set (`createInitDraft` plus the three setters); the
 * F7.2 partial-layer editor adds the edit set on top of the same rules
 * (`createEditDraft`, the three reset-to-inherit deleters, and the
 * `applyDraftToEffective` merge composition) — all still pure, all still
 * deep-cloning, still never writing a `null` deletion sentinel.
 */

/** Canonical tier order for draft construction and wizard traversal. */
export const TIER_ORDER: readonly TierName[] = ["brain", "pillar", "crowd"];

/**
 * The complete initial draft for `/ts init` (07 §3.3): a full target layer
 * built from the passed defaults — candidates copied per tier in authored
 * order, policy and retry copied verbatim. The caller passes
 * `defaultConfig()` in production; the parameter keeps the helper pure and
 * testable against any complete shape.
 */
export function createInitDraft(defaults: CompleteConfig): ConfigFile {
  return structuredClone({
    schemaVersion: 1,
    tiers: {
      brain: { candidates: [...defaults.tiers.brain.candidates] },
      pillar: { candidates: [...defaults.tiers.pillar.candidates] },
      crowd: { candidates: [...defaults.tiers.crowd.candidates] },
    },
    policy: { ...defaults.policy },
    retry: { ...defaults.retry },
  });
}

/** Replace one tier's candidate list; authored order is preserved verbatim. */
export function setTierCandidates(
  draft: ConfigFile,
  tier: TierName,
  candidates: readonly CandidateRef[],
): ConfigFile {
  const next = structuredClone(draft);
  const tiers = { ...next.tiers };
  const existing = tiers[tier] ?? {};
  tiers[tier] = { ...existing, candidates: structuredClone([...candidates]) };
  next.tiers = tiers;
  return next;
}

/** Set `policy.defaultBias`; the overload pins the value to the bias union. */
export function setPolicyField(
  draft: ConfigFile,
  field: "defaultBias",
  value: ThinkingBias,
): ConfigFile;
/** Set `policy.sticky`; the overload pins the value to a boolean. */
export function setPolicyField(draft: ConfigFile, field: "sticky", value: boolean): ConfigFile;
export function setPolicyField(
  draft: ConfigFile,
  field: "defaultBias" | "sticky",
  value: ThinkingBias | boolean,
): ConfigFile {
  const next = structuredClone(draft);
  const policy = { ...(next.policy ?? {}) };
  // The overloads guarantee the field/value pairing; the implementation
  // signature carries the union, so the writes narrow by assertion.
  if (field === "defaultBias") {
    policy.defaultBias = value as ThinkingBias;
  } else {
    policy.sticky = value as boolean;
  }
  next.policy = policy;
  return next;
}

/** Set one retry bound; both fields are bounded integers in Phase 2. */
export function setRetryField(
  draft: ConfigFile,
  field: keyof RetryConfig,
  value: number,
): ConfigFile {
  const next = structuredClone(draft);
  const retry = { ...(next.retry ?? {}) };
  if (field === "maxAttemptsPerRequest") retry.maxAttemptsPerRequest = value;
  else retry.maxTierSwitches = value;
  next.retry = retry;
  return next;
}

/**
 * The starting draft for the `/ts config` partial-layer editor
 * (07 §3.6/§4.5): a missing target begins as `{ schemaVersion: 1 }` — never
 * a copy of the effective config, so an unrelated edit cannot shadow
 * lower-layer values — and a valid target is cloned field for field,
 * preserving its partial-layer semantics exactly (omitted keys stay
 * omitted). Invalid/unreadable targets never reach this helper; the
 * command layer routes them to `/ts init`.
 */
export function createEditDraft(layer: EditableConfigLayer): ConfigFile {
  if (layer.status === "missing") {
    return { schemaVersion: 1 };
  }
  return structuredClone(layer.value);
}

/**
 * Reset one tier to inheritance by deleting its key from the draft
 * (07 §2.3: inheritance is key omission, never a `null` sentinel). When
 * the last tier key goes, the whole `tiers` section goes with it, so a
 * fully reset draft saves as `{ "schemaVersion": 1 }`.
 */
export function resetTierToInherited(draft: ConfigFile, tier: TierName): ConfigFile {
  const next = structuredClone(draft);
  if (next.tiers === undefined) return next;
  const tiers = { ...next.tiers };
  delete tiers[tier];
  if (Object.keys(tiers).length === 0) {
    delete next.tiers;
  } else {
    next.tiers = tiers;
  }
  return next;
}

/** Reset one policy field to inheritance by deleting the leaf key. */
export function resetPolicyField(
  draft: ConfigFile,
  field: "defaultBias" | "sticky",
): ConfigFile {
  const next = structuredClone(draft);
  if (next.policy === undefined) return next;
  const policy = { ...next.policy };
  delete policy[field];
  if (Object.keys(policy).length === 0) {
    delete next.policy;
  } else {
    next.policy = policy;
  }
  return next;
}

/** Reset one retry bound to inheritance by deleting the leaf key. */
export function resetRetryField(
  draft: ConfigFile,
  field: "maxAttemptsPerRequest" | "maxTierSwitches",
): ConfigFile {
  const next = structuredClone(draft);
  if (next.retry === undefined) return next;
  const retry = { ...next.retry };
  delete retry[field];
  if (Object.keys(retry).length === 0) {
    delete next.retry;
  } else {
    next.retry = retry;
  }
  return next;
}

/** The current on-disk layer pair; only the layer NOT being edited feeds a preview. */
export type ConfigLayerPair = {
  user?: ConfigFile;
  project?: ConfigFile;
};

/**
 * Compose the effective result a save of `draft` at `scope` would produce,
 * using the Phase 2 merge function only — never a second merge algorithm
 * (07 §3.6; 02 §3.2): a project-scope draft sits at the top
 * (`mergeConfig(defaults, user, draft)`), a user-scope draft keeps the
 * project layer above it (`mergeConfig(defaults, draft, project)`). The
 * pair's edited layer is ignored by construction; pass the values as read.
 */
export function applyDraftToEffective(
  pair: ConfigLayerPair,
  draft: ConfigFile,
  scope: "user" | "project",
): EffectiveConfig {
  const defaults = defaultConfig();
  return scope === "project"
    ? mergeConfig(defaults, pair.user, draft)
    : mergeConfig(defaults, draft, pair.project);
}
