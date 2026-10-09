import { describe, expect, it } from "vitest";
import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

import {
  classifyFailure,
  inspectRouteFailure,
  routeRequest,
  RoutingError,
  type EffectiveConfig,
  type RouteRequest,
} from "../../src/routing";
import type { FailureClass, FailureInput } from "../../src/routing/failure";
import type { CatalogResolution } from "../../src/catalog";
import type { LoadResult, TierName } from "../../src/config/types";
import {
  abortedRouteLogEntry,
  exhaustedRouteLogEntry,
  selectedRouteLogEntry,
} from "../../src/extension";
import {
  readLatestRouteLog,
  renderRouteLogEntry,
  validateRouteLogEntry,
  ROUTE_DECISION_ENTRY,
  type RouteLogEntry,
} from "../../src/diag/route-log";
import {
  buildDoctorReport,
  renderDoctorReport,
  type DoctorSnapshot,
  type RouterStateInspection,
} from "../../src/diag/doctor";
import { buildTsStatus, renderTsStatus } from "../../src/commands/status";
import type { LastDispatchSummary } from "../../src/commands/types";

/**
 * Release-grade redaction sweep (08-release.md §3.3 closing paragraph): the
 * same secret/raw sentinel set is injected through all thirteen corpus
 * evaluation paths, and none of the six release outlets may ever contain a
 * sentinel byte:
 *   1. FailureAssessment (classifyFailure)
 *   2. RouteReason (a routing decision's reason block)
 *   3. RouteFailureContext (the safe context on a terminal RoutingError)
 *   4. route-log payload (entry JSON, validation round-trip, rendered line)
 *   5. doctor report (findings JSON + rendered text)
 *   6. command text (/ts status renderer)
 */

/** One shared sentinel set across every corpus case. */
const SENTINELS = [
  "sk-live-REDAX-999",
  "/Users/alice/REDAX/secret",
  "anthropic/claude-REDAX",
  "Bearer REDAX-TOKEN-42",
  "RAW-REDAX-STOP",
] as const;

function assertNoLeak(value: unknown, note: string): void {
  const serialized = JSON.stringify(value) ?? "undefined";
  for (const sentinel of SENTINELS) {
    expect(serialized, `${note}: leaked "${sentinel}"`).not.toContain(sentinel);
  }
}

// ---------------------------------------------------------------------------
// Routing harness (same shape as tests/routing/retry.test.ts, no real registry)
// ---------------------------------------------------------------------------

function model(provider: string, id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id,
    name: `${provider}/${id}`,
    api: "openai-completions",
    provider,
    baseUrl: "https://example.test",
    input: ["text"],
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    reasoning: true,
    contextWindow: 100_000,
    maxTokens: 8_000,
    ...overrides,
  };
}

function context(available: readonly Model<Api>[]): ExtensionContext {
  return { modelRegistry: {
    getAvailable: () => [...available],
    find: (provider: string, id: string) =>
      available.find((entry) => entry.provider === provider && entry.id === id),
  }, sessionManager: { getBranch: () => [] } } as unknown as ExtensionContext;
}

function config(
  retry: EffectiveConfig["retry"] = { maxAttemptsPerRequest: 3, maxTierSwitches: 2 },
  pillarCandidates: EffectiveConfig["tiers"]["pillar"]["candidates"] = [
    { provider: "acme", id: "first" },
    { provider: "acme", id: "second" },
    { provider: "beta", id: "first" },
  ],
): EffectiveConfig {
  return {
    schemaVersion: 1,
    tiers: {
      brain: { candidates: [{ provider: "acme", id: "brain-1" }] },
      pillar: { candidates: pillarCandidates },
      crowd: { candidates: [] },
    },
    policy: { defaultBias: "medium", sticky: true },
    retry,
    provenance: {},
  };
}

const VIRTUAL = model("ts", "auto", { api: "pi-virtual" });
const FIRST = model("acme", "first");
const SECOND = model("acme", "second");
const BETA = model("beta", "first");
// Strictly larger envelope so the capacity classes have a legal escalation.
const BRAIN = model("acme", "brain-1", { contextWindow: 200_000, maxTokens: 16_384 });
const REGISTRY: readonly Model<Api>[] = [FIRST, SECOND, BETA, BRAIN];

/** Single-candidate pillar: forces the cross-tier desire the tier-bound case blocks. */
const SINGLE_PILLAR = [{ provider: "acme", id: "first" }];

