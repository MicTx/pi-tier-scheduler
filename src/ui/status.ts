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
  /** False once the runtime is closed — no footer write after shutdown (§5.8). */
  live: boolean;
};

/** `ts:auto/medium` / `ts:brain/high` — tier or auto, then bias (§3.8). */
export function footerText(manualOverride: ManualTier | null, bias: ThinkingBias): string {
  return `ts:${manualOverride ?? "auto"}/${bias}`;
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
    ctx.ui.setStatus(FOOTER_STATUS_KEY, footerText(input.manualOverride, input.bias));
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
