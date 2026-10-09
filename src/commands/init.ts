import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { defaultConfig } from "../config/defaults";
import { createInitDraft, setPolicyField, setRetryField, setTierCandidates, TIER_ORDER } from "../config/edit";
import type { ResolveConfigPathsInput } from "../config/discover";
import { validateConfigLayer } from "../config/schema";
import type {
  ConfigFile,
  LoadResult,
} from "../config/types";
import type { ConfigLayerReadInput, ConfigScope, EditableConfigLayer } from "../config/layer-read";
import { renderConfigPreview } from "../ui/config-render";
import { buildCatalogPickList } from "../catalog/picker";
import type { CatalogPickOption } from "../catalog/picker";
import {
  choosePolicy,
  chooseRetry,
  chooseScope,
  confirmEditExistingLayer,
  confirmReplaceInvalidLayer,
  confirmSave,
  editTierCandidates,
} from "../ui/config-dialogs";
import type { ConfigDialogsContext } from "../ui/config-dialogs";
import type { RespondContext, RespondSeverity } from "../ui/respond";
import type { StatusConfigInput } from "./status";
import type { ManualTier } from "./types";

/**
 * `/ts init` — TUI guided setup (07-tui-modes.md §3.1–§3.4, §5.1–§5.3,
 * §3.7/§3.9; F7.1 spec §2.2).
 *
 * `handleInit` is the only command face: zero-argument validation → TUI
 * guard → flow-active guard → the finite wizard (scope, layer probe, three
 * tier edits, policy, retry, preview, commit) → the serialized save+reload
 * tail. Nothing is written before the final confirmation; every
 * cancellation edge collapses to the stable cancel notice; the commit path
 * calls only the declared Phase 2 seams and never touches a provider,
 * model action, or branch append.
 */

/** Stable response texts (07 §3.9; fixed wording, no paths or raw errors). */
export const INIT_USAGE_ERROR = "invalid arguments for 'init'; usage: /ts init";
export const INIT_NON_TUI_NOTICE = "interactive configuration requires TUI mode; no changes made";
export const CONFIG_FLOW_ACTIVE_NOTICE = "configuration flow already active";
export const CONFIG_CANCELLED_NOTICE = "configuration cancelled; no changes made";
export const CONFIG_SAVE_FAILED_NOTICE = "configuration save failed; no changes made";
export const CONFIG_RELOAD_PENDING_NOTICE =
  "configuration saved; reload pending; restart or reload Pi to apply";
export const CONFIG_DEGRADED_NOTICE = "configuration saved; effective config degraded";

/**
 * Narrow dependencies for the configuration commands (F7.1 spec §2.4):
 * the status snapshot read (the effective baseline for preview contrasts),
 * the Phase 2 seams (read-only layer probe, loader, writer), the response
 * channel, and the runtime accessors (flow-active guard, config revision,
 * atomic load swap, the serialized save tail). No raw fs module, no
 * credential resolver, no provider client, no extension import.
 */
export interface ConfigCommandDependencies {
  getConfig(): StatusConfigInput | undefined;
  respond(ctx: RespondContext, message: string, severity?: RespondSeverity): void;
  readConfigLayerForEdit(input: ConfigLayerReadInput): Promise<EditableConfigLayer>;
  loadConfig(input: ResolveConfigPathsInput): Promise<LoadResult>;
  saveConfigFile(
    targetPath: string,
    layer: ConfigFile,
    options?: { backupExisting?: boolean },
  ): Promise<void>;
  isRuntimeClosed(): boolean;
  isFlowActive(): boolean;
  setFlowActive(active: boolean): void;
  getConfigRevision(): number;
  applyConfigReload(load: LoadResult): { applied: boolean; revision: number };
  enqueueConfigSave<T>(operation: () => Promise<T>): Promise<T>;
  /**
   * F7.2 additions (07 §6.2; spec §2.4): the branch manual-override read
   * behind the view's session-override line, the footer refresh hook the
   * dispatcher calls after successful control mutations and config reloads
   * (a no-op outside a live TUI), and the reload-pending accessor a
   * failed post-save reload sets for `/ts status`/`/ts doctor` consumers.
   */
  getManualOverride(ctx: Pick<ExtensionCommandContext, "sessionManager">): ManualTier | null;
  refreshFooter(
    ctx: Pick<ExtensionCommandContext, "mode" | "ui" | "sessionManager">,
  ): void;
  setReloadPending(pending: boolean): void;
}

