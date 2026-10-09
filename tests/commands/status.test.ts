import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionCommandContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import {
  buildTsStatus,
  renderTsStatus,
  runStatusCommand,
  type StatusConfigInput,
  type StatusDependencies,
} from "../../src/commands/status";
import type {
  LastDispatchSummary,
  TsStatus,
} from "../../src/commands/types";
import type { EffectiveConfig } from "../../src/config/types";

/**
 * Status surface lock (05-commands.md §7.1 hooks 2–6): snapshot fields, the
 * routing tri-state, four-value LayerStatus literal rendering, the bounded
 * recovery marker, redaction, and the pure renderer's no-throw guarantees.
 */

const CONTROL = "pi-tier-scheduler.router-control";

function controlEntry(manualOverride: "brain" | "pillar" | "crowd" | null): SessionEntry {
  return {
    type: "custom",
    customType: CONTROL,
    data: { schemaVersion: 1, manualOverride },
  } as unknown as SessionEntry;
}

function invalidControlEntry(): SessionEntry {
  return {
    type: "custom",
    customType: CONTROL,
    data: { schemaVersion: 1, manualOverride: "frob" },
  } as unknown as SessionEntry;
}

function unknownCustomEntry(): SessionEntry {
  return {
    type: "custom",
    customType: "some.other.extension",
    data: { anything: true },
  } as unknown as SessionEntry;
}

function fakeCtx(options: {
  model?: { provider: string; id: string; api?: string };
  branch?: readonly SessionEntry[];
}) {
  const spies = {
    setModel: vi.fn(),
    setThinkingLevel: vi.fn(),
    appendEntry: vi.fn(),
  };
  const shape = {
    hasUI: true,
    mode: "tui",
    ui: { notify: vi.fn() },
    model: options.model,
    sessionManager: { getBranch: vi.fn(() => [...(options.branch ?? [])]) },
    modelRegistry: { find: vi.fn() },
    ...spies,
  };
  return {
    ctx: shape as unknown as ExtensionCommandContext,
    notify: shape.ui.notify,
    getBranch: shape.sessionManager.getBranch,
    find: shape.modelRegistry.find,
    spies,
  };
}

function effectiveConfig(overrides: Partial<EffectiveConfig["tiers"]> = {}): EffectiveConfig {
  return {
    schemaVersion: 1,
    tiers: {
      brain: { candidates: [{ provider: "acme", id: "brain-1" }] },
      pillar: { candidates: [{ provider: "acme", id: "pillar-1" }, { provider: "acme", id: "pillar-2" }] },
      crowd: { candidates: [] },
      ...overrides,
    },
    policy: { defaultBias: "medium", sticky: true },
    retry: { maxAttemptsPerRequest: 3, maxTierSwitches: 2 },
    provenance: {},
  };
}

function configInput(
  overrides: Partial<StatusConfigInput> = {},
): StatusConfigInput {
  return {
    effective: effectiveConfig(),
    problems: [],
    paths: { userPath: "/home/u/.pi/agent/tier-scheduler.json", projectPath: "/w/.pi/tier-scheduler.json" },
    layers: { user: "loaded", project: "missing" },
    ...overrides,
  };
}

function lastDispatch(overrides: Partial<LastDispatchSummary> = {}): LastDispatchSummary {
  return {
    model: { provider: "anthropic", id: "claude-sonnet-4-1" },
    tier: "pillar",
    thinkingLevel: "medium",
    reasonCode: "work_phase",
    selectedTier: "pillar",
    attempt: 1,
    maxAttempts: 3,
    tierSwitches: 0,
    maxTierSwitches: 2,
    ...overrides,
  };
}

function deps(
  overrides: Partial<StatusDependencies> = {},
): StatusDependencies {
  return {
    getThinkingLevel: () => "medium",
    getConfig: () => configInput(),
    getLastDispatch: () => undefined,
    ...overrides,
  };
}

