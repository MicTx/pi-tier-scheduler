import { describe, expect, it, vi } from "vitest";

import {
  choosePolicy,
  chooseRetry,
  chooseScope,
  confirmReplaceInvalidLayer,
  confirmSave,
  editTierCandidates,
  layerSummaryLine,
  MAX_CANDIDATES_PER_TIER,
  normalizeCandidateField,
  type ConfigDialogsContext,
  type ConfigDialogsUi,
} from "../../src/ui/config-dialogs";
import type { EditableConfigLayer } from "../../src/config/layer-read";
import type { CandidateRef } from "../../src/config/types";

/**
 * Dialog-sequence cancellation matrix (07-tui-modes.md §3.4/§5.3, §7.1
 * hook 5's dialog half; F7.1 spec §2.2): every select/input escape edge
 * collapses to `{ ok: false, reason: "cancelled" }`, the bounded invalid
 * budget exhausts to `exhausted`, a closed runtime is observed before every
 * step, boolean confirms answer their question instead of cancelling, and
 * the retry/policy option sets are exactly the Phase 2 enumerations.
 * Scripted fakes only: no filesystem, no registry.
 */

type Scripted =
  | { select: string | undefined }
  | { input: string | undefined }
  | { confirm: boolean };

/** Scripted ui seam: each dialog pops the next queued response. */
function scriptedUi(steps: Scripted[], log: string[] = []) {
  const queue = [...steps];
  const take = (kind: "select" | "input" | "confirm"): unknown => {
    const next = queue.shift();
    if (next === undefined || !(kind in next)) {
      throw new Error(`unexpected ${kind} dialog; next queued step: ${JSON.stringify(next ?? null)}`);
    }
    return (next as Record<string, unknown>)[kind];
  };
  const select = vi.fn(async (title: string, _options?: readonly string[]): Promise<string | undefined> => {
    log.push(`select:${title}`);
    return take("select") as string | undefined;
  });
  const confirm = vi.fn(async (title: string, _message?: string): Promise<boolean> => {
    log.push(`confirm:${title}`);
    return take("confirm") as boolean;
  });
  const input = vi.fn(async (title: string): Promise<string | undefined> => {
    log.push(`input:${title}`);
    return take("input") as string | undefined;
  });
  return {
    ui: { select, confirm, input } satisfies ConfigDialogsUi,
    select,
    confirm,
    input,
    calls: log,
  };
}

function dialogCtx(ui: ConfigDialogsUi, closed = false): ConfigDialogsContext & { setClosed(v: boolean): void } {
  let isClosed = closed;
  return {
    ui,
    isClosed: () => isClosed,
    setClosed(value: boolean) {
      isClosed = value;
    },
  };
}

const ADD = "add a candidate";
const REMOVE = "remove a candidate";
const MOVE = "move a candidate up or down";
const CLEAR = "clear all candidates";
const KEEP = "keep this tier as shown";

describe("normalizeCandidateField", () => {
  it("trims and accepts bounded plain text", () => {
    expect(normalizeCandidateField("  acme  ")).toBe("acme");
    expect(normalizeCandidateField("claude-opus-4-1")).toBe("claude-opus-4-1");
  });
  it("rejects empty, control-character, and over-long input", () => {
    expect(normalizeCandidateField("   ")).toBeNull();
    expect(normalizeCandidateField("bad\u0000id")).toBeNull();
    expect(normalizeCandidateField("x".repeat(201))).toBeNull();
    expect(normalizeCandidateField("x".repeat(200))).toBe("x".repeat(200));
  });
});

describe("chooseScope", () => {
  it("returns the selected scope with project first", async () => {
    const ui = scriptedUi([{ select: "project" }]);
    const outcome = await chooseScope(dialogCtx(ui));
    expect(outcome).toEqual({ ok: true, value: "project" });
    expect(ui.select.mock.calls[0]?.[1]).toEqual(["project", "user"]);
  });
  it("maps an escape/timeout/abort (undefined) to cancelled", async () => {
    const ui = scriptedUi([{ select: undefined }]);
    expect(await chooseScope(dialogCtx(ui))).toEqual({ ok: false, reason: "cancelled" });
  });
  it("observes a closed runtime before opening any dialog", async () => {
    const ui = scriptedUi([]);
    expect(await chooseScope(dialogCtx(ui, true))).toEqual({ ok: false, reason: "closed" });
    expect(ui.select).not.toHaveBeenCalled();
  });
});