function userRequest(): RouteRequest {
  const message: Message = { role: "user", content: "implement the change", timestamp: 0 };
  return {
    model: VIRTUAL,
    thinkingLevel: "medium",
    reason: "user",
    messages: [message],
  };
}

function retryRequest(
  state: RouteRequest["state"],
  input: CorpusCase,
): RouteRequest {
  const message: Message = { role: "user", content: "implement the change", timestamp: 0 };
  const failedMessage = {
    role: "assistant",
    content: [],
    api: FIRST.api,
    provider: FIRST.provider,
    model: FIRST.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: input.stopReason,
    ...(input.message === "" ? {} : { errorMessage: input.message }),
    rawStopReason: input.rawStopReason,
    timestamp: 0,
  } as AssistantMessage;
  return {
    model: VIRTUAL,
    thinkingLevel: "medium",
    reason: "retry",
    messages: [message],
    state,
    failed: { model: FIRST, message: failedMessage },
  };
}

// ---------------------------------------------------------------------------
// The thirteen corpus cases with the sentinel set injected (§3.3 table)
// ---------------------------------------------------------------------------

type CorpusOutcome = "selected" | "route_limit_exceeded" | "aborted_terminal";

type CorpusCase = {
  id: string;
  stopReason: FailureInput["stopReason"];
  message: string;
  rawStopReason?: string;
  failureClass: FailureClass;
  retry?: EffectiveConfig["retry"];
  pillarCandidates?: EffectiveConfig["tiers"]["pillar"]["candidates"];
  outcome: CorpusOutcome;
};

const CORPUS: readonly CorpusCase[] = [
  {
    id: "aborted",
    stopReason: "aborted",
    message: "user cancelled after sk-live-REDAX-999 was echoed from /Users/alice/REDAX/secret",
    failureClass: "aborted",
    outcome: "aborted_terminal",
  },
  {
    id: "context-overflow",
    stopReason: "error",
    message: "context length exceeded for anthropic/claude-REDAX with sk-live-REDAX-999",
    failureClass: "context_overflow",
    outcome: "selected",
  },
  {
    id: "output-limit",
    stopReason: "length",
    message: "",
    rawStopReason: "RAW-REDAX-STOP max output tokens (anthropic/claude-REDAX)",
    failureClass: "output_limit",
    outcome: "selected",
  },
  {
    id: "authentication",
    stopReason: "error",
    message: "403 unauthorized: invalid api key Bearer REDAX-TOKEN-42 for anthropic/claude-REDAX",
    failureClass: "authentication",
    outcome: "selected",
  },
  {
    id: "quota",
    stopReason: "error",
    message: "quota exceeded; spending limit reached for sk-live-REDAX-999",
    failureClass: "quota_exhausted",
    outcome: "selected",
  },
  {
    id: "rate-limit",
    stopReason: "error",
    message: "429 too many requests: rate limit on Bearer REDAX-TOKEN-42",
    failureClass: "rate_limited",
    outcome: "selected",
  },
  {
    id: "transient",
    stopReason: "error",
    message: "timed out via bad gateway (502) at /Users/alice/REDAX/secret",
    failureClass: "transient",
    outcome: "selected",
  },
  {
    id: "invalid-request",
    stopReason: "error",
    message: "bad request: unsupported parameter sk-live-REDAX-999",
    failureClass: "invalid_request",
    outcome: "selected",
  },
  {
    id: "provider-error",
    stopReason: "error",
    message: "stream broke after RAW-REDAX-STOP with Bearer REDAX-TOKEN-42",
    failureClass: "provider_error",
    outcome: "selected",
  },
  {
    id: "unknown",
    stopReason: undefined,
    message: "opaque provider condition mentioning anthropic/claude-REDAX",
    rawStopReason: "RAW-REDAX-STOP",
    failureClass: "unknown",
    outcome: "selected",
  },
  {
    id: "malformed-failure",
    stopReason: "future-stop-RAW-REDAX-STOP" as FailureInput["stopReason"],
    message: "",
    failureClass: "unknown",
    outcome: "selected",
  },
  {
    id: "attempt-bound",
    stopReason: "error",
    message: "rate limit 429 for sk-live-REDAX-999",
    failureClass: "rate_limited",
    retry: { maxAttemptsPerRequest: 1, maxTierSwitches: 0 },
    outcome: "route_limit_exceeded",
  },
  {
    id: "tier-bound",
    stopReason: "error",
    message: "overloaded upstream echoed /Users/alice/REDAX/secret",
    failureClass: "transient",
    retry: { maxAttemptsPerRequest: 3, maxTierSwitches: 0 },
    pillarCandidates: SINGLE_PILLAR,
    outcome: "route_limit_exceeded",
  },
];

