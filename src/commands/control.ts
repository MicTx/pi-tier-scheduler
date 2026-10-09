import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { defaultConfig } from "../config/defaults";
import type { LoadResult, ThinkingBias } from "../config/types";
import { readLatestRouterControl } from "../routing";
import { ROUTER_CONTROL_ENTRY, type RouterControlEntry } from "../routing/types";
import { TS_VIRTUAL_MODEL_ID, TS_VIRTUAL_PROVIDER } from "../routing/virtual-model";
import type { RespondSeverity } from "../ui/respond";
import type { StatusDependencies } from "./status";
import type { ManualTier } from "./types";

/**
 * Manual tier control core (05-commands.md §3.5–§3.7, §4.4, F5.2).
 *
 * `applyManualTier`/`applyAutomatic` are the pure mutation bodies: given a
 * structural context and the Pi session actions, they select the already
 * registered `ts/auto` virtual model, set the tier bias as the session
 * thinking level, and append the Phase 4 branch control entry with
 * idempotent latest-valid-entry semantics. `setManualTier`/
 * `releaseManualTier` wrap them through `enqueueControlMutation` so control
 * mutations serialize in arrival order.
 *
 * The command never resolves physical candidates, probes provider auth, or
 * writes configuration files: an empty tier is a legal manual preference,
 * and Phase 4 reports the fallback at the next route. Control truth lives
 * only in branch entries — no module-global override exists.
 */

/** Stable failure vocabulary; messages are fixed and never carry raw error text. */
export type TsControlErrorCode =
  | "virtual_model_missing"
  | "set_model_rejected"
  | "set_model_failed"
  | "append_control_failed";

/** Result of one control mutation (05-commands.md §4.1). */
export type TsCommandResult =
  | { ok: true; message: string; controlChanged: boolean }
  | { ok: false; code: TsControlErrorCode; message: string };

/** Fixed tier → thinking-bias mapping (05-commands.md §4.4). */
export const TIER_BIAS: Readonly<Record<ManualTier, ThinkingBias>> = {
  brain: "high",
  pillar: "medium",
  crowd: "low",
};

/** Structural context the control core reads; fakes cover exactly these fields. */
export type ControlContext = Pick<
  ExtensionCommandContext,
  "model" | "sessionManager" | "modelRegistry"
>;

/** Pi session actions the core drives; extension wiring composes these from deps. */
export type PiControlActions = Pick<
  ExtensionAPI,
  "setModel" | "setThinkingLevel" | "appendEntry"
>;

/** Actions the pure core receives: the Pi pick plus the thinking-level read. */
export type ControlActions = PiControlActions & {
  getThinkingLevel(): ThinkingLevel;
};

/**
 * Narrow runtime dependencies for the control commands: F5.1's status
 * dependencies extended with the Pi action pick and the serialized control
 * queue (05-commands.md §4.3, adapted per spec §2.2). `getThinkingLevel` is
 * narrowed from `string` to the SDK session-level vocabulary (pi-agent-core:
 * `"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`) because
 * the append-failure restore feeds the captured value back into
 * `setThinkingLevel`; the runtime value is unchanged (the extension supplies
 * `pi.getThinkingLevel()`).
 */
export interface TsControlDependencies extends StatusDependencies {
  getThinkingLevel(): ThinkingLevel;
  pi: PiControlActions;
  enqueueControlMutation<T>(operation: () => Promise<T>): Promise<T>;
}

/**
 * Find the registered `ts/auto` virtual model (synchronous per the Pi 1.0.4
 * registry contract). The provider/id re-check guards against a same-id
 * physical entry ever appearing under the namespace.
 */
export function ensureVirtualModel(
  ctx: Pick<ExtensionCommandContext, "modelRegistry">,
): { ok: true; model: Model<Api> } | { ok: false; code: "virtual_model_missing" } {
  const model = ctx.modelRegistry.find(TS_VIRTUAL_PROVIDER, TS_VIRTUAL_MODEL_ID);
  if (
    model === undefined ||
    model.provider !== TS_VIRTUAL_PROVIDER ||
    model.id !== TS_VIRTUAL_MODEL_ID
  ) {
    return { ok: false, code: "virtual_model_missing" };
  }
  return { ok: true, model };
}

/** Bias for `/ts auto`: the validated effective load, else built-in defaults. */
export function resolveDefaultBias(config: LoadResult | undefined): ThinkingBias {
  return config?.effective.policy.defaultBias ?? defaultConfig().policy.defaultBias;
}

/** Stable, redacted failure messages; fixed text, no paths or raw errors. */
const MESSAGES = {
  virtualModelMissing:
    "ts/auto is not available in this session; control was not changed",
  setModelRejected:
    "ts/auto could not be selected (provider authentication is not configured); control was not changed",
  setModelFailed:
    "ts/auto could not be selected (session action failed); control was not changed",
  appendControlFailed:
    "control could not be saved to the session; the previous selection was restored on a best-effort basis",
} as const;

/** Branch read is fail-soft: a broken session manager reads as no control. */
function branchEntriesOf(
  ctx: Pick<ExtensionCommandContext, "sessionManager">,
): SessionEntry[] {
  try {
    return ctx.sessionManager.getBranch();
  } catch {
    return [];
  }
}

/**
 * Best-effort snapshot restore after an append failure (§3.7): the reported
 * failure stays the original append error; a restore failure never replaces
 * it. The model restores first so the thinking restore clamps against it.
 */