describe("editTierCandidates", () => {
  it("keeps the list unchanged and returns it in order", async () => {
    const initial: CandidateRef[] = [
      { provider: "acme", id: "b2" },
      { provider: "acme", id: "b1" },
    ];
    const ui = scriptedUi([{ select: KEEP }]);
    const outcome = await editTierCandidates(dialogCtx(ui), "brain", initial);
    expect(outcome).toEqual({ ok: true, value: initial });
    // The returned list is a clone: callers cannot alias the input.
    if (outcome.ok) expect(outcome.value).not.toBe(initial);
  });

  it("adds a validated candidate through two inputs and preserves order", async () => {
    const ui = scriptedUi([
      { select: ADD },
      { input: " acme " },
      { input: " b3 " },
      { select: KEEP },
    ]);
    const outcome = await editTierCandidates(dialogCtx(ui), "brain", [
      { provider: "acme", id: "b1" },
    ]);
    expect(outcome).toEqual({
      ok: true,
      value: [
        { provider: "acme", id: "b1" },
        { provider: "acme", id: "b3" },
      ],
    });
  });

  it("exhausts after three consecutive invalid answers at one prompt", async () => {
    const ui = scriptedUi([
      { select: ADD },
      { input: "acme" },
      { input: "" },
      { input: "bad\u0001id" },
      { input: "b1" }, // duplicate of the existing candidate
    ]);
    const outcome = await editTierCandidates(dialogCtx(ui), "brain", [
      { provider: "acme", id: "b1" },
    ]);
    expect(outcome).toEqual({ ok: false, reason: "exhausted" });
    expect(ui.input).toHaveBeenCalledTimes(4);
  });

  it("re-asks after an invalid answer without exhausting one attempt later", async () => {
    const ui = scriptedUi([
      { select: ADD },
      { input: "acme" },
      { input: "" },
      { input: "b2" },
      { select: KEEP },
    ]);
    const outcome = await editTierCandidates(dialogCtx(ui), "brain", []);
    expect(outcome).toEqual({ ok: true, value: [{ provider: "acme", id: "b2" }] });
  });

  it("maps an input escape to cancelled (whole-flow discard at the command layer)", async () => {
    const ui = scriptedUi([{ select: ADD }, { input: undefined }]);
    const outcome = await editTierCandidates(dialogCtx(ui), "brain", []);
    expect(outcome).toEqual({ ok: false, reason: "cancelled" });
  });

  it("removes the selected candidate by identity", async () => {
    const ui = scriptedUi([
      { select: REMOVE },
      { select: "acme/b1" },
      { select: KEEP },
    ]);
    const outcome = await editTierCandidates(dialogCtx(ui), "brain", [
      { provider: "acme", id: "b1" },
      { provider: "acme", id: "b2" },
    ]);
    expect(outcome).toEqual({ ok: true, value: [{ provider: "acme", id: "b2" }] });
  });

  it("moves a candidate up and down explicitly", async () => {
    const initial: CandidateRef[] = [
      { provider: "acme", id: "a" },
      { provider: "acme", id: "b" },
      { provider: "acme", id: "c" },
    ];
    const up = await editTierCandidates(
      dialogCtx(scriptedUi([{ select: MOVE }, { select: "acme/b" }, { select: "up" }, { select: KEEP }])),
      "pillar",
      initial,
    );
    expect(up).toEqual({
      ok: true,
      value: [
        { provider: "acme", id: "b" },
        { provider: "acme", id: "a" },
        { provider: "acme", id: "c" },
      ],
    });
    const down = await editTierCandidates(
      dialogCtx(scriptedUi([{ select: MOVE }, { select: "acme/a" }, { select: "down" }, { select: KEEP }])),
      "pillar",
      initial,
    );
    expect(down).toEqual({
      ok: true,
      value: [
        { provider: "acme", id: "b" },
        { provider: "acme", id: "a" },
        { provider: "acme", id: "c" },
      ],
    });
  });

  it("offers only a downward move for the first entry", async () => {
    const { ui, select } = scriptedUi([{ select: MOVE }, { select: "acme/a" }, { select: "down" }, { select: KEEP }]);
    const outcome = await editTierCandidates(dialogCtx(ui), "crowd", [
      { provider: "acme", id: "a" },
      { provider: "acme", id: "b" },
    ]);
    expect(select.mock.calls[2]?.[1]).toEqual(["down"]);
    expect(outcome.ok).toBe(true);
  });

  it("clear answers false: the boolean answer stays in the draft loop, nothing cancels", async () => {
    const ui = scriptedUi([{ select: CLEAR }, { confirm: false }, { select: KEEP }]);
    const outcome = await editTierCandidates(dialogCtx(ui), "brain", [
      { provider: "acme", id: "b1" },
    ]);
    expect(outcome).toEqual({ ok: true, value: [{ provider: "acme", id: "b1" }] });
  });

  it("clear answers true: the tier becomes empty — an empty tier is legal", async () => {
    const ui = scriptedUi([{ select: CLEAR }, { confirm: true }, { select: KEEP }]);
    const outcome = await editTierCandidates(dialogCtx(ui), "brain", [
      { provider: "acme", id: "b1" },
    ]);
    expect(outcome).toEqual({ ok: true, value: [] });
  });

  it("hides add once the tier holds 32 candidates and shows the bound in the title", async () => {
    const full: CandidateRef[] = Array.from({ length: MAX_CANDIDATES_PER_TIER }, (_, i) => ({
      provider: "acme",
      id: `m-${i}`,
    }));
    const { ui, select } = scriptedUi([{ select: KEEP }]);
    const outcome = await editTierCandidates(dialogCtx(ui), "brain", full);
    expect(outcome.ok).toBe(true);
    const [title, options] = select.mock.calls[0] as [string, readonly string[]];
    expect(String(title)).toContain(`tier full (${MAX_CANDIDATES_PER_TIER} additions max)`);
    expect(options).not.toContain(ADD);
    expect(options).toContain(REMOVE);
    expect(options).toContain(KEEP);
  });

  it("observes a closed runtime between loop iterations", async () => {
    const ctx = dialogCtx(scriptedUi([{ select: ADD }, { input: undefined }]));
    // The provider input escapes first: a cancellation outcome.
    expect(await editTierCandidates(ctx, "brain", [])).toEqual({ ok: false, reason: "cancelled" });
    // Once closed, the next entry refuses before opening any dialog.
    ctx.setClosed(true);
    expect(await editTierCandidates(ctx, "brain", [])).toEqual({ ok: false, reason: "closed" });
  });
});

