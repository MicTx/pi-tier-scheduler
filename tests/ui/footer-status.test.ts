import { describe, expect, it, vi } from "vitest";

import {
  clearFooterStatus,
  footerText,
  FOOTER_STATUS_KEY,
  refreshFooterStatus,
  type FooterStatusContext,
} from "../../src/ui/status";

/**
 * Footer status pure-function lock (07-tui-modes.md §3.8/§5.6; F7.2 spec
 * §7.2 hook 7): the one stable key, the bounded text shape, the tui+live
 * guard as the only path to `setStatus`, swallowed `setStatus` failures,
 * and the flag-guarded single clear.
 */

function ctx(mode: "tui" | "rpc" | "json" | "print", setStatus = vi.fn()): FooterStatusContext {
  return { mode, ui: { setStatus } };
}

describe("footerText", () => {
  it("renders the canonical auto and manual shapes", () => {
    expect(footerText(null, "medium")).toBe("ts:auto/medium");
    expect(footerText("brain", "high")).toBe("ts:brain/high");
    expect(footerText("crowd", "low")).toBe("ts:crowd/low");
  });

  it("uses the one stable status key", () => {
    expect(FOOTER_STATUS_KEY).toBe("tier-scheduler");
  });
});

describe("refreshFooterStatus", () => {
  const input = { manualOverride: null, bias: "medium" as const, live: true };

  it("writes the key and text only in a live tui and reports success", () => {
    const face = ctx("tui");
    expect(refreshFooterStatus(face, input)).toBe(true);
    expect(face.ui.setStatus).toHaveBeenCalledTimes(1);
    expect(face.ui.setStatus).toHaveBeenCalledWith("tier-scheduler", "ts:auto/medium");
  });

  it.each(["rpc", "json", "print"] as const)("%s never touches setStatus", (mode) => {
    const face = ctx(mode);
    expect(refreshFooterStatus(face, input)).toBe(false);
    expect(face.ui.setStatus).not.toHaveBeenCalled();
  });

  it("does nothing once the runtime is closed", () => {
    const face = ctx("tui");
    expect(refreshFooterStatus(face, { ...input, live: false })).toBe(false);
    expect(face.ui.setStatus).not.toHaveBeenCalled();
  });

  it("swallows a throwing setStatus and reports failure", () => {
    const boom = vi.fn(() => {
      throw new Error("status surface unavailable");
    });
    const face = ctx("tui", boom);
    expect(refreshFooterStatus(face, input)).toBe(false);
    expect(boom).toHaveBeenCalledTimes(1);
  });
});

describe("clearFooterStatus", () => {
  it("clears exactly once: the flag gates the second call", () => {
    const face = ctx("tui");
    expect(clearFooterStatus(face, true)).toBe(true);
    expect(face.ui.setStatus).toHaveBeenCalledWith("tier-scheduler", undefined);
    expect(face.ui.setStatus).toHaveBeenCalledTimes(1);
    // After the successful clear the caller drops the flag; a repeated
    // clear is a no-op even under repeated shutdown events.
    expect(clearFooterStatus(face, false)).toBe(false);
    expect(face.ui.setStatus).toHaveBeenCalledTimes(1);
  });

  it("never clears outside tui or when nothing was set", () => {
    expect(clearFooterStatus(ctx("rpc"), true)).toBe(false);
    const tui = ctx("tui");
    expect(clearFooterStatus(tui, false)).toBe(false);
    expect(tui.ui.setStatus).not.toHaveBeenCalled();
  });

  it("swallows a throwing setStatus", () => {
    const boom = vi.fn(() => {
      throw new Error("gone");
    });
    expect(clearFooterStatus(ctx("tui", boom), true)).toBe(false);
  });
});
