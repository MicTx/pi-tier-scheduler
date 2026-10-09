import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { defaultConfig } from "../config/defaults";
import { createEditDraft } from "../config/edit";
import { validateConfigLayer } from "../config/schema";
import type { ConfigFile, LoadResult } from "../config/types";
import type { ConfigScope, EditableConfigLayer } from "../config/layer-read";
import { buildConfigView, renderConfigView } from "../ui/config-render";
import { buildCatalogPickList } from "../catalog/picker";
import type { CatalogPickOption } from "../catalog/picker";
import { chooseConfigMainMenu, runConfigEditor } from "../ui/config-dialogs";
import type { ConfigDialogsContext } from "../ui/config-dialogs";
import type { RespondContext, RespondSeverity } from "../ui/respond";
import {
  CONFIG_CANCELLED_NOTICE,
  CONFIG_DEGRADED_NOTICE,
  CONFIG_FLOW_ACTIVE_NOTICE,
  CONFIG_RELOAD_PENDING_NOTICE,
  CONFIG_SAVE_FAILED_NOTICE,
  type ConfigCommandDependencies,
} from "./init";
/**
 * `/ts config` — effective view and partial-layer editor
 * (07-tui-modes.md §3.1 step 4, §3.5–§3.7, §5.4; F7.2 spec §2.2).
 *
 * `handleConfig` is the command face: zero-argument validation → the
 * effective view in every mode (pure renderer over the runtime load plus
 * the branch manual override) → TUI-only menu (view / edit project / edit
 * user / cancel) → the partial-layer editor for a missing or valid target
 * (invalid/unreadable targets are pointed at `/ts init`, never silently
 * overwritten) → the same serialized save+reload tail as `/ts init`. No
 * write happens before the editor's final confirmation; the save path
 * calls only the declared Phase 2 seams and never touches a provider,
 * model action, or branch append.
 */

/** Stable response texts (07 §3.1/§3.9; fixed wording, no paths or raw errors). */
export const CONFIG_USAGE_ERROR = "invalid arguments for 'config'; usage: /ts config";
export const CONFIG_NON_TUI_EDIT_NOTICE = "editing requires TUI mode; no changes made";
export const CONFIG_SHUTDOWN_NOTICE = "tier-scheduler is shutting down";
export const CONFIG_NOT_LOADED_VIEW =
  "pi-tier-scheduler configuration\neffective: not loaded (built-in defaults in effect)";

/** Invalid/unreadable targets are replaced only by `/ts init`, never here (§3.6). */
export function invalidTargetNotice(
  scope: ConfigScope,
  status: "invalid" | "unreadable",
): string {
  return `the ${scope} layer is ${status}; use /ts init to replace it deliberately (no changes made here)`;
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

/** The on-disk layer value only when the probe read it as valid. */
function validLayerValue(layer: EditableConfigLayer): ConfigFile | undefined {
  return layer.status === "valid" ? layer.value : undefined;
}

/**
 * The interactive body: menu → target probe → editor → save chain. Runs
 * entirely on the dialog outcome type; every `!ok` step ends with the
 * uniform cancel response. The flow mutex is held by the caller.
 */
async function runConfigFlow(
  ctx: ExtensionCommandContext,
  deps: ConfigCommandDependencies,
  viewText: string,
): Promise<void> {
  const dialogs = dialogContextOf(ctx, deps);

  const menu = await chooseConfigMainMenu(dialogs);
  if (!menu.ok) {
    cancelWith(ctx, deps, menu.reason);
    return;
  }
  if (menu.value.kind === "cancel") {
    deps.respond(ctx, CONFIG_CANCELLED_NOTICE, "info");
    return;
  }
  if (menu.value.kind === "view") {
    deps.respond(ctx, viewText, "info");
    return;
  }
  const scope: ConfigScope = menu.value.scope;

  // Probe both layers once: the target becomes the draft, the other layer
  // feeds the preview/inheritance composition. A target that is invalid or
  // unreadable is never edited here (07 §3.6) — it is pointed at /ts init.
  const otherScope: ConfigScope = scope === "project" ? "user" : "project";
  const [target, other] = await Promise.all([
    deps.readConfigLayerForEdit({ scope, cwd: ctx.cwd }),
    deps.readConfigLayerForEdit({ scope: otherScope, cwd: ctx.cwd }),
  ]);
  if (deps.isRuntimeClosed()) {
    cancelWith(ctx, deps, "closed");
    return;
  }
  if (target.status === "invalid" || target.status === "unreadable") {
    deps.respond(ctx, invalidTargetNotice(scope, target.status), "warning");
    return;
  }

  const editor = await runConfigEditor(dialogs, {
    scope,
    draft: createEditDraft(target),
    layers: {
      user: scope === "user" ? undefined : validLayerValue(other),
      project: scope === "project" ? undefined : validLayerValue(other),
    },
    current: effectiveBaseline(deps),
  });
  if (!editor.ok) {
    cancelWith(ctx, deps, editor.reason);
    return;
  }
  const draft = editor.value;

  // Authoritative validation immediately before persistence (07 §4.5); the
  // editor's own bounds make this unreachable in practice — fail closed.
  const checked = validateConfigLayer(draft, scope);
  if (!checked.ok) {
    deps.respond(ctx, CONFIG_SAVE_FAILED_NOTICE, "error");
    return;
  }

  // The serialized save+reload tail — identical seam to `/ts init` (F7.1):
  // confirm → atomic write with backup → reload → atomic swap. The editor's
  // final confirmation above is the first and only call site of
  // `saveConfigFile` on this path (07 §7.2 hook 6).
  try {
    const outcome = await deps.enqueueConfigSave(async () => {
      if (deps.isRuntimeClosed()) return { kind: "cancelled" } as const;
      await deps.saveConfigFile(target.targetPath, draft, { backupExisting: true });
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
        deps.setReloadPending(true);
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
 * The `/ts config` command face. Guard order mirrors `/ts init`: zero
 * arguments → runtime-closed → flow-active mutex → the effective view in
 * every mode → TUI menu / non-TUI editing guidance. The mutex covers the
 * whole interactive flow and is cleared in the finally block.
 */
export async function handleConfig(
  args: string,
  ctx: ExtensionCommandContext,
  deps: ConfigCommandDependencies,
): Promise<void> {
  if (args.trim() !== "") {
    deps.respond(ctx, CONFIG_USAGE_ERROR, "warning");
    return;
  }
  if (deps.isRuntimeClosed()) {
    deps.respond(ctx, CONFIG_SHUTDOWN_NOTICE, "info");
    return;
  }
  if (deps.isFlowActive()) {
    deps.respond(ctx, CONFIG_FLOW_ACTIVE_NOTICE, "warning");
    return;
  }

  const load = deps.getConfig();
  const override = deps.getManualOverride(ctx);
  const viewText =
    load === undefined
      ? CONFIG_NOT_LOADED_VIEW
      : renderConfigView(buildConfigView(load, override));

  if (ctx.mode !== "tui") {
    // Read-only view everywhere; editing is TUI-only (07 §3.1 step 4).
    deps.respond(ctx, `${viewText}\n${CONFIG_NON_TUI_EDIT_NOTICE}`, "info");
    return;
  }

  // TUI: render the view, then offer the menu over it (07 §3.1 step 4,
  // §5.4). The mutex covers view-render through the interactive flow and
  // is cleared in the finally block.
  deps.respond(ctx, viewText, "info");
  deps.setFlowActive(true);
  try {
    await runConfigFlow(ctx, deps, viewText);
  } finally {
    deps.setFlowActive(false);
  }
}