async function bestEffortRestore(
  actions: ControlActions,
  previousModel: Model<Api> | undefined,
  previousThinking: ThinkingLevel,
): Promise<void> {
  if (previousModel !== undefined) {
    try {
      await actions.setModel(previousModel);
    } catch {
      // Best-effort only.
    }
  }
  try {
    actions.setThinkingLevel(previousThinking);
  } catch {
    // Best-effort only.
  }
}

/**
 * `/ts use <tier>` mutation body (05-commands.md §3.5), tier pre-validated by
 * the parser. Sequence: find `ts/auto` → `setModel` (false/throw keeps every
 * prior value: no thinking change, no append) → `setThinkingLevel(TIER_BIAS)`
 * → append the control entry unless the latest valid branch control already
 * equals the tier. An empty-candidate tier stays a legal preference.
 */
export async function applyManualTier(
  tier: ManualTier,
  ctx: ControlContext,
  actions: ControlActions,
): Promise<TsCommandResult> {
  const previousModel = ctx.model;
  const previousThinking = actions.getThinkingLevel();

  const found = ensureVirtualModel(ctx);
  if (!found.ok) {
    return { ok: false, code: "virtual_model_missing", message: MESSAGES.virtualModelMissing };
  }

  let accepted: boolean;
  try {
    accepted = await actions.setModel(found.model);
  } catch {
    return { ok: false, code: "set_model_failed", message: MESSAGES.setModelFailed };
  }
  if (!accepted) {
    return { ok: false, code: "set_model_rejected", message: MESSAGES.setModelRejected };
  }

  actions.setThinkingLevel(TIER_BIAS[tier]);

  const latest = readLatestRouterControl(branchEntriesOf(ctx));
  const controlChanged = latest.manualOverride !== tier;
  if (controlChanged) {
    try {
      actions.appendEntry(
        ROUTER_CONTROL_ENTRY,
        { schemaVersion: 1, manualOverride: tier } satisfies RouterControlEntry,
      );
    } catch {
      await bestEffortRestore(actions, previousModel, previousThinking);
      return { ok: false, code: "append_control_failed", message: MESSAGES.appendControlFailed };
    }
  }

  return {
    ok: true,
    message: `manual routing set to ${tier} (ts/auto thinking=${TIER_BIAS[tier]})`,
    controlChanged,
  };
}

/**
 * `/ts auto` mutation body (05-commands.md §3.6): release manual control with
 * `manualOverride: null`. The thinking level restores to the validated
 * effective `policy.defaultBias` (built-in defaults when no load is ready —
 * degraded config never blocks the release). The null entry is appended only
 * when the latest control is non-null or invalid, so a deliberate release
 * becomes visible on the branch while an already-automatic branch gains no
 * duplicate entry.
 */
export async function applyAutomatic(
  ctx: ControlContext,
  actions: ControlActions,
  bias: ThinkingBias,
): Promise<TsCommandResult> {
  const previousModel = ctx.model;
  const previousThinking = actions.getThinkingLevel();

  const found = ensureVirtualModel(ctx);
  if (!found.ok) {
    return { ok: false, code: "virtual_model_missing", message: MESSAGES.virtualModelMissing };
  }

  let accepted: boolean;
  try {
    accepted = await actions.setModel(found.model);
  } catch {
    return { ok: false, code: "set_model_failed", message: MESSAGES.setModelFailed };
  }
  if (!accepted) {
    return { ok: false, code: "set_model_rejected", message: MESSAGES.setModelRejected };
  }

  actions.setThinkingLevel(bias);

  const latest = readLatestRouterControl(branchEntriesOf(ctx));
  const controlChanged = latest.manualOverride !== null || latest.recovered;
  if (controlChanged) {
    try {
      actions.appendEntry(
        ROUTER_CONTROL_ENTRY,
        { schemaVersion: 1, manualOverride: null } satisfies RouterControlEntry,
      );
    } catch {
      await bestEffortRestore(actions, previousModel, previousThinking);
      return { ok: false, code: "append_control_failed", message: MESSAGES.appendControlFailed };
    }
  }

  return {
    ok: true,
    message: `automatic routing enabled (bias=${bias})`,
    controlChanged,
  };
}

/** Compose the core actions from the runtime dependencies. */
function controlActionsOf(deps: TsControlDependencies): ControlActions {
  return {
    setModel: (model) => deps.pi.setModel(model),
    setThinkingLevel: (level) => deps.pi.setThinkingLevel(level),
    appendEntry: (type, data) => deps.pi.appendEntry(type, data),
    getThinkingLevel: () => deps.getThinkingLevel(),
  };
}

/** `/ts use <tier>` entry point: one serialized control mutation. */
export async function setManualTier(
  tier: ManualTier,
  ctx: ControlContext,
  deps: TsControlDependencies,
): Promise<TsCommandResult> {
  return deps.enqueueControlMutation(() => applyManualTier(tier, ctx, controlActionsOf(deps)));
}

/** `/ts auto` entry point: one serialized control mutation. */
export async function releaseManualTier(
  ctx: ControlContext,
  deps: TsControlDependencies,
): Promise<TsCommandResult> {
  return deps.enqueueControlMutation(() =>
    applyAutomatic(ctx, controlActionsOf(deps), resolveDefaultBias(deps.getConfig())),
  );
}

/** Response severity: success is info, an unauthenticated selection is a warning, the rest are errors. */
export function severityForTsResult(result: TsCommandResult): RespondSeverity {
  if (result.ok) return "info";
  if (result.code === "set_model_rejected") return "warning";
  return "error";
}
