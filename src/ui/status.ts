import type { ThinkingBias } from "../config/types";
import type { ManualTier } from "../commands/types";

// ---------------------------------------------------------------------------
// F7.2 footer status (07-tui-modes.md §3.8/§5.6): one stable status key,
// bounded plain text derived only from router control and the effective
// bias. These are pure functions over a structural context — the runtime
// wiring (lifecycle/event refresh, the idempotent clear) lives in the
// extension; RPC/JSON/print never reach `setStatus` because the mode guard
// below is the only path to it.
// ---------------------------------------------------------------------------

/** The one stable footer key this extension owns (07 §3.8). */
export const FOOTER_STATUS_KEY = "tier-scheduler";

/** Host run modes, mirrored locally so this leaf module stays import-clean. */
export type FooterMode = "tui" | "rpc" | "json" | "print";

/** Structural slice the footer functions read from any host context. */
export type FooterStatusContext = {
  mode: FooterMode;
  ui: { setStatus(key: string, text: string | undefined): void };
};

/** Footer inputs from runtime state: branch control plus effective bias. */
export type FooterStatusInput = {
  manualOverride: ManualTier | null;
  bias: ThinkingBias;
  /** Latest dispatch: routed model id and its clamped thinking level. */
  dispatch?: FooterDispatch;
  /** False once the runtime is closed — no footer write after shutdown (§5.8). */
  live: boolean;
};

/** The dispatched model as the footer shows it: id only, plus its level. */
export type FooterDispatch = {
  modelId: string;
  thinkingLevel?: string;
};

/** `(ts) auto • high` — selection and bias; `→ model • level` once routed. */
export function footerText(
  manualOverride: ManualTier | null,
  bias: ThinkingBias,
  dispatch?: FooterDispatch,
): string {
  const base = `(ts) ${manualOverride ?? "auto"} • ${bias}`;
  if (dispatch === undefined) return base;
  return dispatch.thinkingLevel === undefined
    ? `${base} → ${dispatch.modelId}`
    : `${base} → ${dispatch.modelId} • ${dispatch.thinkingLevel}`;
}

/**
 * Breathing frames for the active dot (TUI only): a point growing and
 * shrinking — `˙ · • ● • ·` — cycled by the runtime animator while a turn
 * is in flight; the idle footer carries no dot.
 */
export const FOOTER_BREATH_FRAMES: readonly string[] = ["˙", "·", "•", "●", "•", "·"];

/** The active footer line: breathing frame, then the static composition. */
export function breathingFooterText(
  frame: string,
  manualOverride: ManualTier | null,
  bias: ThinkingBias,
  dispatch?: FooterDispatch,
): string {
  return `${frame} ${footerText(manualOverride, bias, dispatch)}`;
}

/**
 * Set the footer text, only in a live TUI. Never throws: a failing
 * `setStatus` is swallowed and reported as `false` so a footer problem can
 * never fail a route, save, or command (07 §3.8). Returns whether the
 * status was written (the caller's idempotence flag updates on `true`).
 */
export function refreshFooterStatus(
  ctx: FooterStatusContext,
  input: FooterStatusInput,
): boolean {
  if (ctx.mode !== "tui" || !input.live) return false;
  try {
    ctx.ui.setStatus(
      FOOTER_STATUS_KEY,
      footerText(input.manualOverride, input.bias, input.dispatch),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear the footer key once, guarded by the runtime's `footerStatusSet`
 * flag (07 §3.8): a clear only happens when a set actually landed, so
 * repeated shutdowns and non-TUI sessions are no-ops by construction.
 * Returns whether the clear went through.
 */
export function clearFooterStatus(ctx: FooterStatusContext, footerStatusSet: boolean): boolean {
  if (!footerStatusSet || ctx.mode !== "tui") return false;
  try {
    ctx.ui.setStatus(FOOTER_STATUS_KEY, undefined);
    return true;
  } catch {
    return false;
  }
}
