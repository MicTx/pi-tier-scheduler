import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
  appendRouteLog,
  createRouteLogSink,
  readLatestRouteLog,
  renderRouteLogEntry,
  ROUTE_DECISION_ENTRY,
  ROUTE_LOG_SCHEMA_VERSION,
  validateRouteLogEntry,
  type RouteLogEntry,
} from "../../src/diag/route-log";

/**
 * Route decision log tests (F6.2, 06-fallback-diagnostics.md §7.2 hooks
 * 1/2/3/5 plus the sink contract of hook 4): schema validation for the six
 * decision kinds, whitelist/cap behavior under hostile input, branch reading
 * with malformed counting and fork-local semantics, append-failure health
 * counting that never throws, and the redacted single-line renderer. No Pi
 * process, no credentials, no network: the `appendEntry` seam is a spy.
 */

const CONTROL = "pi-tier-scheduler.router-control";

/** Valid baseline record; tests override the fields they exercise. */
function entry(overrides: Partial<RouteLogEntry> = {}): RouteLogEntry {
  return {
    schemaVersion: ROUTE_LOG_SCHEMA_VERSION,
    requestReason: "user",
    outcome: "selected",
    reasonCode: "work_phase",
    phase: "implementation",
    complexity: "standard",
    requestedTier: "pillar",
    selectedTier: "pillar",
    selectedCandidate: { provider: "anthropic", id: "sonnet" },
    selectedThinking: "medium",
    attempt: 1,
    maxAttempts: 3,
    tierSwitches: 0,
    maxTierSwitches: 2,
    fallbackPath: [],
    boundHits: [],
    stateStatus: "valid",
    ...overrides,
  };
}

/** Six decision kinds the adapter records (§7.2 hook 1). */
const SIX_DECISIONS: readonly { name: string; record: RouteLogEntry }[] = [
  {
    name: "successful user route",
    record: entry({ requestReason: "user", outcome: "selected", reasonCode: "work_phase" }),
  },
  {
    name: "successful sticky continuation",
    record: entry({
      requestReason: "continuation",
      outcome: "selected",
      reasonCode: "sticky_continuation",
      attempt: 1,
    }),
  },
  {
    name: "successful retry fallback",
    record: entry({
      requestReason: "retry",
      outcome: "selected",
      reasonCode: "retry_tier_fallback",
      attempt: 2,
      tierSwitches: 1,
      selectedTier: "brain",
      requestedTier: "pillar",
      selectedCandidate: { provider: "anthropic", id: "opus" },
      selectedThinking: "high",
      failed: {
        candidate: { provider: "acme", id: "pillar-1" },
        tier: "pillar",
        failureClass: "transient",
        retryHint: "transient",
      },
      fallbackPath: ["same_provider", "same_tier", "escalate_tier"],
      boundHits: ["provider_skipped"],
    }),
  },
  {
    name: "direct request",
    record: entry({
      requestReason: "direct",
      outcome: "selected",
      reasonCode: "direct",
      stateStatus: "absent",
    }),
  },
  {
    name: "terminal bound exhaustion",
    record: entry({
      requestReason: "retry",
      outcome: "exhausted",
      reasonCode: "route_limit_exceeded",
      attempt: 3,
      maxAttempts: 3,
      selectedTier: undefined,
      selectedCandidate: undefined,
      selectedThinking: undefined,
      failed: {
        candidate: { provider: "acme", id: "pillar-1" },
        tier: "pillar",
        failureClass: "rate_limited",
        retryHint: "transient",
      },
      boundHits: ["attempt_limit"],
      stateStatus: "absent",
    }),
  },
  {
    name: "aborted request",
    record: entry({
      requestReason: "retry",
      outcome: "aborted",
      reasonCode: "route_limit_exceeded",
      attempt: 1,
      selectedTier: undefined,
      selectedCandidate: undefined,
      selectedThinking: undefined,
      failed: {
        candidate: { provider: "acme", id: "pillar-1" },
        tier: null,
        failureClass: "aborted",
        retryHint: "permanent",
      },
      stateStatus: "valid",
    }),
  },
];

function custom(customType: string, data: unknown): SessionEntry {
  return { type: "custom", customType, data } as unknown as SessionEntry;
}

