import { MAX_ATTEMPTS_PER_REQUEST, MAX_TIER_SWITCHES } from "../config/constants";
import {
  applyDraftToEffective,
  resetPolicyField,
  resetRetryField,
  resetTierToInherited,
  setPolicyField,
  setRetryField,
  setTierCandidates,
  TIER_ORDER,
} from "../config/edit";
import { validateConfigLayer } from "../config/schema";
import type {
  CandidateRef,
  ConfigError,
  ConfigFile,
  EffectiveConfig,
  TierName,
  ThinkingBias,
} from "../config/types";
import type { ConfigScope, EditableConfigLayer } from "../config/layer-read";
import type { CatalogPickOption } from "../catalog/picker";
import { renderConfigPreview } from "./config-render";

/**
 * Wizard and partial-editor dialog sequences (07-tui-modes.md §3.3–§3.6,
 * §5.2–§5.4; F7.1 spec §2.2, F7.2 spec §2.2).
 *
 * Every function here is a pure orchestration over Pi's built-in TUI
 * dialogs: no filesystem, no provider access, no persistence. Zero `ctx.ui`
 * calls happen outside the passed `ui` seam, so
 * scripted fakes cover the whole module.
 *
 * Cancellation is one uniform edge: any `select`/`input` resolving
 * `undefined` (escape, timeout, abort-signal dismissal), any exhausted
 * invalid-input budget, and a closed runtime observed between steps all
 * collapse to the same `{ ok: false }` outcome; the command layer maps them
 * all to the stable `configuration cancelled; no changes made` response.
 * A `confirm` resolving `false` is a valid negative answer to the question
 * asked (clear, sticky, final commit) — only the final commit's `false`
 * means "do not save" (07 §2.1).
 */

/** Structural view of the Pi dialog seam (types.d.ts:74-108). */
export type ConfigDialogsUi = {
  select(
    title: string,
    options: readonly string[],
    opts?: { signal?: AbortSignal; timeout?: number },
  ): Promise<string | undefined>;
  confirm(
    title: string,
    message: string,
    opts?: { signal?: AbortSignal; timeout?: number },
  ): Promise<boolean>;
  input(
    title: string,
    placeholder?: string,
    opts?: { signal?: AbortSignal; timeout?: number },
  ): Promise<string | undefined>;
};

/** What every dialog step reads: the ui seam, the abort signal, shutdown. */
export type ConfigDialogsContext = {
  ui: ConfigDialogsUi;
  /** Passed into every dialog call so aborts dismiss it (07 §2.1). */
  signal?: AbortSignal;
  /** Runtime-closed observation, checked between steps (07 §3.4/§5.8). */
  isClosed(): boolean;
  /**
   * Catalog-driven pick options read from Pi's model registry (spec:
   * catalog-driven-candidate-picker). Absent or empty when the registry is
   * unavailable — the ADD path then falls back to manual entry, exactly as
   * in the 0.2.0 flow.
   */
  catalog?: readonly CatalogPickOption[];
};

/** Step outcome: a value, or one uniform cancellation reason. */
export type DialogFlowOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "cancelled" | "exhausted" | "closed" };

/** UI draft bound per tier (07 §3.4). */
export const MAX_CANDIDATES_PER_TIER = 32;

/** Consecutive invalid answers tolerated at one prompt (F7.1 spec §2.2). */
export const MAX_INVALID_INPUT_ATTEMPTS = 3;

/** Per-field length bound for provider/id input (F7.1 spec §2.2). */
export const MAX_FIELD_LENGTH = 200;

function cancelled<T>(): DialogFlowOutcome<T> {
  return { ok: false, reason: "cancelled" };
}

function closed<T>(): DialogFlowOutcome<T> {
  return { ok: false, reason: "closed" };
}

/** Dialog options carry the abort signal when one exists (07 §2.1). */
function dialogOpts(ctx: ConfigDialogsContext): { signal?: AbortSignal } | undefined {
  return ctx.signal === undefined ? undefined : { signal: ctx.signal };
}

/**
 * Normalize one provider/id input: trimmed, non-empty, no control
 * characters, bounded to MAX_FIELD_LENGTH. Returns null when invalid —
 * the reason is conveyed by the fixed prompt text, not a per-attempt
 * message.
 */
