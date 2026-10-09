import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

import { respond, type RespondContext } from "../src/ui/respond";

describe("respond — mode-guarded response channel", () => {
  let notify: ReturnType<typeof vi.fn>;
  let consoleError: ReturnType<typeof vi.spyOn>;
  let stdoutWrite: MockInstance<typeof process.stdout.write>;

  beforeEach(() => {
    notify = vi.fn();
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const ctx = (hasUI: boolean): RespondContext => ({ hasUI, ui: { notify } });

  it("routes to ui.notify with default severity when hasUI is true", () => {
    respond(ctx(true), "hello from ms");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("hello from ms", "info");
  });

  it("passes the severity through to notify", () => {
    respond(ctx(true), "watch out", "warning");
    respond(ctx(true), "broken", "error");
    expect(notify).toHaveBeenNthCalledWith(1, "watch out", "warning");
    expect(notify).toHaveBeenNthCalledWith(2, "broken", "error");
  });

  it("routes to console.error when hasUI is false and never touches stdout", () => {
    respond(ctx(false), "headless message");
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith("headless message");
    expect(notify).not.toHaveBeenCalled();
    expect(stdoutWrite).not.toHaveBeenCalled();
  });
});