/** Current effective baseline for preview contrasts (07 §6.2 seam). */
function effectiveBaseline(deps: ConfigCommandDependencies): LoadResult["effective"] {
  return (
    deps.getConfig()?.effective ?? {
      ...defaultConfig(),
      provenance: {},
    }
  );
}

/** Catalog pick options from the live registry; absent on any failure (spec §2.2). */
function catalogOf(ctx: ExtensionCommandContext): { catalog?: readonly CatalogPickOption[] } {
  try {
    const catalog = buildCatalogPickList(ctx.modelRegistry);
    return catalog.length > 0 ? { catalog } : {};
  } catch {
    return {};
  }
}

function dialogContextOf(
  ctx: ExtensionCommandContext,
  deps: ConfigCommandDependencies,
): ConfigDialogsContext {
  return {
    ui: ctx.ui,
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    isClosed: () => deps.isRuntimeClosed(),
    ...catalogOf(ctx),
  };
}

/** Map one cancellation reason to the stable response. */
function cancelWith(
  ctx: ExtensionCommandContext,
  deps: ConfigCommandDependencies,
  reason: "cancelled" | "exhausted" | "closed",
): void {
  deps.respond(ctx, CONFIG_CANCELLED_NOTICE, reason === "exhausted" ? "warning" : "info");
}

/**
 * The wizard body. Runs entirely on the dialog outcome type; every `!ok`
 * step ends with the uniform cancel response, and the runtime-closed
 * observation is checked after each draft-changing step and immediately
 * before the save (F7.1 spec §7).
 */
