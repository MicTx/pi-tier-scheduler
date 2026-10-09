import type {
  AutocompleteItem,
} from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { handleDoctor } from "../diag/doctor";
import type { DoctorApiSurface, DoctorReport } from "../diag/doctor";
import { parseTsCommand } from "./parser";
import {
  releaseManualTier,
  severityForTsResult,
  setManualTier,
  type TsControlDependencies,
} from "./control";
import { runStatusCommand } from "./status";
import { handleInit, type ConfigCommandDependencies } from "./init";
import { handleConfig } from "./config";
import { respond } from "../ui/respond";

/**
 * /ts subcommand dispatch (docs/plans/01-scaffold.md §3–§5.2; F5.1 status
 * wiring per 05-commands.md §3.1/§3.8; F5.2 control wiring per §3.5/§3.6;
 * F7.2 config wiring + footer refresh per 07-tui-modes.md §3.1/§5.6).
 *
 * The parser owns the grammar; this module owns execution routing and the
 * pure prefix-completion surface. Empty input normalizes to `status`
 * (05-commands.md §3.1). `use`/`auto` run the serialized control mutations
 * and refresh the TUI footer after a success; `doctor`, `init`, and
 * `config` route to their real handlers (F6.3/F7.1/F7.2), each owning its
 * own guards.
 */

/** One /ts subcommand entry; names/aliases feed completion. */
export interface TsSubcommand {
  /** Canonical subcommand name. */
  readonly name: string;
  /** Accepted synonyms; resolved to the canonical entry at completion time. */
  readonly aliases: readonly string[];
  /** Completion + help text. */
  readonly description: string;
  /** Phase that owns the implementation (documentation metadata). */
  readonly owningPhase: number;
}

/** Static subcommand table; immutable at runtime. */
export const SUBCOMMANDS: readonly TsSubcommand[] = [
  {
    name: "status",
    aliases: [],
    description: "show current model routing status",
    owningPhase: 5,
  },
  {
    name: "use",
    aliases: ["brain", "pillar", "crowd"],
    description: "switch model or thinking tier",
    owningPhase: 5,
  },
  {
    name: "auto",
    aliases: [],
    description: "toggle auto model scheduling",
    owningPhase: 5,
  },
  {
    name: "init",
    aliases: [],
    description: "run interactive setup wizard",
    owningPhase: 7,
  },
  {
    name: "config",
    aliases: [],
    description: "show or edit ms configuration",
    owningPhase: 7,
  },
  {
    name: "doctor",
    aliases: [],
    description: "diagnose provider and model health",
    owningPhase: 6,
  },
];

/** First-level completion candidates: canonical names in table order, then aliases. */
export const CANDIDATES: readonly AutocompleteItem[] = [
  ...SUBCOMMANDS.map((entry) => ({
    value: entry.name,
    label: entry.name,
    description: entry.description,
  })),
  ...SUBCOMMANDS.flatMap((entry) =>
    entry.aliases.map((alias) => ({
      value: alias,
      label: alias,
      description: `alias of ${entry.name}`,
    })),
  ),
];

/** Second-level tier candidates for `use ` (05-commands.md §3.8). */
export const TIER_CANDIDATES: readonly AutocompleteItem[] = [
  { value: "brain", label: "brain", description: "strong reasoning tier (thinking=high)" },
  { value: "pillar", label: "pillar", description: "balanced tier (thinking=medium)" },
  { value: "crowd", label: "crowd", description: "efficient tier (thinking=low)" },
];

/**
 * Resolve a head token to its canonical table entry by name or alias;
 * undefined when unknown.
 */
export function resolveSubcommand(head: string): TsSubcommand | undefined {
  return SUBCOMMANDS.find(
    (entry) => entry.name === head || entry.aliases.includes(head),
  );
}

/**
 * Pure prefix completion (01-scaffold.md §5.2; F5.1 second level per
 * 05-commands.md §3.8): reads nothing from config, catalogs, or the
 * filesystem.
 * - no whitespace yet → prefix filter over names + aliases;
 * - `use ` or a partial second token → tier candidates (complete tier →
 *   null; more tokens → null);
 * - any other known head complete → null (no valid next token);
 * - unknown head → [] (host shows nothing).
 */
export function completeArguments(
  argumentPrefix: string,
): AutocompleteItem[] | null {
  const whitespaceAt = argumentPrefix.search(/\s/);
  if (whitespaceAt === -1) {
    return CANDIDATES.filter((item) =>
      item.value.startsWith(argumentPrefix),
    );
  }
  const firstToken = argumentPrefix.slice(0, whitespaceAt);
  const entry = resolveSubcommand(firstToken);
  if (entry === undefined) {
    return [];
  }
  if (entry.name === "use" && firstToken === "use") {
    const rest = argumentPrefix.slice(whitespaceAt + 1).trim();
    if (rest === "") {
      return [...TIER_CANDIDATES];
    }
    if (TIER_CANDIDATES.some((item) => item.value === rest)) {
      return null;
    }
    if (/\s/.test(rest)) {
      return null;
    }
    return TIER_CANDIDATES.filter((item) => item.value.startsWith(rest));
  }
  return null;
}

/**
 * Runtime dependencies dispatch threads through to the status, control, and
 * doctor bodies (spec §2.4). The doctor additions are the pi-surface
 * accessor, the route-log health read, and the lastDoctor recorder — all
 * assembled by the extension wiring; command modules never import the
 * extension.
 */
export interface TsDispatchDependencies extends TsControlDependencies, ConfigCommandDependencies {
  getRouteLogHealth(): { writeFailures: number };
  getDoctorApi(): DoctorApiSurface;
  recordDoctorReport(report: DoctorReport): void;
}

/**
 * Tokenize, parse, and route one /ts invocation:
 * - parse errors respond once with `warning` severity;
 * - `status` (explicit or empty-normalized) runs the read-only status body;
 * - `use`/`auto` run the serialized control mutations, respond with the
 *   result's own severity (info/warning/error), and refresh the TUI footer
 *   after a success (07 §5.6);
 * - `doctor` runs the F6.3 read-only diagnostics body (its trailing-argument
 *   check lives in the handler, mirroring the parser's stable usage error);
 * - `init` runs the F7.1 TUI wizard and `config` the F7.2 view/editor; their
 *   zero-argument, mode, and flow-active guards live in the handlers.
 * Never throws on the user-input path; unexpected action failures
 * propagate to the host unswallowed (05-commands.md §3.7).
 */
export async function dispatch(
  rawArgs: string,
  ctx: ExtensionCommandContext,
  deps: TsDispatchDependencies,
): Promise<void> {
  const parsed = parseTsCommand(rawArgs);
  if (!parsed.ok) {
    respond(ctx, parsed.error.message, "warning");
    return;
  }
  switch (parsed.command.kind) {
    case "status":
      await runStatusCommand(ctx, deps);
      return;
    case "use": {
      const result = await setManualTier(parsed.command.tier, ctx, deps);
      respond(ctx, result.message, severityForTsResult(result));
      if (result.ok) deps.refreshFooter(ctx);
      return;
    }
    case "auto": {
      const result = await releaseManualTier(ctx, deps);
      respond(ctx, result.message, severityForTsResult(result));
      if (result.ok) deps.refreshFooter(ctx);
      return;
    }
    case "deferred": {
      if (parsed.command.name === "doctor") {
        await handleDoctor(parsed.command.args, ctx, deps);
        return;
      }
      if (parsed.command.name === "init") {
        await handleInit(parsed.command.args, ctx, deps);
        return;
      }
      await handleConfig(parsed.command.args, ctx, deps);
      return;
    }
  }
}