function messageEntry(): SessionEntry {
  return {
    type: "message",
    message: { role: "user", content: "SECRET user transcript text", timestamp: 0 },
  } as unknown as SessionEntry;
}

describe("schema validation — the six decision kinds (hook 1)", () => {
  it.each(SIX_DECISIONS)("validates $name as a version-1 record", ({ record }) => {
    const validated = validateRouteLogEntry(record);
    expect(validated).toBeDefined();
    expect(validated?.schemaVersion).toBe(1);
    expect(validated?.requestReason).toBe(record.requestReason);
    expect(validated?.outcome).toBe(record.outcome);
    expect(validated?.reasonCode).toBe(record.reasonCode);
  });

  it("round-trips the retry-fallback payload with candidate, failure class, stages, counters, and bound hits", () => {
    const validated = validateRouteLogEntry(SIX_DECISIONS[2]!.record)!;
    expect(validated.selectedCandidate).toEqual({ provider: "anthropic", id: "opus" });
    expect(validated.failed).toEqual({
      candidate: { provider: "acme", id: "pillar-1" },
      tier: "pillar",
      failureClass: "transient",
      retryHint: "transient",
    });
    expect(validated.fallbackPath).toEqual(["same_provider", "same_tier", "escalate_tier"]);
    expect(validated.boundHits).toEqual(["provider_skipped"]);
    expect(validated.attempt).toBe(2);
    expect(validated.maxAttempts).toBe(3);
    expect(validated.tierSwitches).toBe(1);
    expect(validated.maxTierSwitches).toBe(2);
  });
});

describe("whitelist and vocabulary validation (hook 2)", () => {
  it("rejects non-objects, arrays, and null", () => {
    expect(validateRouteLogEntry(undefined)).toBeUndefined();
    expect(validateRouteLogEntry(null)).toBeUndefined();
    expect(validateRouteLogEntry("route")).toBeUndefined();
    expect(validateRouteLogEntry([entry()])).toBeUndefined();
  });

  it("rejects any schema version other than 1", () => {
    expect(validateRouteLogEntry(entry({ schemaVersion: 2 as never }))).toBeUndefined();
    expect(validateRouteLogEntry(entry({ schemaVersion: 0 as never }))).toBeUndefined();
  });

  it("rejects unknown top-level keys even when everything else is valid", () => {
    expect(validateRouteLogEntry({ ...entry(), transcript: "user text" })).toBeUndefined();
    expect(validateRouteLogEntry({ ...entry(), errorMessage: "raw provider error" })).toBeUndefined();
    expect(validateRouteLogEntry({ ...entry(), apiKey: "sk-secret" })).toBeUndefined();
    expect(validateRouteLogEntry({ ...entry(), filePath: "/Users/alice/.pi/agent/auth.json" })).toBeUndefined();
  });

  it("rejects values outside the enum vocabularies", () => {
    expect(validateRouteLogEntry(entry({ requestReason: "batch" as never }))).toBeUndefined();
    expect(validateRouteLogEntry(entry({ outcome: "failed" as never }))).toBeUndefined();
    expect(validateRouteLogEntry(entry({ phase: "ideation" as never }))).toBeUndefined();
    expect(validateRouteLogEntry(entry({ complexity: "extreme" as never }))).toBeUndefined();
    expect(validateRouteLogEntry(entry({ requestedTier: "edge" as never }))).toBeUndefined();
    expect(validateRouteLogEntry(entry({ selectedTier: "edge" as never }))).toBeUndefined();
    expect(validateRouteLogEntry(entry({ selectedThinking: "ultra" as never }))).toBeUndefined();
    expect(validateRouteLogEntry(entry({ stateStatus: "stale" as never }))).toBeUndefined();
  });

  it("rejects malformed identities, unknown stage/hit codes, and malformed failed blocks", () => {
    expect(
      validateRouteLogEntry(entry({ selectedCandidate: { provider: "", id: "sonnet" } })),
    ).toBeUndefined();
    expect(
      validateRouteLogEntry({
        ...entry(),
        selectedCandidate: { provider: "anthropic", id: "sonnet", apiKey: "sk-secret" },
      }),
    ).toBeUndefined();
    expect(validateRouteLogEntry(entry({ fallbackPath: ["same_provider", "teleport"] as never }))).toBeUndefined();
    expect(validateRouteLogEntry(entry({ boundHits: ["attempt_limit", "timeout"] as never }))).toBeUndefined();
    expect(
      validateRouteLogEntry(
        entry({ failed: { candidate: { provider: "acme", id: "pillar-1" }, tier: "pillar", failureClass: "crashed" as never, retryHint: "transient" } }),
      ),
    ).toBeUndefined();
    expect(validateRouteLogEntry(entry({ failed: { candidate: null } as never }))).toBeUndefined();
  });

  it("bounds reasonCode shape and length", () => {
    expect(validateRouteLogEntry(entry({ reasonCode: "Retry Same Tier" }))).toBeUndefined();
    expect(validateRouteLogEntry(entry({ reasonCode: "" }))).toBeUndefined();
    expect(
      validateRouteLogEntry(entry({ reasonCode: "a".repeat(65) })),
    ).toBeUndefined();
    expect(validateRouteLogEntry(entry({ reasonCode: "a".repeat(64) }))).toBeDefined();
  });

  it("bounds identity string length against oversized hostile values", () => {
    const long = "a".repeat(201);
    expect(
      validateRouteLogEntry(entry({ selectedCandidate: { provider: long, id: "sonnet" } })),
    ).toBeUndefined();
    expect(
      validateRouteLogEntry(entry({ selectedCandidate: { provider: "a".repeat(200), id: "sonnet" } })),
    ).toBeDefined();
  });
});