async function runInitWizard(
  ctx: ExtensionCommandContext,
  deps: ConfigCommandDependencies,
): Promise<void> {
  const dialogs = dialogContextOf(ctx, deps);

  // Step 1 — scope (07 §3.2).
  const scopeStep = await chooseScope(dialogs);
  if (!scopeStep.ok) {
    cancelWith(ctx, deps, scopeStep.reason);
    return;
  }
  const scope: ConfigScope = scopeStep.value;

  // Step 2 — read-only probe of the target layer through the Phase 2 seam.
  const layer = await deps.readConfigLayerForEdit({ scope, cwd: ctx.cwd });
  if (deps.isRuntimeClosed()) {
    cancelWith(ctx, deps, "closed");
    return;
  }

  // Step 3 — draft base: clone a valid target, replace an invalid one only
  // after an explicit confirmation, start from defaults when missing.
  let draft: ConfigFile;
  if (layer.status === "valid") {
    const editStep = await confirmEditExistingLayer(dialogs, layer);
    if (!editStep.ok) {
      cancelWith(ctx, deps, editStep.reason);
      return;
    }
    draft = structuredClone(layer.value);
  } else if (layer.status === "missing") {
    draft = createInitDraft(defaultConfig());
  } else {
    const replaceStep = await confirmReplaceInvalidLayer(dialogs, layer);
    if (!replaceStep.ok) {
      cancelWith(ctx, deps, replaceStep.reason);
      return;
    }
    draft = createInitDraft(defaultConfig());
  }

  // Step 4 — tier candidates in the fixed brain → pillar → crowd order.
  for (const tier of TIER_ORDER) {
    const tierStep = await editTierCandidates(
      dialogs,
      tier,
      draft.tiers?.[tier]?.candidates ?? [],
    );
    if (!tierStep.ok) {
      cancelWith(ctx, deps, tierStep.reason);
      return;
    }
    draft = setTierCandidates(draft, tier, tierStep.value);
    if (deps.isRuntimeClosed()) {
      cancelWith(ctx, deps, "closed");
      return;
    }
  }

  // Step 5 — policy (07 §3.3 step 3).
  const policyStep = await choosePolicy(dialogs, {
    defaultBias: draft.policy?.defaultBias ?? defaultConfig().policy.defaultBias,
    sticky: draft.policy?.sticky ?? defaultConfig().policy.sticky,
  });
  if (!policyStep.ok) {
    cancelWith(ctx, deps, policyStep.reason);
    return;
  }
  draft = setPolicyField(setPolicyField(draft, "defaultBias", policyStep.value.defaultBias), "sticky", policyStep.value.sticky);
  if (deps.isRuntimeClosed()) {
    cancelWith(ctx, deps, "closed");
    return;
  }

  // Step 6 — retry bounds from the Phase 2 absolute enumerations.
  const retryStep = await chooseRetry(dialogs, {
    maxAttemptsPerRequest: draft.retry?.maxAttemptsPerRequest ?? defaultConfig().retry.maxAttemptsPerRequest,
    maxTierSwitches: draft.retry?.maxTierSwitches ?? defaultConfig().retry.maxTierSwitches,
  });
  if (!retryStep.ok) {
    cancelWith(ctx, deps, retryStep.reason);
    return;
  }
  draft = setRetryField(
    setRetryField(draft, "maxAttemptsPerRequest", retryStep.value.maxAttemptsPerRequest),
    "maxTierSwitches",
    retryStep.value.maxTierSwitches,
  );

  // Authoritative validation before the preview (07 §4.5); the wizard's own
  // input bounds make this unreachable in practice — fail closed anyway.
  const validated = validateConfigLayer(draft, "user");
  if (!validated.ok) {
    deps.respond(ctx, CONFIG_SAVE_FAILED_NOTICE, "error");
    return;
  }

  // Step 7/8 — preview (pure renderer, scope label only) + final commit.
  const preview = renderConfigPreview(effectiveBaseline(deps), scope, draft);
  const commitStep = await confirmSave(dialogs, preview);
  if (!commitStep.ok) {
    cancelWith(ctx, deps, commitStep.reason);
    return;
  }

  // Step 9 — serialized save + reload behind the per-runtime tail. The
  // final confirmation above is the first and only call site of
  // `saveConfigFile` (07 §7.1 hook 6).
  try {
    const outcome = await deps.enqueueConfigSave(async () => {
      if (deps.isRuntimeClosed()) return { kind: "cancelled" } as const;
      await deps.saveConfigFile(layer.targetPath, draft, { backupExisting: true });
      let load: LoadResult;
      try {
        load = await deps.loadConfig({ cwd: ctx.cwd });
      } catch {
        // Unexpected reload failure: the old runtime snapshot stays active.
        return { kind: "reload_pending" } as const;
      }
      const swap = deps.applyConfigReload(load);
      if (!swap.applied) return { kind: "reload_pending" } as const;
      return {
        kind: "saved" as const,
        degraded: load.problems.length > 0,
        revision: swap.revision,
      };
    });
    switch (outcome.kind) {
      case "cancelled":
        cancelWith(ctx, deps, "closed");
        return;
      case "reload_pending":
        deps.respond(ctx, CONFIG_RELOAD_PENDING_NOTICE, "warning");
        return;
      case "saved":
        deps.respond(
          ctx,
          outcome.degraded
            ? CONFIG_DEGRADED_NOTICE
            : `configuration saved; effective config reloaded (scope: ${scope}, revision: ${outcome.revision})`,
          outcome.degraded ? "warning" : "info",
        );
        return;
    }
  } catch {
    deps.respond(ctx, CONFIG_SAVE_FAILED_NOTICE, "error");
  }
}

/**
 * The `/ts init` command face. Guard order per 07 §3.1: zero arguments →
 * TUI mode → flow-active mutex → wizard. The mutex is set for the whole
 * flow and cleared in the finally block; a second init/config arriving
 * meanwhile is rejected by the dispatcher or here without opening a dialog.
 */
export async function handleInit(
  args: string,
  ctx: ExtensionCommandContext,
  deps: ConfigCommandDependencies,
): Promise<void> {
  if (args.trim() !== "") {
    deps.respond(ctx, INIT_USAGE_ERROR, "warning");
    return;
  }
  if (ctx.mode !== "tui") {
    deps.respond(ctx, INIT_NON_TUI_NOTICE, "info");
    return;
  }
  if (deps.isRuntimeClosed()) {
    deps.respond(ctx, "tier-scheduler is shutting down", "info");
    return;
  }
  if (deps.isFlowActive()) {
    deps.respond(ctx, CONFIG_FLOW_ACTIVE_NOTICE, "warning");
    return;
  }
  deps.setFlowActive(true);
  try {
    await runInitWizard(ctx, deps);
  } finally {
    deps.setFlowActive(false);
  }
}