/** Outlet 6: the /ts status renderer with the last dispatch fed from the route. */
function statusTextFor(entry: RouteLogEntry): string {
  const lastDispatch: LastDispatchSummary = {
    model: { provider: "acme", id: "second" },
    tier: "pillar",
    thinkingLevel: "medium",
    reasonCode: entry.reasonCode,
    selectedTier: "pillar",
    attempt: entry.attempt,
    maxAttempts: entry.maxAttempts,
    tierSwitches: entry.tierSwitches,
    maxTierSwitches: entry.maxTierSwitches,
  };
  const ctx = {
    model: VIRTUAL,
    sessionManager: { getBranch: () => [] },
  } as unknown as Parameters<typeof buildTsStatus>[0];
  const status = buildTsStatus(ctx, { thinkingLevel: "medium", config: undefined, lastDispatch });
  return renderTsStatus(status);
}

/** Outlet 5: doctor findings and rendered text over a hostile branch. */
function doctorRenderFor(entry: RouteLogEntry): { report: string; rendered: string } {
  const branch: SessionEntry[] = [
    {
      type: "custom",
      customType: ROUTE_DECISION_ENTRY,
      data: entry,
    } as unknown as SessionEntry,
  ];
  const read = readLatestRouteLog(branch);
  const loadResult: LoadResult = {
    effective: {
      schemaVersion: 1,
      tiers: {
        brain: { candidates: [{ provider: "acme", id: "brain-1" }] },
        pillar: { candidates: [{ provider: "acme", id: "first" }] },
        crowd: { candidates: [] },
      },
      policy: { defaultBias: "medium", sticky: true },
      retry: { maxAttemptsPerRequest: 3, maxTierSwitches: 2 },
      provenance: {},
    },
    problems: [],
    paths: { userPath: "/agent/tier-scheduler.json", projectPath: "/work/.pi/tier-scheduler.json" },
    layers: { user: "loaded", project: "missing" },
  };
  const tiers = (["brain", "pillar", "crowd"] as const).map(
    (tier: TierName): CatalogResolution["tiers"][TierName] => ({
      tier,
      configured: loadResult.effective.tiers[tier].candidates,
      candidates: loadResult.effective.tiers[tier].candidates.map((ref, index) => ({
        tier,
        configIndex: index,
        ref,
        key: `${ref.provider}\0${ref.id}`,
        model: model(ref.provider, ref.id),
      })),
      skipped: [],
    }),
  );
  const router: RouterStateInspection = {
    status: "valid",
    schemaVersion: 1,
    attempts: entry.attempt,
    maxAttempts: entry.maxAttempts,
    tierSwitches: entry.tierSwitches,
    maxTierSwitches: entry.maxTierSwitches,
    issueCodes: [],
  };
  const snapshot: DoctorSnapshot = {
    config: loadResult,
    catalog: { tiers: { brain: tiers[0], pillar: tiers[1], crowd: tiers[2] }, diagnostics: [], snapshotProblems: [] },
    credentialProviders: [{ provider: "acme", status: "configured", source: "environment" }],
    router,
    routeLog: { ...read, writeFailures: 0, entryCount: 1 },
    compatibility: { runtimeVersion: "1.0.4", minimumVersion: "1.0.4", versionStatus: "pass", missingApis: [] },
  };
  return { report: JSON.stringify(buildDoctorReport(snapshot)), rendered: renderDoctorReport(buildDoctorReport(snapshot)) };
}