describe("buildTsStatus — routing tri-state (hook 4)", () => {
  it("renders a physical current selection as routing inactive", () => {
    const { ctx } = fakeCtx({ model: { provider: "openai", id: "gpt-5", api: "openai-responses" } });
    const status = buildTsStatus(ctx, { thinkingLevel: "high", config: configInput(), lastDispatch: undefined });
    expect(status.selection).toEqual({ provider: "openai", id: "gpt-5" });
    expect(status.routing).toBe("inactive");
  });

  it("renders ts/auto without override as automatic", () => {
    const { ctx } = fakeCtx({ model: { provider: "ts", id: "auto", api: "pi-virtual" }, branch: [] });
    const status = buildTsStatus(ctx, { thinkingLevel: "medium", config: configInput(), lastDispatch: undefined });
    expect(status.routing).toBe("automatic");
    expect(status.manualOverride).toBeNull();
  });

  it("renders ts/auto with a branch control entry as manual", () => {
    const { ctx } = fakeCtx({
      model: { provider: "ts", id: "auto", api: "pi-virtual" },
      branch: [controlEntry("brain")],
    });
    const status = buildTsStatus(ctx, { thinkingLevel: "high", config: configInput(), lastDispatch: undefined });
    expect(status.routing).toBe("manual");
    expect(status.manualOverride).toBe("brain");
  });

  it("keeps a manual branch control visible even while a physical model is selected", () => {
    const { ctx } = fakeCtx({
      model: { provider: "openai", id: "gpt-5" },
      branch: [controlEntry("crowd")],
    });
    const status = buildTsStatus(ctx, { thinkingLevel: "low", config: configInput(), lastDispatch: undefined });
    expect(status.routing).toBe("inactive");
    expect(status.manualOverride).toBe("crowd");
  });

  it("reads no current model as selection undefined", () => {
    const { ctx } = fakeCtx({});
    const status = buildTsStatus(ctx, { thinkingLevel: undefined, config: configInput(), lastDispatch: undefined });
    expect(status.selection).toBeUndefined();
    expect(status.routing).toBe("inactive");
  });

  it("reads control live from the branch on every call (no runtime mirror)", () => {
    let branch: SessionEntry[] = [controlEntry("brain")];
    const shape = {
      model: { provider: "ts", id: "auto" },
      sessionManager: { getBranch: () => [...branch] },
    };
    const ctx = shape as unknown as ExtensionCommandContext;
    const first = buildTsStatus(ctx, { thinkingLevel: "high", config: configInput(), lastDispatch: undefined });
    expect(first.routing).toBe("manual");
    branch = [controlEntry(null)];
    const second = buildTsStatus(ctx, { thinkingLevel: "high", config: configInput(), lastDispatch: undefined });
    expect(second.routing).toBe("automatic");
  });
});

describe("buildTsStatus — control recovery and unknown entries (hook 5)", () => {
  it("marks recovery for an invalid control entry without failing", () => {
    const { ctx } = fakeCtx({
      model: { provider: "ts", id: "auto" },
      branch: [invalidControlEntry()],
    });
    const status = buildTsStatus(ctx, { thinkingLevel: "medium", config: configInput(), lastDispatch: undefined });
    expect(status.controlRecovered).toBe(true);
    expect(status.manualOverride).toBeNull();
    expect(status.routing).toBe("automatic");
  });

  it("ignores unknown custom entries entirely", () => {
    const { ctx } = fakeCtx({
      model: { provider: "ts", id: "auto" },
      branch: [unknownCustomEntry(), controlEntry("pillar")],
    });
    const status = buildTsStatus(ctx, { thinkingLevel: "medium", config: configInput(), lastDispatch: undefined });
    expect(status.controlRecovered).toBe(false);
    expect(status.manualOverride).toBe("pillar");
  });

  it("reads a broken session manager as no control, fail-soft", () => {
    const shape = {
      model: { provider: "ts", id: "auto" },
      sessionManager: { getBranch: () => { throw new Error("boom"); } },
    };
    const ctx = shape as unknown as ExtensionCommandContext;
    const status = buildTsStatus(ctx, { thinkingLevel: "medium", config: configInput(), lastDispatch: undefined });
    expect(status.manualOverride).toBeNull();
    expect(status.routing).toBe("automatic");
  });
});

