import type {
  ManualTier,
  TsCommandError,
  ParsedTsCommand,
  ParseTsResult,
} from "./types";

/**
 * Pure `/ts` command grammar (05-commands.md §3.1).
 *
 * No I/O, no config, no registry access: one raw argument string in, one
 * discriminated parse result out. Command names and tier names are lower-case
 * ASCII; input is trimmed of Unicode whitespace and split on whitespace runs.
 * Empty input normalizes to `status`; deferred commands (`init`/`config`/
 * `doctor`) keep their argument tail so Phase 6/7 can reuse the dispatch seam
 * without changing the parser contract.
 */

/** Tier vocabulary in canonical order; owned by the command grammar. */
const TIERS: readonly ManualTier[] = ["brain", "pillar", "crowd"];

const SUPPORTED_FORMS =
  "status, use <tier>, auto, init, config, doctor (tier aliases: brain, pillar, crowd)";

function isManualTier(value: string): value is ManualTier {
  return (TIERS as readonly string[]).includes(value);
}

function error(code: TsCommandError["code"], message: string): ParseTsResult {
  return { ok: false, error: { code, message } };
}

/**
 * Parse the argument string of one `/ts` invocation. Errors are stable
 * values, never thrown: `unknown_command`, `invalid_arguments`,
 * `missing_tier`, `unknown_tier`.
 */
export function parseTsCommand(rawArgs: string): ParseTsResult {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
  const [head, ...rest] = tokens;

  // Empty input is normalized to status (05-commands.md §3.1).
  if (head === undefined) {
    return { ok: true, command: { kind: "status" } };
  }

  switch (head) {
    case "status": {
      if (rest.length > 0) {
        return error(
          "invalid_arguments",
          `invalid arguments for 'status'; usage: /ts <${SUPPORTED_FORMS}>`,
        );
      }
      return { ok: true, command: { kind: "status" } };
    }
    case "use": {
      const [tier, ...extra] = rest;
      if (tier === undefined) {
        return error(
          "missing_tier",
          "missing tier; usage: /ts use <brain|pillar|crowd>",
        );
      }
      if (!isManualTier(tier)) {
        return error(
          "unknown_tier",
          `unknown tier '${tier}'; supported tiers: brain, pillar, crowd`,
        );
      }
      if (extra.length > 0) {
        return error(
          "invalid_arguments",
          `invalid arguments for 'use ${tier}'; usage: /ts use <brain|pillar|crowd>`,
        );
      }
      return { ok: true, command: { kind: "use", tier, alias: false } };
    }
    case "brain":
    case "pillar":
    case "crowd": {
      // Short aliases are byte-for-byte equivalent to /ts use <tier> after
      // parsing; trailing arguments are a stable usage error.
      if (rest.length > 0) {
        return error(
          "invalid_arguments",
          `invalid arguments for '${head}'; usage: /ts use <brain|pillar|crowd>`,
        );
      }
      return { ok: true, command: { kind: "use", tier: head, alias: true } };
    }
    case "auto": {
      if (rest.length > 0) {
        return error(
          "invalid_arguments",
          `invalid arguments for 'auto'; usage: /ts <${SUPPORTED_FORMS}>`,
        );
      }
      return { ok: true, command: { kind: "auto" } };
    }
    case "init":
    case "config":
    case "doctor": {
      return {
        ok: true,
        command: { kind: "deferred", name: head, args: rest.join(" ") },
      };
    }
    default:
      return error(
        "unknown_command",
        `unknown command '${head}'; supported: ${SUPPORTED_FORMS}`,
      );
  }
}
