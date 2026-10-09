import { describe, expect, it } from "vitest";

import { parseTsCommand } from "../../src/commands/parser";
import type { TsCommandError, ParsedTsCommand } from "../../src/commands/types";

/**
 * Parser grammar lock (05-commands.md §3.1/§7.1): status normalization, tier
 * aliases, the four stable error codes, deferred argument tails, and the
 * redaction floor (no paths or registry internals in any error message).
 */

type OkCase = { raw: string; command: ParsedTsCommand };
type ErrCase = { raw: string; code: TsCommandError["code"]; messageContains: string[] };

describe("parseTsCommand — accepted forms", () => {
  it.each<OkCase>([
    { raw: "", command: { kind: "status" } },
    { raw: "   ", command: { kind: "status" } },
    { raw: "status", command: { kind: "status" } },
    { raw: "use brain", command: { kind: "use", tier: "brain", alias: false } },
    { raw: "use pillar", command: { kind: "use", tier: "pillar", alias: false } },
    { raw: "use crowd", command: { kind: "use", tier: "crowd", alias: false } },
    { raw: "brain", command: { kind: "use", tier: "brain", alias: true } },
    { raw: "pillar", command: { kind: "use", tier: "pillar", alias: true } },
    { raw: "crowd", command: { kind: "use", tier: "crowd", alias: true } },
    { raw: "auto", command: { kind: "auto" } },
    { raw: "init", command: { kind: "deferred", name: "init", args: "" } },
    { raw: "config", command: { kind: "deferred", name: "config", args: "" } },
    { raw: "doctor", command: { kind: "deferred", name: "doctor", args: "" } },
    { raw: "init a b", command: { kind: "deferred", name: "init", args: "a b" } },
    { raw: "config --json", command: { kind: "deferred", name: "config", args: "--json" } },
  ])("'$raw' parses to $command", ({ raw, command }) => {
    expect(parseTsCommand(raw)).toEqual({ ok: true, command });
  });

  it("splits on whitespace runs and trims Unicode whitespace", () => {
    expect(parseTsCommand(" use \t brain ")).toEqual({
      ok: true,
      command: { kind: "use", tier: "brain", alias: false },
    });
    expect(parseTsCommand("\u00a0auto\u00a0")).toEqual({ ok: true, command: { kind: "auto" } });
  });
});

describe("parseTsCommand — stable errors", () => {
  it.each<ErrCase>([
    {
      raw: "frob",
      code: "unknown_command",
      messageContains: ["unknown command 'frob'", "status, use <tier>, auto, init, config, doctor"],
    },
    {
      raw: "Status",
      code: "unknown_command",
      messageContains: ["unknown command 'Status'"],
    },
    {
      raw: "status extra",
      code: "invalid_arguments",
      messageContains: ["invalid arguments for 'status'"],
    },
    {
      raw: "use",
      code: "missing_tier",
      messageContains: ["missing tier", "/ts use <brain|pillar|crowd>"],
    },
    {
      raw: "use frob",
      code: "unknown_tier",
      messageContains: ["unknown tier 'frob'", "brain, pillar, crowd"],
    },
    {
      raw: "use brain extra",
      code: "invalid_arguments",
      messageContains: ["invalid arguments for 'use brain'"],
    },
    {
      raw: "brain extra",
      code: "invalid_arguments",
      messageContains: ["invalid arguments for 'brain'"],
    },
    {
      raw: "auto extra",
      code: "invalid_arguments",
      messageContains: ["invalid arguments for 'auto'"],
    },
  ])("'$raw' errors with $code", ({ raw, code, messageContains }) => {
    const result = parseTsCommand(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe(code);
    for (const fragment of messageContains) {
      expect(result.error.message).toContain(fragment);
    }
  });

  it("never leaks paths, env, or registry internals in an error message", () => {
    for (const raw of ["frob", "use", "use frob", "use brain x", "status x", "auto x"]) {
      const result = parseTsCommand(raw);
      if (result.ok) throw new Error("unreachable");
      for (const banned of ["modelRegistry", "process.env", ".json", "http", "auth", "/etc/", "~"]) {
        expect(result.error.message).not.toContain(banned);
      }
    }
  });

  it("error results are stable (identical input, identical result)", () => {
    expect(parseTsCommand("frob")).toEqual(parseTsCommand("frob"));
    expect(parseTsCommand("use frob")).toEqual(parseTsCommand("use frob"));
  });
});