describe("renderTsStatus — canonical shape and redaction (hooks 2, 3, 6)", () => {
  it("renders the canonical shape for a routed, automatic session", () => {
    const { ctx } = fakeCtx({
      model: { provider: "ts", id: "auto", api: "pi-virtual" },
      branch: [],
    });
    const status = buildTsStatus(ctx, {
      thinkingLevel: "medium",
      config: configInput(),
      lastDispatch: lastDispatch(),
    });
    expect(renderTsStatus(status)).toBe(
      [
        "pi-tier-scheduler status",
        "selection: ts/auto",
        "thinking: medium",
        "routing: automatic",
        "override: none",
        "last dispatch: anthropic/claude-sonnet-4-1 (tier=pillar, thinking=medium)",
        "last reason: work_phase (selected=pillar)",
        "config: valid; user=loaded; project=missing; bias=medium; sticky=true",
        "candidates: brain=1; pillar=2; crowd=0",
        "limits: attempts=1/3; tier-switches=0/2",
      ].join("\n"),
    );
  });

  it("renders every LayerStatus value as its literal label, including unreadable (hook 3)", () => {
    const { ctx } = fakeCtx({ model: { provider: "ts", id: "auto" }, branch: [] });
    for (const value of ["loaded", "missing", "invalid", "unreadable"] as const) {
      const status = buildTsStatus(ctx, {
        thinkingLevel: "medium",
        config: configInput({ layers: { user: value, project: value } }),
        lastDispatch: undefined,
      });
      const text = renderTsStatus(status);
      expect(text).toContain(`user=${value}`);
      expect(text).toContain(`project=${value}`);
    }
  });

  it("reports health degraded with problems present, without problem text (hook 3)", () => {
    const { ctx } = fakeCtx({ model: { provider: "ts", id: "auto" }, branch: [] });
    const status = buildTsStatus(ctx, {
      thinkingLevel: "medium",
      config: configInput({
        problems: [
          { source: "user", path: "policy.defaultBias", severity: "error", code: "INVALID_VALUE", message: "secret debug details with /absolute/path" },
        ],
        layers: { user: "invalid", project: "missing" },
      }),
      lastDispatch: undefined,
    });
    const text = renderTsStatus(status);
    expect(text).toContain("config: degraded; user=invalid; project=missing");
    expect(text).not.toContain("INVALID_VALUE");
    expect(text).not.toContain("/absolute/path");
    expect(text).not.toContain("secret debug details");
  });

  it("renders an explicit not-recorded line before any route (hook 2)", () => {
    const { ctx } = fakeCtx({ model: { provider: "ts", id: "auto" }, branch: [] });
    const text = renderTsStatus(buildTsStatus(ctx, {
      thinkingLevel: "medium",
      config: configInput(),
      lastDispatch: undefined,
    }));
    expect(text).toContain("last dispatch: not recorded in this runtime");
    expect(text).toContain("last reason: unavailable");
  });

  it("renders the fixed not-loaded line before the config load completes", () => {
    const { ctx } = fakeCtx({ model: { provider: "ts", id: "auto" }, branch: [] });
    const text = renderTsStatus(buildTsStatus(ctx, {
      thinkingLevel: "medium",
      config: undefined,
      lastDispatch: undefined,
    }));
    expect(text).toContain("config: not loaded (built-in defaults in effect)");
    expect(text).toContain("candidates: unavailable");
    expect(text).toContain("limits: unavailable");
  });

  it("adds the bounded recovery marker only when recovery happened", () => {
    const { ctx } = fakeCtx({ model: { provider: "ts", id: "auto" }, branch: [invalidControlEntry()] });
    const text = renderTsStatus(buildTsStatus(ctx, {
      thinkingLevel: "medium",
      config: configInput(),
      lastDispatch: undefined,
    }));
    expect(text).toContain("control: invalid-entry-recovered");
    const { ctx: cleanCtx } = fakeCtx({ model: { provider: "ts", id: "auto" }, branch: [] });
    expect(renderTsStatus(buildTsStatus(cleanCtx, {
      thinkingLevel: "medium",
      config: configInput(),
      lastDispatch: undefined,
    }))).not.toContain("invalid-entry-recovered");
  });

  it("never emits ANSI/control sequences and never throws on missing values (hook 6)", () => {
    const { ctx } = fakeCtx({});
    const degraded = buildTsStatus(ctx, {
      thinkingLevel: undefined,
      config: configInput({
        effective: effectiveConfig({
          brain: { candidates: [] },
          pillar: { candidates: [] },
          crowd: { candidates: [] },
        }),
        problems: [{ source: "user", path: "", severity: "error", code: "X", message: "m" }],
        layers: { user: "invalid", project: "unreadable" },
      }),
      lastDispatch: lastDispatch({ attempt: undefined, maxAttempts: undefined, tierSwitches: undefined, maxTierSwitches: undefined }),
    });
    const text = renderTsStatus(degraded);
    expect(text).not.toContain("\u001b");
    expect(text).toContain("selection: not selected");
    expect(text).toContain("thinking: unavailable");
    expect(text).toContain("candidates: brain=0; pillar=0; crowd=0");
    expect(text).toContain("limits: attempts=unavailable/3; tier-switches=unavailable/2");
  });

  it("renders a sticky dispatch without attempt fields as unavailable, not fabricated", () => {
    const { ctx } = fakeCtx({ model: { provider: "ts", id: "auto" }, branch: [] });
    const status = buildTsStatus(ctx, {
      thinkingLevel: "medium",
      config: configInput(),
      lastDispatch: lastDispatch({
        reasonCode: "sticky_continuation",
        attempt: undefined,
        maxAttempts: undefined,
        tierSwitches: undefined,
        maxTierSwitches: undefined,
      }),
    });
    expect(renderTsStatus(status)).toContain("last reason: sticky_continuation (selected=pillar)");
    expect(renderTsStatus(status)).toContain("limits: attempts=unavailable/3; tier-switches=unavailable/2");
  });

  it("carries no paths, credentials, or raw errors anywhere in its output", () => {
    const { ctx } = fakeCtx({ model: { provider: "ts", id: "auto" }, branch: [] });
    const text = renderTsStatus(buildTsStatus(ctx, {
      thinkingLevel: "medium",
      config: configInput(),
      lastDispatch: lastDispatch(),
    }));
    for (const banned of ["/home/", "/w/", ".json", "apiKey", "sk-", "Bearer"]) {
      expect(text).not.toContain(banned);
    }
  });
});