export function normalizeCandidateField(raw: string): string | null {
  const value = raw.trim();
  if (value === "" || value.length > MAX_FIELD_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function candidateIdentity(candidate: CandidateRef): string {
  return `${candidate.provider}/${candidate.id}`;
}

function cloneCandidate(candidate: CandidateRef): CandidateRef {
  return { provider: candidate.provider, id: candidate.id };
}

/**
 * Bounded identity list for dialog titles: at most six entries plus the
 * stable overflow marker, never a path or raw error.
 */
function boundedIdentities(list: readonly CandidateRef[], shown = 6): string {
  if (list.length === 0) return "empty";
  const head = list.slice(0, shown).map(candidateIdentity);
  const rest = list.length - head.length;
  return rest > 0 ? `${head.join(", ")}, ...(+${rest} more)` : head.join(", ");
}

/** Layer summary line for the confirm dialogs (07 §3.2/§3.3 step 1). */
export function layerSummaryLine(layer: EditableConfigLayer): string {
  const tierCounts = (["brain", "pillar", "crowd"] as const)
    .map((tier) => `${tier}=${layer.value.tiers?.[tier]?.candidates?.length ?? 0}`)
    .join("; ");
  const head = `${layer.scope} layer — status: ${layer.status}`;
  if (layer.status === "invalid" || layer.status === "unreadable") {
    return `${head}; problems: ${layer.problemCodes.join(", ")}`;
  }
  const policy = layer.value.policy;
  const retry = layer.value.retry;
  return (
    `${head}; candidates: ${tierCounts}` +
    (policy?.defaultBias !== undefined || policy?.sticky !== undefined
      ? `; bias=${policy?.defaultBias ?? "inherit"}; sticky=${policy?.sticky ?? "inherit"}`
      : "") +
    (retry?.maxAttemptsPerRequest !== undefined || retry?.maxTierSwitches !== undefined
      ? `; attempts=${retry?.maxAttemptsPerRequest ?? "inherit"}; tier-switches=${retry?.maxTierSwitches ?? "inherit"}`
      : "")
  );
}

/** Ask one validated free-text input with the bounded invalid budget. */
async function askValidatedInput(
  ctx: ConfigDialogsContext,
  title: string,
  placeholder: string,
  isValid: (value: string) => boolean,
): Promise<DialogFlowOutcome<string>> {
  for (let invalid = 0; ; ) {
    if (ctx.isClosed()) return closed();
    const raw = await ctx.ui.input(title, placeholder, dialogOpts(ctx));
    if (raw === undefined) return cancelled();
    const value = normalizeCandidateField(raw);
    if (value === null || !isValid(value)) {
      invalid += 1;
      if (invalid >= MAX_INVALID_INPUT_ATTEMPTS) return { ok: false, reason: "exhausted" };
      continue;
    }
    return { ok: true, value };
  }
}

/** Step 1: choose the target scope; `project` is the first option (07 §3.2). */
export async function chooseScope(
  ctx: ConfigDialogsContext,
): Promise<DialogFlowOutcome<ConfigScope>> {
  if (ctx.isClosed()) return closed();
  const choice = await ctx.ui.select(
    "configuration target scope (project is the recommended default)",
    ["project", "user"],
    dialogOpts(ctx),
  );
  if (choice !== "project" && choice !== "user") return cancelled();
  return { ok: true, value: choice };
}

/** Valid target: show the bounded summary and confirm editing it (07 §3.3 step 1). */
export async function confirmEditExistingLayer(
  ctx: ConfigDialogsContext,
  layer: EditableConfigLayer,
): Promise<DialogFlowOutcome<true>> {
  if (ctx.isClosed()) return closed();
  const yes = await ctx.ui.confirm(
    `edit the existing ${layer.scope} layer?`,
    `${layerSummaryLine(layer)}\nthe wizard will clone this layer as the starting draft; escape cancels with no write`,
    dialogOpts(ctx),
  );
  return yes ? { ok: true, value: true } : cancelled();
}

/** Invalid/unreadable target: confirm a deliberate replacement (07 §3.2). */
export async function confirmReplaceInvalidLayer(
  ctx: ConfigDialogsContext,
  layer: EditableConfigLayer,
): Promise<DialogFlowOutcome<true>> {
  if (ctx.isClosed()) return closed();
  const yes = await ctx.ui.confirm(
    `replace the ${layer.scope} layer?`,
    `this target is ${layer.status}; problems: ${layer.problemCodes.join(", ")}\n` +
      "choosing yes starts from built-in defaults and keeps the existing bytes " +
      "recoverable through the Phase 2 backup classes; choosing no makes no changes",
    dialogOpts(ctx),
  );
  return yes ? { ok: true, value: true } : cancelled();
}

/** Tier-editing menu actions; the offered set depends on the current list. */
const TIER_ACTIONS = {
  add: "add a candidate",
  remove: "remove a candidate",
  move: "move a candidate up or down",
  clear: "clear all candidates",
  keep: "keep this tier as shown",
} as const;

function tierMenuTitle(tier: TierName, list: CandidateRef[]): string {
  const bound =
    list.length >= MAX_CANDIDATES_PER_TIER ? ` — tier full (${MAX_CANDIDATES_PER_TIER} additions max)` : "";
  return `tier ${tier} — candidates: ${boundedIdentities(list)}${bound}`;
}

function tierMenuOptions(list: CandidateRef[]): string[] {
  const options: string[] = [];
  if (list.length < MAX_CANDIDATES_PER_TIER) options.push(TIER_ACTIONS.add);
  if (list.length > 0) options.push(TIER_ACTIONS.remove);
  if (list.length >= 2) options.push(TIER_ACTIONS.move);
  if (list.length > 0) options.push(TIER_ACTIONS.clear);
  options.push(TIER_ACTIONS.keep);
  return options;
}

/** Ask provider and id as two validated inputs; duplicates re-ask the id. */
async function askCandidatePair(
  ctx: ConfigDialogsContext,
  tier: TierName,
  list: readonly CandidateRef[],
): Promise<DialogFlowOutcome<CandidateRef>> {
  const provider = await askValidatedInput(
    ctx,
    `add a candidate to ${tier}: provider`,
    "provider id (e.g. anthropic)",
    () => true,
  );
  if (!provider.ok) return provider;
  const id = await askValidatedInput(
    ctx,
    `add a candidate to ${tier}: model id (provider: ${provider.value})`,
    "model id (e.g. claude-opus-4-1)",
    (value) => !list.some((c) => c.provider === provider.value && c.id === value),
  );
  if (!id.ok) return id;
  return { ok: true, value: { provider: provider.value, id: id.value } };
}

/**
 * Step 2: edit one tier's candidate list (07 §3.3 step 2, §3.4). Add /
 * remove / move / clear / keep over the cloned draft list; authored order
 * is the dispatch priority order and is only changed by an explicit move.
 * Any dialog cancellation discards the whole flow at the command layer.
 */
export async function editTierCandidates(
  ctx: ConfigDialogsContext,
  tier: TierName,
  initial: readonly CandidateRef[],
): Promise<DialogFlowOutcome<CandidateRef[]>> {
  const list: CandidateRef[] = initial.map(cloneCandidate);
  for (;;) {
    if (ctx.isClosed()) return closed();
    const choice = await ctx.ui.select(tierMenuTitle(tier, list), tierMenuOptions(list), dialogOpts(ctx));
    if (choice === undefined) return cancelled();
    if (choice === TIER_ACTIONS.keep) return { ok: true, value: list };
    if (choice === TIER_ACTIONS.add) {
      let candidate: DialogFlowOutcome<CandidateRef>;
      // Catalog-driven pick when the registry snapshot is available and has
      // entries the tier does not hold yet; manual entry stays as the
      // explicit fallback for models the registry does not list.
      const catalog = (ctx.catalog ?? []).filter(
        (option) => !list.some((c) => c.provider === option.ref.provider && c.id === option.ref.id),
      );
      if (catalog.length > 0) {
        const manualAction = "Enter manually…";
        const pick = await ctx.ui.select(
          `add a candidate to ${tier} — pick a model`,
          [...catalog.map((o) => o.label), manualAction],
          dialogOpts(ctx),
        );
        if (pick === undefined) return cancelled();
        if (pick === manualAction) {
          candidate = await askCandidatePair(ctx, tier, list);
        } else {
          const option = catalog.find((o) => o.label === pick);
          candidate = option
            ? { ok: true, value: { provider: option.ref.provider, id: option.ref.id } }
            : await askCandidatePair(ctx, tier, list);
        }
      } else {
        candidate = await askCandidatePair(ctx, tier, list);
      }
      if (!candidate.ok) return candidate;
      list.push(candidate.value);
      continue;
    }
    if (choice === TIER_ACTIONS.remove) {
      const pick = await ctx.ui.select(
        `remove a candidate from ${tier}`,
        list.map(candidateIdentity),
        dialogOpts(ctx),
      );
      if (pick === undefined) return cancelled();
      const index = list.findIndex((c) => candidateIdentity(c) === pick);
      if (index >= 0) list.splice(index, 1);
      continue;
    }
    if (choice === TIER_ACTIONS.move) {
      const pick = await ctx.ui.select(
        `move a candidate in ${tier}`,
        list.map(candidateIdentity),
        dialogOpts(ctx),
      );
      if (pick === undefined) return cancelled();
      const index = list.findIndex((c) => candidateIdentity(c) === pick);
      if (index < 0) continue;
      const directions: string[] = [];
      if (index > 0) directions.push("up");
      if (index < list.length - 1) directions.push("down");
      if (directions.length === 0) continue;
      const direction = await ctx.ui.select(
        `move ${pick} — direction`,
        directions,
        dialogOpts(ctx),
      );
      if (direction === undefined) return cancelled();
      if (direction === "up" && index > 0) {
        [list[index - 1], list[index]] = [list[index], list[index - 1]];
      } else if (direction === "down" && index < list.length - 1) {
        [list[index + 1], list[index]] = [list[index], list[index + 1]];
      }
      continue;
    }
    if (choice === TIER_ACTIONS.clear) {
      const yes = await ctx.ui.confirm(
        `clear all ${tier} candidates?`,
        `${list.length} candidate(s) will be removed from this tier in the draft`,
        dialogOpts(ctx),
      );
      if (yes) list.length = 0;
      continue;
    }
  }
}

/**
 * Step 3: policy (07 §3.3 step 3). `defaultBias` is a select over the three
 * Phase 2 biases; `sticky` is a boolean confirm — `false` is the answer
 * `sticky=false`, not a cancellation (07 §2.1).
 */
export async function choosePolicy(
  ctx: ConfigDialogsContext,
  current: { defaultBias: ThinkingBias; sticky: boolean },
): Promise<DialogFlowOutcome<{ defaultBias: ThinkingBias; sticky: boolean }>> {
  if (ctx.isClosed()) return closed();
  const bias = await ctx.ui.select(
    `policy — defaultBias (current: ${current.defaultBias})`,
    ["low", "medium", "high"],
    dialogOpts(ctx),
  );
  if (bias !== "low" && bias !== "medium" && bias !== "high") return cancelled();
  if (ctx.isClosed()) return closed();
  const sticky = await ctx.ui.confirm(
    `policy — sticky (current: ${current.sticky})`,
    `continue follow-up requests with the previously used model? (yes = sticky, no = not sticky)`,
    dialogOpts(ctx),
  );
  return {
    ok: true,
    value: { defaultBias: bias, sticky },
  };
}

function range(from: number, to: number): string[] {
  const values: string[] = [];
  for (let value = from; value <= to; value += 1) values.push(String(value));
  return values;
}

/**
 * Step 4: retry bounds (07 §3.3 step 4). Options are exactly the Phase 2
 * absolute-bound enumerations — 1..MAX_ATTEMPTS_PER_REQUEST and
 * 0..MAX_TIER_SWITCHES — never free numeric input.
 */
export async function chooseRetry(
  ctx: ConfigDialogsContext,
  current: { maxAttemptsPerRequest: number; maxTierSwitches: number },
): Promise<DialogFlowOutcome<{ maxAttemptsPerRequest: number; maxTierSwitches: number }>> {
  if (ctx.isClosed()) return closed();
  const attempts = await ctx.ui.select(
    `retry — maxAttemptsPerRequest (current: ${current.maxAttemptsPerRequest})`,
    range(1, MAX_ATTEMPTS_PER_REQUEST),
    dialogOpts(ctx),
  );
  if (attempts === undefined) return cancelled();
  if (ctx.isClosed()) return closed();
  const switches = await ctx.ui.select(
    `retry — maxTierSwitches (current: ${current.maxTierSwitches})`,
    range(0, MAX_TIER_SWITCHES),
    dialogOpts(ctx),
  );
  if (switches === undefined) return cancelled();
  return {
    ok: true,
    value: { maxAttemptsPerRequest: Number(attempts), maxTierSwitches: Number(switches) },
  };
}

/** Step 6: the final commit confirmation — `false` means do not save. */
export async function confirmSave(
  ctx: ConfigDialogsContext,
  preview: string,
): Promise<DialogFlowOutcome<true>> {
  if (ctx.isClosed()) return closed();
  const yes = await ctx.ui.confirm("save this configuration?", preview, dialogOpts(ctx));
  return yes ? { ok: true, value: true } : cancelled();
}

// ---------------------------------------------------------------------------
// F7.2 `/ts config` dialogs (07-tui-modes.md §3.6, §5.4): the post-view menu
// and the partial-layer editor loop. Same primitives, same cancellation
// semantics as the wizard above; every draft mutation goes through the pure
// helpers in `../config/edit` so the loop body itself stays orchestration.
// ---------------------------------------------------------------------------

/** The §3.6 post-view menu: view, edit one layer, or cancel. */
export type ConfigMainMenuChoice =
  | { kind: "view" }
  | { kind: "edit"; scope: ConfigScope }
  | { kind: "cancel" };

/** Ask the §3.6 menu after the effective view has been rendered. */
export async function chooseConfigMainMenu(
  ctx: ConfigDialogsContext,
): Promise<DialogFlowOutcome<ConfigMainMenuChoice>> {
  if (ctx.isClosed()) return closed();
  const choice = await ctx.ui.select(
    "configuration: view or edit",
    ["view effective configuration", "edit project layer", "edit user layer", "cancel"],
    dialogOpts(ctx),
  );
  switch (choice) {
    case "view effective configuration":
      return { ok: true, value: { kind: "view" } };
    case "edit project layer":
      return { ok: true, value: { kind: "edit", scope: "project" } };
    case "edit user layer":
      return { ok: true, value: { kind: "edit", scope: "user" } };
    default:
      return cancelled();
  }
}

/** Editor-loop inputs; `current` is the pre-save effective baseline. */
export type ConfigEditorInput = {
  scope: ConfigScope;
  draft: ConfigFile;
  /** On-disk layer values as probed; the edited scope's own value is ignored. */
  layers: { user?: ConfigFile; project?: ConfigFile };
  current: EffectiveConfig;
};

/** Editor menu vocabulary (07 §3.6). */
const EDITOR_ACTIONS = {
  candidates: "candidates",
  policy: "policy",
  retry: "retry",
  preview: "preview",
  save: "save",
  cancel: "cancel",
} as const;

/** Tier-edit actions in the partial editor (§3.6 plus navigation). */
const TIER_PARTIAL_ACTIONS = {
  add: "add a candidate",
  remove: "remove a candidate",
  move: "move a candidate up or down",
  replace: "replace the ordered list",
  reset: "reset tier to inherit",
  back: "back",
} as const;

/** Policy/retry field menus (§3.6): set, reset-to-inherit, back. */
const POLICY_ACTIONS = {
  setBias: "set defaultBias",
  setSticky: "set sticky",
  resetBias: "reset defaultBias to inherit",
  resetSticky: "reset sticky to inherit",
  back: "back",
} as const;

const RETRY_ACTIONS = {
  setAttempts: "set maxAttemptsPerRequest",
  setSwitches: "set maxTierSwitches",
  resetAttempts: "reset maxAttemptsPerRequest to inherit",
  resetSwitches: "reset maxTierSwitches to inherit",
  back: "back",
} as const;

/** Bounded validation codes for the §3.9 "return to editor" outcome. */
async function showValidationProblems(
  ctx: ConfigDialogsContext,
  errors: readonly ConfigError[],
): Promise<void> {
  const codes = errors
    .slice(0, 5)
    .map((error) => `${error.code}@${error.path}`)
    .join(", ");
  await ctx.ui.select(
    `draft validation failed: ${codes}`,
    ["back to editor"],
    dialogOpts(ctx),
  );
}

/**
 * Build the replacement list from scratch (§3.6 "replace the ordered
 * list"): pairs of validated provider/id inputs until the user is done —
 * `done (empty list)` is a legitimate explicit-empty answer. Duplicates
 * within the new list are rejected at input; order is authored order.
 */
async function askCandidateList(
  ctx: ConfigDialogsContext,
  tier: TierName,
): Promise<DialogFlowOutcome<CandidateRef[]>> {
  const list: CandidateRef[] = [];
  for (;;) {
    if (ctx.isClosed()) return closed();
    const options: string[] = [];
    if (list.length < MAX_CANDIDATES_PER_TIER) options.push(TIER_PARTIAL_ACTIONS.add);
    options.push(list.length > 0 ? "done" : "done (empty list)");
    const choice = await ctx.ui.select(
      `tier ${tier} — replacement list: ${boundedIdentities(list)}`,
      options,
      dialogOpts(ctx),
    );
    if (choice === undefined) return cancelled();
    if (choice !== TIER_PARTIAL_ACTIONS.add) return { ok: true, value: list };
    const candidate = await askCandidatePair(ctx, tier, list);
    if (!candidate.ok) return candidate;
    list.push(candidate.value);
  }
}

/** One tier visit outcome: apply a list, reset to inheritance, or leave as-is. */
type TierEditOutcome =
  | { kind: "set"; candidates: CandidateRef[] }
  | { kind: "inherit" }
  | { kind: "back" };

/**
 * Edit one tier in the partial editor (§3.6): the draft list (or its
 * inherited absence) is shown against the lower layer's effective list;
 * `back` applies the working list only when the draft owned the key or a
 * mutation happened, so an untouched inherited tier stays inherited.
 */
async function editTierPartial(
  ctx: ConfigDialogsContext,
  tier: TierName,
  input: { draftList: CandidateRef[] | undefined; inheritedList: readonly CandidateRef[] },
): Promise<DialogFlowOutcome<TierEditOutcome>> {
  const owned = input.draftList !== undefined;
  const list: CandidateRef[] = (input.draftList ?? []).map(cloneCandidate);
  let dirty = false;
  for (;;) {
    if (ctx.isClosed()) return closed();
    const options: string[] = [];
    if (list.length < MAX_CANDIDATES_PER_TIER) options.push(TIER_PARTIAL_ACTIONS.add);
    if (list.length > 0) options.push(TIER_PARTIAL_ACTIONS.remove);
    if (list.length >= 2) options.push(TIER_PARTIAL_ACTIONS.move);
    options.push(TIER_PARTIAL_ACTIONS.replace);
    if (owned || dirty) options.push(TIER_PARTIAL_ACTIONS.reset);
    options.push(TIER_PARTIAL_ACTIONS.back);
    const draftState = owned || dirty ? `draft: ${boundedIdentities(list)}` : "draft: inherited";
    const choice = await ctx.ui.select(
      `tier ${tier} — ${draftState}; lower layer: ${boundedIdentities(input.inheritedList)}`,
      options,
      dialogOpts(ctx),
    );
    if (choice === undefined) return cancelled();
    if (choice === TIER_PARTIAL_ACTIONS.back) {
      if (!owned && !dirty) return { ok: true, value: { kind: "back" } };
      return { ok: true, value: { kind: "set", candidates: list } };
    }
    if (choice === TIER_PARTIAL_ACTIONS.reset) return { ok: true, value: { kind: "inherit" } };
    if (choice === TIER_PARTIAL_ACTIONS.replace) {
      const replacement = await askCandidateList(ctx, tier);
      if (!replacement.ok) return replacement;
      list.length = 0;
      list.push(...replacement.value);
      dirty = true;
      continue;
    }
    if (choice === TIER_PARTIAL_ACTIONS.add) {
      const candidate = await askCandidatePair(ctx, tier, list);
      if (!candidate.ok) return candidate;
      list.push(candidate.value);
      dirty = true;
      continue;
    }
    if (choice === TIER_PARTIAL_ACTIONS.remove) {
      const pick = await ctx.ui.select(
        `remove a candidate from ${tier}`,
        list.map(candidateIdentity),
        dialogOpts(ctx),
      );
      if (pick === undefined) return cancelled();
      const index = list.findIndex((c) => candidateIdentity(c) === pick);
      if (index >= 0) {
        list.splice(index, 1);
        dirty = true;
      }
      continue;
    }
    if (choice === TIER_PARTIAL_ACTIONS.move) {
      const pick = await ctx.ui.select(
        `move a candidate in ${tier}`,
        list.map(candidateIdentity),
        dialogOpts(ctx),
      );
      if (pick === undefined) return cancelled();
      const index = list.findIndex((c) => candidateIdentity(c) === pick);
      if (index < 0) continue;
      const directions: string[] = [];
      if (index > 0) directions.push("up");
      if (index < list.length - 1) directions.push("down");
      if (directions.length === 0) continue;
      const direction = await ctx.ui.select(`move ${pick} — direction`, directions, dialogOpts(ctx));
      if (direction === undefined) return cancelled();
      if (direction === "up" && index > 0) {
        [list[index - 1], list[index]] = [list[index], list[index - 1]];
        dirty = true;
      } else if (direction === "down" && index < list.length - 1) {
        [list[index + 1], list[index]] = [list[index], list[index + 1]];
        dirty = true;
      }
      continue;
    }
  }
}

/**
 * The partial-layer editor loop (07 §3.6/§5.4): candidates / policy /
 * retry / preview / save / cancel over a cloned draft. Preview and save
 * both validate through `validateConfigLayer` first — a failed draft shows
 * bounded codes and returns to the loop (§3.9); save commits only after
 * the final confirmation. Every cancellation edge collapses to the
 * command layer's uniform cancel notice; nothing is written here.
 */
export async function runConfigEditor(
  ctx: ConfigDialogsContext,
  input: ConfigEditorInput,
): Promise<DialogFlowOutcome<ConfigFile>> {
  const { scope, current } = input;
  // Effective values inherited from below the target scope: defaults plus
  // the user layer for a project target, defaults only for a user target —
  // composed through the Phase 2 merge via an empty draft (07 §3.6).
  const inherited = applyDraftToEffective(
    scope === "project" ? { user: input.layers.user } : {},
    { schemaVersion: 1 },
    scope,
  );
  let draft = structuredClone(input.draft);
  for (;;) {
    if (ctx.isClosed()) return closed();
    const choice = await ctx.ui.select(
      `edit ${scope} layer — candidates, policy, retry, preview, or save (escape cancels)`,
      [
        EDITOR_ACTIONS.candidates,
        EDITOR_ACTIONS.policy,
        EDITOR_ACTIONS.retry,
        EDITOR_ACTIONS.preview,
        EDITOR_ACTIONS.save,
        EDITOR_ACTIONS.cancel,
      ],
      dialogOpts(ctx),
    );
    if (choice === undefined || choice === EDITOR_ACTIONS.cancel) return cancelled();

    if (choice === EDITOR_ACTIONS.candidates) {
      const tier = await ctx.ui.select(
        "edit candidates — tier",
        [...TIER_ORDER, TIER_PARTIAL_ACTIONS.back],
        dialogOpts(ctx),
      );
      if (tier === undefined) return cancelled();
      if (tier !== TIER_PARTIAL_ACTIONS.back) {
        const tierName = tier as TierName;
        const step = await editTierPartial(ctx, tierName, {
          draftList: draft.tiers?.[tierName]?.candidates,
          inheritedList: inherited.tiers[tierName].candidates,
        });
        if (!step.ok) return step;
        if (step.value.kind === "set") draft = setTierCandidates(draft, tierName, step.value.candidates);
        else if (step.value.kind === "inherit") draft = resetTierToInherited(draft, tierName);
      }
      continue;
    }

    if (choice === EDITOR_ACTIONS.policy) {
      if (ctx.isClosed()) return closed();
      const field = await ctx.ui.select(
        `edit policy (lower layer: bias=${inherited.policy.defaultBias}, sticky=${inherited.policy.sticky})`,
        [
          POLICY_ACTIONS.setBias,
          POLICY_ACTIONS.setSticky,
          POLICY_ACTIONS.resetBias,
          POLICY_ACTIONS.resetSticky,
          POLICY_ACTIONS.back,
        ],
        dialogOpts(ctx),
      );
      if (field === undefined) return cancelled();
      if (field === POLICY_ACTIONS.back) continue;
      if (field === POLICY_ACTIONS.setBias) {
        const bias = await ctx.ui.select(
          `policy — defaultBias (lower layer: ${inherited.policy.defaultBias}; draft: ${draft.policy?.defaultBias ?? "inherited"})`,
          ["low", "medium", "high"],
          dialogOpts(ctx),
        );
        if (bias !== "low" && bias !== "medium" && bias !== "high") return cancelled();
        draft = setPolicyField(draft, "defaultBias", bias);
        continue;
      }
      if (field === POLICY_ACTIONS.setSticky) {
        if (ctx.isClosed()) return closed();
        const sticky = await ctx.ui.confirm(
          `policy — sticky (lower layer: ${inherited.policy.sticky}; draft: ${draft.policy?.sticky ?? "inherited"})`,
          "continue follow-up requests with the previously used model? (yes = sticky, no = not sticky)",
          dialogOpts(ctx),
        );
        draft = setPolicyField(draft, "sticky", sticky);
        continue;
      }
      if (field === POLICY_ACTIONS.resetBias) {
        draft = resetPolicyField(draft, "defaultBias");
        continue;
      }
      draft = resetPolicyField(draft, "sticky");
      continue;
    }

    if (choice === EDITOR_ACTIONS.retry) {
      if (ctx.isClosed()) return closed();
      const field = await ctx.ui.select(
        `edit retry (lower layer: attempts=${inherited.retry.maxAttemptsPerRequest}, tier-switches=${inherited.retry.maxTierSwitches})`,
        [
          RETRY_ACTIONS.setAttempts,
          RETRY_ACTIONS.setSwitches,
          RETRY_ACTIONS.resetAttempts,
          RETRY_ACTIONS.resetSwitches,
          RETRY_ACTIONS.back,
        ],
        dialogOpts(ctx),
      );
      if (field === undefined) return cancelled();
      if (field === RETRY_ACTIONS.back) continue;
      if (field === RETRY_ACTIONS.setAttempts || field === RETRY_ACTIONS.setSwitches) {
        const isAttempts = field === RETRY_ACTIONS.setAttempts;
        const value = await ctx.ui.select(
          isAttempts
            ? `retry — maxAttemptsPerRequest (lower layer: ${inherited.retry.maxAttemptsPerRequest}; draft: ${draft.retry?.maxAttemptsPerRequest ?? "inherited"})`
            : `retry — maxTierSwitches (lower layer: ${inherited.retry.maxTierSwitches}; draft: ${draft.retry?.maxTierSwitches ?? "inherited"})`,
          isAttempts ? range(1, MAX_ATTEMPTS_PER_REQUEST) : range(0, MAX_TIER_SWITCHES),
          dialogOpts(ctx),
        );
        if (value === undefined) return cancelled();
        draft = isAttempts
          ? setRetryField(draft, "maxAttemptsPerRequest", Number(value))
          : setRetryField(draft, "maxTierSwitches", Number(value));
        continue;
      }
      if (field === RETRY_ACTIONS.resetAttempts) {
        draft = resetRetryField(draft, "maxAttemptsPerRequest");
        continue;
      }
      draft = resetRetryField(draft, "maxTierSwitches");
      continue;
    }

    if (choice === EDITOR_ACTIONS.preview) {
      const checked = validateConfigLayer(draft, scope);
      if (!checked.ok) {
        await showValidationProblems(ctx, checked.errors);
        continue;
      }
      const dismiss = await ctx.ui.confirm(
        "configuration preview (answering returns to the editor)",
        renderConfigPreview(current, scope, draft),
        dialogOpts(ctx),
      );
      if (dismiss === undefined) return cancelled();
      continue;
    }

    // EDITOR_ACTIONS.save — validate again immediately before persistence
    // (07 §4.5), then commit only on the explicit confirmation.
    const checked = validateConfigLayer(draft, scope);
    if (!checked.ok) {
      await showValidationProblems(ctx, checked.errors);
      continue;
    }
    const commit = await confirmSave(ctx, renderConfigPreview(current, scope, draft));
    if (!commit.ok) return commit;
    return { ok: true, value: draft };
  }
}