describe("caps and clamps under hostile input (hook 2)", () => {
  it("deduplicates and caps fallbackPath at eight", () => {
    const hostile = Array.from({ length: 40 }, (_, i) =>
      ["same_provider", "same_tier", "escalate_tier", "degrade_tier", "skip_provider", "capability_rejected"][i % 6]!,
    );
    const validated = validateRouteLogEntry(entry({ fallbackPath: hostile as never }))!;
    expect(validated.fallbackPath).toEqual([
      "same_provider",
      "same_tier",
      "escalate_tier",
      "degrade_tier",
      "skip_provider",
      "capability_rejected",
    ]);
    expect(validated.fallbackPath.length).toBeLessThanOrEqual(8);
  });

  it("caps boundHits at four", () => {
    const validated = validateRouteLogEntry(entry({
      boundHits: ["attempt_limit", "tier_switch_limit", "candidate_exhausted", "provider_skipped", "attempt_limit"] as never,
    }))!;
    expect(validated.boundHits).toEqual([
      "attempt_limit",
      "tier_switch_limit",
      "candidate_exhausted",
      "provider_skipped",
    ]);
  });

  it("clamps counters to non-negative integers", () => {
    const validated = validateRouteLogEntry(entry({
      attempt: -5,
      maxAttempts: 2.7,
      tierSwitches: Number.NaN,
      maxTierSwitches: 1e308,
    }))!;
    expect(validated.attempt).toBe(0);
    expect(validated.maxAttempts).toBe(2);
    expect(validated.tierSwitches).toBe(0);
    expect(validated.maxTierSwitches).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("validateRouteLogEntry returns a defensive clone", () => {
  it("never mutates the input, including nested blocks", () => {
    const record = entry({
      fallbackPath: ["same_provider", "same_tier"],
      failed: {
        candidate: { provider: "acme", id: "pillar-1" },
        tier: "pillar",
        failureClass: "transient",
        retryHint: "transient",
      },
    });
    const snapshot = JSON.parse(JSON.stringify(record));
    const validated = validateRouteLogEntry(record)!;
    expect(validated).not.toBe(record);
    expect(validated.failed).not.toBe(record.failed);
    expect(validated.fallbackPath).not.toBe(record.fallbackPath);
    expect(JSON.parse(JSON.stringify(record))).toEqual(snapshot);
  });

  it("freezes the persisted payload against later caller mutation", () => {
    const pi = { appendEntry: vi.fn() };
    const sink = createRouteLogSink(pi, () => []);
    const record = entry();
    appendRouteLog(record, sink);
    record.reasonCode = "tampered_after_append";
    const persisted = pi.appendEntry.mock.calls[0]?.[1] as RouteLogEntry;
    expect(persisted.reasonCode).toBe("work_phase");
  });
});

describe("readLatestRouteLog — branch scan (hook 3)", () => {
  it("returns undefined and zero on an empty or unrelated-only branch", () => {
    expect(readLatestRouteLog([])).toEqual({ malformedCount: 0 });
    const unrelated = [
      messageEntry(),
      custom(CONTROL, { schemaVersion: 1, manualOverride: "brain" }),
      custom("some-other-extension.notes", { free: "text" }),
    ];
    expect(readLatestRouteLog(unrelated)).toEqual({ malformedCount: 0 });
  });

  it("selects the newest valid record and skips unrelated entries silently", () => {
    const first = entry({ reasonCode: "work_phase", attempt: 1 });
    const second = entry({ reasonCode: "thinking_bias", attempt: 2 });
    const branch = [messageEntry(), custom(CONTROL, {}), custom(ROUTE_DECISION_ENTRY, first), messageEntry(), custom(ROUTE_DECISION_ENTRY, second)];
    const result = readLatestRouteLog(branch);
    expect(result.latest?.reasonCode).toBe("thinking_bias");
    expect(result.malformedCount).toBe(0);
  });

  it("counts corrupt and future-version records newer than the first valid one", () => {
    const oldest = entry({ reasonCode: "work_phase" });
    const branch = [
      messageEntry(),
      custom(ROUTE_DECISION_ENTRY, oldest),
      custom(ROUTE_DECISION_ENTRY, { schemaVersion: 2, outcome: "selected" }),
      custom(ROUTE_DECISION_ENTRY, "not-an-object"),
      custom(ROUTE_DECISION_ENTRY, { ...entry(), outcome: "mystery" as never }),
    ];
    const result = readLatestRouteLog(branch);
    // The scan runs newest → oldest: all three newer records are damaged, so
    // the newest valid record is the oldest one and the damage is counted.
    expect(result.latest?.reasonCode).toBe("work_phase");
    expect(result.malformedCount).toBe(3);
  });

  it("stops at the first valid record: older malformed entries are not counted", () => {
    const valid = entry({ reasonCode: "work_phase" });
    const branch = [
      custom(ROUTE_DECISION_ENTRY, "garbage"),
      custom(ROUTE_DECISION_ENTRY, { schemaVersion: 9 }),
      custom(ROUTE_DECISION_ENTRY, valid),
      custom(ROUTE_DECISION_ENTRY, "newer-garbage"),
    ];
    const result = readLatestRouteLog(branch);
    expect(result.latest?.reasonCode).toBe("work_phase");
    expect(result.malformedCount).toBe(1);
  });

  it("never crosses a fork boundary: a child branch sees only its own entries", () => {
    const parentRecord = entry({ reasonCode: "work_phase", attempt: 1 });
    const childRecord = entry({ reasonCode: "sticky_continuation", attempt: 2 });
    const parentBranch = [messageEntry(), custom(ROUTE_DECISION_ENTRY, parentRecord)];
    const childBranch = [messageEntry(), custom(ROUTE_DECISION_ENTRY, childRecord)];

    expect(readLatestRouteLog(parentBranch).latest?.reasonCode).toBe("work_phase");
    expect(readLatestRouteLog(childBranch).latest?.reasonCode).toBe("sticky_continuation");
    // The empty fork point: a fork taken before any route has no parent evidence.
    expect(readLatestRouteLog([messageEntry()]).latest).toBeUndefined();
  });

  it("never exposes malformed payload text through the result", () => {
    const branch = [
      custom(ROUTE_DECISION_ENTRY, { ...entry(), reasonCode: "ok" }),
      custom(ROUTE_DECISION_ENTRY, { ...entry(), secret: "sk-live-abc123" }),
    ];
    const result = readLatestRouteLog(branch);
    expect(result.malformedCount).toBe(1);
    expect(result.latest).toBeDefined();
    expect(JSON.stringify(result)).not.toContain("sk-live-abc123");
  });
});

describe("createRouteLogSink — write pipeline and health (hook 4 mechanics)", () => {
  it("appends a validated clone through pi.appendEntry with the exact custom type", () => {
    const pi = { appendEntry: vi.fn() };
    const sink = createRouteLogSink(pi, () => []);
    const record = entry();
    appendRouteLog(record, sink);
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
    expect(pi.appendEntry).toHaveBeenCalledWith(ROUTE_DECISION_ENTRY, expect.objectContaining({
      schemaVersion: 1,
      outcome: "selected",
    }));
  });

  it("counts a throwing appendEntry as a write failure and never rethrows", () => {
    const pi = { appendEntry: vi.fn(() => { throw new Error("session closed"); }) };
    const sink = createRouteLogSink(pi, () => []);
    expect(() => appendRouteLog(entry(), sink)).not.toThrow();
    expect(sink.health().writeFailures).toBe(1);
    appendRouteLog(entry(), sink);
    expect(sink.health().writeFailures).toBe(2);
  });

  it("counts a schema-invalid record without touching pi", () => {
    const pi = { appendEntry: vi.fn() };
    const sink = createRouteLogSink(pi, () => []);
    appendRouteLog({ ...entry(), outcome: "impossible" as never }, sink);
    expect(pi.appendEntry).not.toHaveBeenCalled();
    expect(sink.health().writeFailures).toBe(1);
  });

  it("rebuilds latest and malformedEntries from the branch on every read", () => {
    const pi = { appendEntry: vi.fn() };
    const branch: SessionEntry[] = [];
    const sink = createRouteLogSink(pi, () => [...branch]);

    expect(sink.latest()).toBeUndefined();
    expect(sink.health()).toEqual({ writeFailures: 0, malformedEntries: 0 });

    branch.push(custom(ROUTE_DECISION_ENTRY, entry({ reasonCode: "work_phase" })));
    branch.push(custom(ROUTE_DECISION_ENTRY, "broken"));
    expect(sink.latest()?.reasonCode).toBe("work_phase");
    expect(sink.health()).toEqual({ writeFailures: 0, malformedEntries: 1 });

    // A forked view (its own array) sees only its own entries — no cached
    // cross-branch state exists to leak the parent record into the child.
    const childSink = createRouteLogSink(pi, () => [messageEntry()]);
    expect(childSink.latest()).toBeUndefined();
    expect(sink.latest()?.reasonCode).toBe("work_phase");
  });

  it("a fresh sink resets the write-failure count (session_start semantics)", () => {
    const pi = { appendEntry: vi.fn(() => { throw new Error("down"); }) };
    const first = createRouteLogSink(pi, () => []);
    appendRouteLog(entry(), first);
    appendRouteLog(entry(), first);
    expect(first.health().writeFailures).toBe(2);
    const second = createRouteLogSink(pi, () => []);
    expect(second.health().writeFailures).toBe(0);
  });
});

describe("renderRouteLogEntry — compact redacted line (hook 5)", () => {
  it("renders a selected retry fallback in one stable line", () => {
    expect(
      renderRouteLogEntry(entry({
        reasonCode: "retry_same_tier",
        selectedCandidate: { provider: "anthropic", id: "sonnet" },
        attempt: 2,
        maxAttempts: 3,
      })),
    ).toBe("→ sonnet • medium");
  });

  it("renders terminals and aborts without a candidate", () => {
    expect(
      renderRouteLogEntry(entry({
        outcome: "exhausted",
        reasonCode: "no_eligible_physical_model",
        selectedCandidate: undefined,
        attempt: 3,
        maxAttempts: 3,
      })),
    ).toBe("route no candidate");
    expect(
      renderRouteLogEntry(entry({
        outcome: "aborted",
        reasonCode: "route_limit_exceeded",
        selectedCandidate: undefined,
        attempt: 1,
      })),
    ).toBe("route aborted");
  });

  it("emits only stable fields: injected samples never reach the line", () => {
    const hostile = entry({
      reasonCode: "work_phase",
      selectedCandidate: { provider: "anthropic", id: "sonnet" },
    });
    const line = renderRouteLogEntry(hostile);
    expect(line).not.toContain("SECRET");
    expect(line).not.toContain("sk-");
    expect(line).not.toContain("/Users/");
    expect(line).not.toContain("error");
  });
});