describe("runStatusCommand — assembly and read-only behavior (hook 1)", () => {
  it("responds exactly once with the rendered snapshot and mutates nothing", async () => {
    const { ctx, notify, getBranch, find, spies } = fakeCtx({
      model: { provider: "ts", id: "auto", api: "pi-virtual" },
      branch: [],
    });
    await runStatusCommand(ctx, deps());
    expect(notify).toHaveBeenCalledTimes(1);
    const [message, severity] = notify.mock.calls[0] ?? [];
    expect(severity).toBe("info");
    expect(String(message)).toContain("pi-tier-scheduler status");
    expect(String(message)).toContain("selection: ts/auto");
    // Read-only proof: the mutation and lookup surfaces were never touched.
    expect(spies.setModel).not.toHaveBeenCalled();
    expect(spies.setThinkingLevel).not.toHaveBeenCalled();
    expect(spies.appendEntry).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
    expect(getBranch).toHaveBeenCalledTimes(1);
  });

  it("empty snapshot inputs render the same fixed lines as an explicit status", async () => {
    const emptyFirst = fakeCtx({ model: { provider: "ts", id: "auto" }, branch: [] });
    await runStatusCommand(emptyFirst.ctx, deps());
    const first = String(emptyFirst.notify.mock.calls[0]?.[0]);

    const explicitSecond = fakeCtx({ model: { provider: "ts", id: "auto" }, branch: [] });
    await runStatusCommand(explicitSecond.ctx, deps());
    const second = String(explicitSecond.notify.mock.calls[0]?.[0]);
    expect(first).toBe(second);
  });
});
