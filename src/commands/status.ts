import type {
  ExtensionCommandContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import type { CandidateRef, LayerStatus, LoadResult } from "../config/types";
import { readLatestRouterControl } from "../routing";
import { TS_VIRTUAL_MODEL_ID, TS_VIRTUAL_PROVIDER } from "../routing/virtual-model";
import { respond } from "../ui/respond";
import type {
  ConfigSummary,
  LastDispatchSummary,
  TsStatus,
  ManualTier,
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
    tierCandidates: {
      brain: config.effective.tiers.brain.candidates,
      pillar: config.effective.tiers.pillar.candidates,
      crowd: config.effective.tiers.crowd.candidates,
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

/**
 * The story line: what is selected, at what strength, and — once a route has
 * landed — which model answered. One sentence, the same vocabulary as the
 * footer; selection, thinking, routing mode, and override collapse into it.
 */
function renderStory(status: TsStatus): string {
  if (status.selection === undefined) return "selection: none — routing inactive";
  if (status.selection.provider !== TS_VIRTUAL_PROVIDER || status.selection.id !== TS_VIRTUAL_MODEL_ID) {
    return `selection: ${status.selection.provider}/${status.selection.id} — routing inactive`;
  }
  const head = `(ts) ${status.manualOverride ?? "auto"} • ${status.thinkingLevel ?? "unavailable"}`;
  const ld = status.lastDispatch;
  return ld === undefined ? head : `${head} → ${ld.model.id} • ${ld.thinkingLevel}`;
}

function renderLast(status: TsStatus): string {
  if (status.lastDispatch === undefined) return "last: not recorded in this runtime";
  const ld = status.lastDispatch;
  return `last: ${ld.reasonCode} (selected ${ld.selectedTier})`;
}

/** Tier rows for the status table; ordered fallback chain as `->`. */
const TIER_ROW_ORDER: readonly ManualTier[] = ["brain", "pillar", "crowd"];

/** Candidates shown per tier before the list is truncated (bounded output). */
const TIER_TABLE_MAX_CANDIDATES = 4;

function renderTierRow(tier: ManualTier, candidates: readonly CandidateRef[]): string {
  if (candidates.length === 0) return `  ${tier.padEnd(7)} (none)`;
  const shown = candidates.slice(0, TIER_TABLE_MAX_CANDIDATES).map((c) => `${c.provider}/${c.id}`);
  const overflow = candidates.length - TIER_TABLE_MAX_CANDIDATES;
  const list = overflow > 0 ? `${shown.join(" -> ")} (+${overflow} more)` : shown.join(" -> ");
  return `  ${tier.padEnd(7)} ${list}`;
}

function renderConfig(status: TsStatus): string[] {
  if (status.config === undefined) {
    return ["config: not loaded — built-in defaults in effect"];
  }
  const c = status.config;
  return [
    "tiers:",
    "  tier    candidates",
    ...TIER_ROW_ORDER.map((tier) => renderTierRow(tier, c.tierCandidates[tier])),
    "",
    `config: ${c.health} · user ${c.user} · project ${c.project} · bias ${c.defaultBias} · sticky ${c.sticky ? "on" : "off"}`,
  ];
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
    "",
    renderStory(status),
    renderLast(status),
    ...renderConfig(status),
  ];
  if (status.controlRecovered) {
    lines.push("control: invalid-entry-recovered");
  }
  return lines.join("\n");
}

/** `/ts status` command face: assemble the snapshot and respond once. */
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