describe("choosePolicy", () => {
  it("returns the selected bias and the sticky boolean answer (false is an answer)", async () => {
    const ui = scriptedUi([{ select: "high" }, { confirm: false }]);
    expect(await choosePolicy(dialogCtx(ui), { defaultBias: "medium", sticky: true })).toEqual({
      ok: true,
      value: { defaultBias: "high", sticky: false },
    });
  });
  it("offers exactly the three Phase 2 biases and cancels on escape", async () => {
    const ui = scriptedUi([{ select: undefined }]);
    expect(await choosePolicy(dialogCtx(ui), { defaultBias: "low", sticky: true })).toEqual({
      ok: false,
      reason: "cancelled",
    });
  });
});

describe("chooseRetry", () => {
  it("offers exactly the Phase 2 absolute-bound enumerations (1–5, 0–3)", async () => {
    const { ui, select } = scriptedUi([{ select: "5" }, { select: "3" }]);
    expect(await chooseRetry(dialogCtx(ui), { maxAttemptsPerRequest: 3, maxTierSwitches: 2 })).toEqual({
      ok: true,
      value: { maxAttemptsPerRequest: 5, maxTierSwitches: 3 },
    });
    expect(select.mock.calls[0]?.[1]).toEqual(["1", "2", "3", "4", "5"]);
    expect(select.mock.calls[1]?.[1]).toEqual(["0", "1", "2", "3"]);
  });
  it("cancels on escape at either bound", async () => {
    expect(
      await chooseRetry(dialogCtx(scriptedUi([{ select: undefined }])), {
        maxAttemptsPerRequest: 3,
        maxTierSwitches: 2,
      }),
    ).toEqual({ ok: false, reason: "cancelled" });
    expect(
      await chooseRetry(dialogCtx(scriptedUi([{ select: "3" }, { select: undefined }])), {
        maxAttemptsPerRequest: 3,
        maxTierSwitches: 2,
      }),
    ).toEqual({ ok: false, reason: "cancelled" });
  });
});

describe("confirm steps", () => {
  const invalidLayer: EditableConfigLayer = {
    scope: "project",
    status: "invalid",
    value: { schemaVersion: 1 },
    problemCodes: ["BOUNDS_EXCEEDED"],
    targetPath: "/never/rendered/tier-scheduler.json",
  };

  it("layerSummaryLine reports stable codes for invalid layers without paths", () => {
    expect(layerSummaryLine(invalidLayer)).toBe(
      "project layer — status: invalid; problems: BOUNDS_EXCEEDED",
    );
  });

  it("layerSummaryLine reports bounded counts and values for valid layers", () => {
    const valid: EditableConfigLayer = {
      scope: "user",
      status: "valid",
      value: {
        schemaVersion: 1,
        tiers: { brain: { candidates: [{ provider: "a", id: "1" }, { provider: "b", id: "2" }] } },
        policy: { defaultBias: "high" },
      },
      problemCodes: [],
      targetPath: "/never/rendered/tier-scheduler.json",
    };
    expect(layerSummaryLine(valid)).toBe(
      "user layer — status: valid; candidates: brain=2; pillar=0; crowd=0; bias=high; sticky=inherit",
    );
  });

  it("a declined replacement confirm is a cancellation outcome, never a write", async () => {
    const ui = scriptedUi([{ confirm: false }]);
    expect(await confirmReplaceInvalidLayer(dialogCtx(ui), invalidLayer)).toEqual({
      ok: false,
      reason: "cancelled",
    });
  });

  it("confirmSave maps false to the cancelled outcome (explicit do-not-save)", async () => {
    const ui = scriptedUi([{ confirm: false }]);
    expect(await confirmSave(dialogCtx(ui), "preview text")).toEqual({
      ok: false,
      reason: "cancelled",
    });
  });

  it("confirmSave passes the preview as the dialog message", async () => {
    const { ui, confirm } = scriptedUi([{ confirm: true }]);
    expect(await confirmSave(dialogCtx(ui), "the preview block")).toEqual({ ok: true, value: true });
    expect(confirm.mock.calls[0]).toEqual(["save this configuration?", "the preview block", undefined]);
  });
});