describe("release redaction sweep — thirteen corpus cases × six outlets (§3.3)", () => {
  it.each(CORPUS)("$id: no sentinel byte reaches any outlet", (corpus) => {
    // ---- Outlet 1: FailureAssessment
    const assessment = classifyFailure({
      stopReason: corpus.stopReason,
      ...(corpus.message === "" ? {} : { errorMessage: corpus.message }),
      ...(corpus.rawStopReason === undefined ? {} : { rawStopReason: corpus.rawStopReason }),
    });
    expect(assessment.failureClass, `${corpus.id}: class`).toBe(corpus.failureClass);
    assertNoLeak(assessment, `${corpus.id} FailureAssessment`);

    // ---- Outlet 2 + 3: RouteReason on the decision, RouteFailureContext on the throw
    const cfg = config(corpus.retry, corpus.pillarCandidates);
    const initial = routeRequest(userRequest(), context(REGISTRY), { config: cfg });
    assertNoLeak(initial.reason, `${corpus.id} RouteReason (initial)`);

    let entry: RouteLogEntry;
    try {
      const retry = routeRequest(retryRequest(initial.state, corpus), context(REGISTRY), { config: cfg });
      assertNoLeak(retry.reason, `${corpus.id} RouteReason (retry)`);
      assertNoLeak(retry.state, `${corpus.id} RouterState (retry)`);

      // ---- Outlet 4: route-log payload (selected leg)
      entry = selectedRouteLogEntry(retryRequest(initial.state, corpus), retry, cfg);
    } catch (error) {
      expect(error, `${corpus.id}: terminal must be a RoutingError`).toBeInstanceOf(RoutingError);
      const failureContext = inspectRouteFailure(error);
      if (corpus.outcome === "aborted_terminal") {
        // The abort terminal is deliberately context-free (06 §3.3): no
        // budget consumed, state unchanged, nothing to carry.
        expect(failureContext, `${corpus.id}: abort terminal carries no context`).toBeUndefined();
      } else {
        expect(failureContext, `${corpus.id}: terminal carries the safe context`).toBeDefined();
        // ---- Outlet 3: RouteFailureContext
        assertNoLeak(failureContext, `${corpus.id} RouteFailureContext`);
      }
      const routingError = error as RoutingError;
      expect(`${routingError.code}: ${routingError.message}`).not.toMatch(/sk-live|REDAX/);
      if (corpus.outcome === "aborted_terminal") {
        entry = abortedRouteLogEntry(retryRequest(initial.state, corpus), routingError, cfg);
        expect(entry.outcome).toBe("aborted");
      } else {
        entry = exhaustedRouteLogEntry(
          retryRequest(initial.state, corpus),
          routingError,
          failureContext!,
          cfg,
        );
        expect(entry.outcome).toBe("exhausted");
      }
    }

    // ---- Outlet 4 (full): payload JSON, validation round-trip, rendered line
    const expectedOutcome =
      corpus.outcome === "selected" ? "selected" : corpus.outcome === "aborted_terminal" ? "aborted" : "exhausted";
    expect(entry.outcome, `${corpus.id}: route-log outcome`).toBe(expectedOutcome);
    assertNoLeak(entry, `${corpus.id} route-log payload`);
    const roundTrip = validateRouteLogEntry(JSON.parse(JSON.stringify(entry)));
    expect(roundTrip, `${corpus.id}: entry validates after a JSON round-trip`).toBeDefined();
    const line = renderRouteLogEntry(entry);
    assertNoLeak(line, `${corpus.id} route-log render`);
    for (const sentinel of SENTINELS) {
      expect(line, `${corpus.id} render leaked "${sentinel}"`).not.toContain(sentinel);
    }

    // ---- Outlet 5: doctor report (findings JSON + rendered text)
    const doctor = doctorRenderFor(entry);
    assertNoLeak(doctor.report, `${corpus.id} doctor report`);
    for (const sentinel of SENTINELS) {
      expect(doctor.rendered, `${corpus.id} doctor render leaked "${sentinel}"`).not.toContain(sentinel);
    }

    // ---- Outlet 6: /ts status command text
    const statusText = statusTextFor(entry);
    for (const sentinel of SENTINELS) {
      expect(statusText, `${corpus.id} status text leaked "${sentinel}"`).not.toContain(sentinel);
    }
  });

  it("hostile malformed route-log records never surface raw bytes through the read path", () => {
    const branch: SessionEntry[] = [
      {
        type: "custom",
        customType: ROUTE_DECISION_ENTRY,
        data: { schemaVersion: 1, outcome: "selected", rawDump: "sk-live-REDAX-999 /Users/alice/REDAX/secret" },
      } as unknown as SessionEntry,
      {
        type: "custom",
        customType: "some.other.extension",
        data: { errorMessage: "Bearer REDAX-TOKEN-42" },
      } as unknown as SessionEntry,
    ];
    const read = readLatestRouteLog(branch);
    assertNoLeak(read, "readLatestRouteLog over hostile branch");
    expect(read.latest).toBeUndefined();
    expect(read.malformedCount).toBe(1);
  });
});
