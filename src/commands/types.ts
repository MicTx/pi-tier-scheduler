import type {CandidateRef, LayerStatus, ThinkingBias} from "../config/types";

/**
 * Command-surface type contracts (05-commands.md §4.1/§4.2).
 *
 * `ManualTier` is a command-grammar name in the sanctioned layer-facing-alias
 * pattern: it mirrors the Phase 2 `TierName` union so the command grammar owns
 * its own vocabulary without re-declaring config semantics.
 */

/** Manual tier vocabulary accepted by `/ts use` and the short aliases. */
export type ManualTier = "brain" | "pillar" | "crowd";

/** Canonical subcommand names of the one registered `ts` command. */
export type TsCommandName = "status" | "use" | "auto" | "init" | "config" | "doctor";

/** One parsed `/ts` invocation; deferred commands keep their argument tail. */
export type ParsedTsCommand =
  | { kind: "status" }
  | { kind: "use"; tier: ManualTier; alias: boolean }
  | { kind: "auto" }
  | { kind: "deferred"; name: "init" | "config" | "doctor"; args: string };

/** Stable user-input error; messages never leak paths or registry internals. */
export type TsCommandError = {
  code: "unknown_command" | "invalid_arguments" | "missing_tier" | "unknown_tier";
  message: string;
};

/** Result shape of the pure `parseTsCommand` (05-commands.md §6.2). */
export type ParseTsResult =
  | { ok: true; command: ParsedTsCommand }
  | { ok: false; error: TsCommandError };

/** Compact summary of the latest physical dispatch recorded by the route adapter. */
export type LastDispatchSummary = {
  model: { provider: string; id: string };
  tier: ManualTier;
  thinkingLevel: string;
  reasonCode: string;
  selectedTier: ManualTier;
  attempt?: number;
  maxAttempts?: number;
  tierSwitches?: number;
  maxTierSwitches?: number;
};

/**
 * Non-sensitive effective-config summary (05-commands.md §3.3). `user` and
 * `project` carry the Phase 2 `LayerStatus` value as-is; the renderer emits
 * the literal label and never folds `unreadable` into another status.
 */
export type ConfigSummary = {
  health: "valid" | "degraded";
  user: LayerStatus;
  project: LayerStatus;
  tierCandidates: Record<ManualTier, readonly CandidateRef[]>;
  defaultBias: ThinkingBias;
  sticky: boolean;
  maxAttemptsPerRequest: number;
  maxTierSwitches: number;
};

/**
 * Read-only status snapshot (05-commands.md §4.2, frozen shape). `config` is
 * relaxed to optional for the load-race case (spec §2.4): before the
 * session_start load completes, status renders the fixed "not loaded" line
 * instead of fabricating layer labels.
 */
export type TsStatus = {
  selection: { provider: string; id: string } | undefined;
  thinkingLevel: string | undefined;
  routing: "automatic" | "manual" | "inactive";
  manualOverride: ManualTier | null;
  lastDispatch: LastDispatchSummary | undefined;
  config: ConfigSummary | undefined;
  controlRecovered: boolean;
};
