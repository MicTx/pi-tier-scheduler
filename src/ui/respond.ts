/**
 * Mode-guarded response channel for the /ts command family
 * (docs/plans/01-scaffold.md §3).
 *
 * The only sanctioned way to talk back to the user. When a UI exists
 * (TUI) the message goes to the notify widget; headless modes
 * (rpc/json/print) must keep stdout clean for the host's structured
 * output, so messages go to stderr via console.error.
 */

/** Severity passed through to the notify widget; matches its own union. */
export type RespondSeverity = "info" | "warning" | "error";

/**
 * Minimal structural context the responder needs. The real
 * ExtensionContext and ExtensionCommandContext satisfy this shape, so
 * unit tests can pass a two-field fake without building a full host
 * context.
 */
export interface RespondContext {
  hasUI: boolean;
  ui: {
    notify(message: string, type?: RespondSeverity): void;
  };
}

/**
 * Send `message` on the mode-appropriate channel: ui.notify when a UI
 * exists, console.error otherwise. stdout is never written.
 */
export function respond(
  ctx: RespondContext,
  message: string,
  severity: RespondSeverity = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, severity);
    return;
  }
  console.error(message);
}
