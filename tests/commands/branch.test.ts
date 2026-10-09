import { describe, expect, it, vi } from "vitest";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
  applyAutomatic,
  applyManualTier,
  type ControlActions,
} from "../../src/commands/control";
import { buildTsStatus, type StatusConfigInput } from "../../src/commands/status";
import type { EffectiveConfig } from "../../src/config/types";

/**
 * Branch-truth lock (05-commands.md §5.4/§7.2 hook 7): manual control lives
 * in branch entries only. A fork inherits the parent's control, a child
 * release supersedes it only on the child, navigating back restores the
 * parent's tier, and invalid entries leave only the bounded recovery marker.
 * No module-global override leaks: switching branch fixtures is only a
 * change of what getBranch() returns.
 */

const CONTROL = "pi-tier-scheduler.router-control";

function model(provider: string, id: string): Model<Api> {
  return {
    id,
    name: `${provider}/${id}`,
    api: "pi-virtual",
    provider,
    baseUrl: "",
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: true,
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

const virtual = model("ts", "auto");

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

/** One branch fixture: an entry list with a live appender for control writes. */
function branch(initial: readonly SessionEntry[] = []) {
  const entries: SessionEntry[] = [...initial];
  return {
    entries,
    view: (): SessionEntry[] => [...entries],
    append: (entry: SessionEntry): void => {
      entries.push(entry);
    },
  };
}

/** Command context bound to one branch fixture. */
function ctxFor(
  branchFixture: ReturnType<typeof branch>,
): Parameters<typeof applyManualTier>[1] {
  return {
    model: virtual,
    sessionManager: { getBranch: branchFixture.view },
    modelRegistry: { find: () => virtual },
  } as never;
}

/** Actions that append the control entry onto a branch fixture, like Pi would. */
function actionsFor(target: ReturnType<typeof branch>): ControlActions {
  return {
    setModel: vi.fn(async (): Promise<boolean> => true),
    setThinkingLevel: vi.fn(),
    appendEntry: vi.fn((type: string, data: unknown): void => {
      target.append({ type: "custom", customType: type, data } as unknown as SessionEntry);
    }),
    getThinkingLevel: vi.fn((): ThinkingLevel => "medium"),
  };
}

/** Minimal status inputs: the config summary is irrelevant to control truth. */
const statusConfig = (): StatusConfigInput => {
  const effective: EffectiveConfig = {
    schemaVersion: 1,
    tiers: {
      brain: { candidates: [] },
      pillar: { candidates: [] },
      crowd: { candidates: [] },
    },
    policy: { defaultBias: "medium", sticky: true },
    retry: { maxAttemptsPerRequest: 3, maxTierSwitches: 2 },
    provenance: {},
  };
  return {
    effective,
    problems: [],
    paths: { userPath: "/u/.pi/agent/tier-scheduler.json", projectPath: "/w/.pi/tier-scheduler.json" },
    layers: { user: "missing", project: "missing" },
  };
};

/** Status for one branch fixture: virtual selection + that branch's control. */
function statusFor(branchFixture: ReturnType<typeof branch>) {
  return buildTsStatus(
    { model: virtual, sessionManager: { getBranch: branchFixture.view } } as never,
    { thinkingLevel: "medium", config: statusConfig(), lastDispatch: undefined },
  );
}

describe("branch truth — fork, release, and navigation (§5.4, hook 7)", () => {
  it("a parent manual control is inherited by a fork", async () => {
    const parent = branch();
    await applyManualTier("brain", ctxFor(parent), actionsFor(parent));
    expect(statusFor(parent)).toMatchObject({ routing: "manual", manualOverride: "brain" });

    // Fork: the child branch starts as a copy of the parent's entries.
    const child = branch(parent.view());
    expect(statusFor(child)).toMatchObject({ routing: "manual", manualOverride: "brain" });
  });

  it("a child /ts auto release supersedes the control only on the child", async () => {
    const parent = branch();
    await applyManualTier("brain", ctxFor(parent), actionsFor(parent));

    const child = branch(parent.view());
    const release = await applyAutomatic(ctxFor(child), actionsFor(child), "medium");
    expect(release).toMatchObject({ ok: true, controlChanged: true });

    // The child is automatic; the parent keeps its manual brain control.
    expect(statusFor(child)).toMatchObject({ routing: "automatic", manualOverride: null });
    expect(statusFor(parent)).toMatchObject({ routing: "manual", manualOverride: "brain" });
  });

  it("navigating back to the parent restores the parent's manual tier", async () => {
    const parent = branch();
    await applyManualTier("pillar", ctxFor(parent), actionsFor(parent));

    const child = branch(parent.view());
    await applyAutomatic(ctxFor(child), actionsFor(child), "medium");
    await applyManualTier("crowd", ctxFor(child), actionsFor(child));

    // The child drifted to crowd; the parent branch still shows pillar.
    expect(statusFor(child)).toMatchObject({ routing: "manual", manualOverride: "crowd" });
    expect(statusFor(parent)).toMatchObject({ routing: "manual", manualOverride: "pillar" });
  });

  it("no module-global override leaks across branch fixtures", async () => {
    const first = branch();
    await applyManualTier("brain", ctxFor(first), actionsFor(first));

    // A fresh branch fixture reading the same module observes no inherited
    // control: the only truth is the entry list getBranch() returns.
    const unrelated = branch();
    expect(statusFor(unrelated)).toMatchObject({ routing: "automatic", manualOverride: null });
    // The first fixture is unaffected by the unrelated read.
    expect(statusFor(first)).toMatchObject({ routing: "manual", manualOverride: "brain" });

    // Same module, different branch data: the observed control follows only
    // the fixture passed in — never any hidden runtime mirror.
    const second = branch();
    await applyManualTier("crowd", ctxFor(second), actionsFor(second));
    expect(statusFor(second)).toMatchObject({ routing: "manual", manualOverride: "crowd" });
    expect(statusFor(first)).toMatchObject({ routing: "manual", manualOverride: "brain" });
  });
});

describe("branch truth — invalid entries (§5.5, bounded recovery)", () => {
  it("an invalid control entry reads as automatic with the recovery marker, and a new command replaces it", async () => {
    const parent = branch([invalidControlEntry()]);
    const status = statusFor(parent);
    expect(status).toMatchObject({ routing: "automatic", manualOverride: null });
    expect(status.controlRecovered).toBe(true);

    const replaced = await applyManualTier("brain", ctxFor(parent), actionsFor(parent));
    expect(replaced).toMatchObject({ ok: true, controlChanged: true });
    const after = statusFor(parent);
    expect(after).toMatchObject({ routing: "manual", manualOverride: "brain" });
    // The new control governs, while the bounded recovery marker stays on:
    // the malformed entry remains in branch history (Phase 4 latest-valid semantics).
    expect(after.controlRecovered).toBe(true);
  });

  it("an invalid entry on a fork is bounded: the child release still appends null", async () => {
    const parent = branch([invalidControlEntry()]);
    const child = branch(parent.view());
    const release = await applyAutomatic(ctxFor(child), actionsFor(child), "medium");
    expect(release).toMatchObject({ ok: true, controlChanged: true });
    expect(statusFor(child)).toMatchObject({ routing: "automatic", manualOverride: null });
    // The parent's invalid entry stays untouched; only the child gained one.
    expect(parent.view()).toHaveLength(1);
    expect(child.view()).toHaveLength(2);
    expect(child.view()[1]).toEqual(controlEntry(null));
  });
});
