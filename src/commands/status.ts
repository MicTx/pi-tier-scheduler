import type {
  ExtensionCommandContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import type { LayerStatus, LoadResult } from "../config/types";
import { readLatestRouterControl } from "../routing";
import { TS_VIRTUAL_MODEL_ID, TS_VIRTUAL_PROVIDER } from "../routing/virtual-model";
import { respond } from "../ui/respond";
import type {
  ConfigSummary,
  LastDispatchSummary,
  TsStatus,
} from "./types";

/**
 * Read-only status surface (05-commands.md §3.2–§3.4, §6.2).
 *
 * `buildTsStatus` snapshots current selection, branch control, the runtime
 * config load, and the last dispatch summary. `renderTsStatus` is a pure
 * renderer with stable labels and no ANSI sequences. Neither touches files,
 * the model registry, or any session mutation — status is the one /ts
 * branch with no side effects by construction.
 */

/**
 * The config shape status consumes: Phase 2's `LoadResult` plus the
 * additive per-layer `layers` field (spec §2.2, seam note). Declaring the
 * expectation locally keeps this module compiling before the config-side
 * additive edit lands in the same round; `LoadResult` satisfies it
 * directly once the field exists.
 */
export type StatusConfigInput = LoadResult & {
  layers: { user: LayerStatus; project: LayerStatus };
};

/** Inputs the runtime supplies; everything else is read from `ctx`. */
export type TsStatusInputs = {
  thinkingLevel: string | undefined;
  config: StatusConfigInput | undefined;
  lastDispatch: LastDispatchSummary | undefined;
};

/** Narrow runtime dependencies for the status command (05-commands.md §4.3). */
export type StatusDependencies = {
  getThinkingLevel(): string;
  getConfig(): StatusConfigInput | undefined;
  getLastDispatch(): LastDispatchSummary | undefined;
};

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

function summarizeConfig(config: StatusConfigInput): ConfigSummary {
  return {
    health: config.problems.length > 0 ? "degraded" : "valid",
    user: config.layers.user,
    project: config.layers.project,
    candidateCounts: {
      brain: config.effective.tiers.brain.candidates.length,
      pillar: config.effective.tiers.pillar.candidates.length,
      crowd: config.effective.tiers.crowd.candidates.length,
    },
    defaultBias: config.effective.policy.defaultBias,
    sticky: config.effective.policy.sticky,
    maxAttemptsPerRequest: config.effective.retry.maxAttemptsPerRequest,
    maxTierSwitches: config.effective.retry.maxTierSwitches,
  };
}

/**
 * Build the read-only status snapshot. The current model is copied as
 * provider/id only — no model object, no credential-bearing surface ever
 * enters the snapshot. A virtual selection is `ts/auto`; anything else is
 * physical (routing inactive). Branch control is read live from
 * `ctx.sessionManager.getBranch()`; the branch is the single authority for
 * manual control, so the runtime keeps no mirror of it.
 */
export function buildTsStatus(
  ctx: Pick<ExtensionCommandContext, "model" | "sessionManager">,
  inputs: TsStatusInputs,
): TsStatus {
  const selection =
    ctx.model === undefined
      ? undefined
      : { provider: ctx.model.provider, id: ctx.model.id };
  const isTsAuto =
    selection !== undefined &&
    selection.provider === TS_VIRTUAL_PROVIDER &&
    selection.id === TS_VIRTUAL_MODEL_ID;
  const control = readLatestRouterControl(branchEntriesOf(ctx));
  const routing: TsStatus["routing"] = !isTsAuto
    ? "inactive"
    : control.manualOverride !== null
      ? "manual"
      : "automatic";
  return {
    selection,
    thinkingLevel: inputs.thinkingLevel,
    routing,
    manualOverride: control.manualOverride,
    lastDispatch: inputs.lastDispatch,
    config: inputs.config === undefined ? undefined : summarizeConfig(inputs.config),
    controlRecovered: control.recovered,
  };
}

/** Renders one `x=y` pair, or `unavailable` when the value is missing. */
function slot(value: string | undefined): string {
  return value === undefined ? "unavailable" : value;
}

function renderSelection(status: TsStatus): string {
  if (status.selection === undefined) return "selection: not selected";
  return `selection: ${status.selection.provider}/${status.selection.id}`;
}

function renderDispatch(status: TsStatus): string[] {
  if (status.lastDispatch === undefined) {
    return [
      "last dispatch: not recorded in this runtime",
      "last reason: unavailable",
    ];
  }
  const ld = status.lastDispatch;
  return [
    `last dispatch: ${ld.model.provider}/${ld.model.id} (tier=${ld.tier}, thinking=${ld.thinkingLevel})`,
    `last reason: ${ld.reasonCode} (selected=${ld.selectedTier})`,
  ];
}

function renderConfig(status: TsStatus): string[] {
  if (status.config === undefined) {
    return [
      "config: not loaded (built-in defaults in effect)",
      "candidates: unavailable",
    ];
  }
  const c = status.config;
  return [
    `config: ${c.health}; user=${c.user}; project=${c.project}; bias=${c.defaultBias}; sticky=${c.sticky}`,
    `candidates: brain=${c.candidateCounts.brain}; pillar=${c.candidateCounts.pillar}; crowd=${c.candidateCounts.crowd}`,
  ];
}

function renderLimits(status: TsStatus): string {
  const ld = status.lastDispatch;
  const c = status.config;
  if (ld === undefined && c === undefined) return "limits: unavailable";
  const value = (known: number | undefined, noRoute: number) =>
    known === undefined ? (ld === undefined ? String(noRoute) : "unavailable") : String(known);
  const cap = (fromRoute: number | undefined, fromConfig: number | undefined) =>
    fromRoute === undefined
      ? fromConfig === undefined
        ? "unavailable"
        : String(fromConfig)
      : String(fromRoute);
  return `limits: attempts=${value(ld?.attempt, 0)}/${cap(ld?.maxAttempts, c?.maxAttemptsPerRequest)}; tier-switches=${value(ld?.tierSwitches, 0)}/${cap(ld?.maxTierSwitches, c?.maxTierSwitches)}`;
}

/**
 * Pure text renderer (05-commands.md §3.4). Stable labels, plain text, no
 * ANSI/control sequences; every missing value renders an explicit fixed
 * phrase and nothing throws. The output carries only scalar labels and
 * provider/id identities — no paths, credentials, raw errors, or user text.
 */
export function renderTsStatus(status: TsStatus): string {
  const lines = [
    "pi-tier-scheduler status",
    renderSelection(status),
    `thinking: ${slot(status.thinkingLevel)}`,
    `routing: ${status.routing}`,
    `override: ${status.manualOverride ?? "none"}`,
    ...renderDispatch(status),
    ...renderConfig(status),
    renderLimits(status),
  ];
  if (status.controlRecovered) {
    lines.push("control: invalid-entry-recovered");
  }
  return lines.join("\n");
}

/**
 * Assemble the status command: read the live snapshot through the runtime
 * dependencies and respond once on the mode-appropriate channel. Read-only:
 * no model selection, thinking mutation, config write, or branch append
 * exists on this path.
 */
export async function runStatusCommand(
  ctx: ExtensionCommandContext,
  deps: StatusDependencies,
): Promise<void> {
  const status = buildTsStatus(ctx, {
    thinkingLevel: deps.getThinkingLevel(),
    config: deps.getConfig(),
    lastDispatch: deps.getLastDispatch(),
  });
  respond(ctx, renderTsStatus(status), "info");
}
