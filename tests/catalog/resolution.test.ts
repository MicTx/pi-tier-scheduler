/**
 * Catalog resolution tests (03-catalog.md §7.1, spec §5.1).
 *
 * Coverage of this file: candidateKey identity semantics, one-shot registry
 * snapshotting (single getAvailable sample, per-unique-ref find, fail-soft
 * problems), the six-code admission chain with deterministic ordering and
 * diagnostics, and the composite resolveCatalog entry. All consumption goes
 * through the catalog barrel so export-name conflicts surface here first.
 *
 * The fake registry is a plain in-memory object with call tracking (no mock
 * library); registry failures embed a secret marker that must appear in the
 * console.debug channel but never inside any catalog-produced record.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { candidateKey, resolveCatalog, resolveCatalogSnapshot, snapshotRegistry } from "../../src/catalog";
import { DEFAULT_CONFIG } from "../../src/config/defaults";
import { mergeConfig } from "../../src/config/merge";
import type {
  CandidateKey,
  CatalogRegistry,
  CatalogSnapshot,
  PhysicalChatModel,
  RegistrySnapshotProblem,
} from "../../src/catalog";
import type { CandidateRef, EffectiveConfig, TierName } from "../../src/config/types";

/** Marker embedded in fake registry exceptions and model headers. */
const SECRET = "sk-test-secret-marker";

beforeEach(() => {
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeModel(
  provider: string,
  id: string,
  overrides: Partial<PhysicalChatModel> = {},
): PhysicalChatModel {
  return {
    id,
    name: `${provider}/${id}`,
    api: "openai-completions",
    provider,
    baseUrl: "https://api.example.test/v1",
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    // Deliberately present: proves catalog records never copy credential-bearing fields.
    headers: { authorization: `Bearer ${SECRET}` },
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 16_384,
    ...overrides,
  };
}

/** Image-generation entry: `type: "image"` makes it a non-chat model. */
function fakeImageModel(provider: string, id: string): PhysicalChatModel {
  return {
    ...fakeModel(provider, id),
    type: "image",
    output: ["image"],
  } as unknown as PhysicalChatModel;
}

/**
 * Mirrors pi-coding-agent's `createVirtualModel`: sentinel api, no `type`
 * field (so it is chat-shaped for `isModelType`), empty base URL, zeroed
 * cost and windows. Virtual must therefore be checked before the chat gate.
 */
function fakeVirtualModel(provider: string, id: string): PhysicalChatModel {
  return fakeModel(provider, id, {
    api: "pi-virtual",
    baseUrl: "",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
    input: ["text", "image"],
  });
}

type FakeRegistrySpec = {
  /** Catalog entries find() returns, matched exactly by (provider, id). */
  models?: PhysicalChatModel[];
  /** Refs whose find() throws instead of returning. */
  findThrows?: CandidateRef[];
  /** Whether getAvailable() throws. */
  availableThrows?: boolean;
  /** Models the availability sample reports; defaults to all entries. */
  availableModels?: PhysicalChatModel[];
};

type FakeRegistry = CatalogRegistry & {
  calls: {
    find: Array<{ provider: string; id: string }>;
    getAvailable: number;
  };
};

function fakeRegistry(spec: FakeRegistrySpec = {}): FakeRegistry {
  const models = spec.models ?? [];
  const throwKeys = new Set((spec.findThrows ?? []).map(candidateKey));
  const calls: FakeRegistry["calls"] = { find: [], getAvailable: 0 };
  return {
    calls,
    find(provider, id) {
      calls.find.push({ provider, id });
      if (throwKeys.has(candidateKey({ provider, id }))) {
        throw new Error(`fake find failure ${provider}/${id}: ${SECRET}`);
      }
      return models.find((model) => model.provider === provider && model.id === id);
    },
    getAvailable() {
      calls.getAvailable += 1;
      if (spec.availableThrows) {
        throw new Error(`fake getAvailable failure: ${SECRET}`);
      }
      return spec.availableModels ?? models;
    },
  };
}

/** Real config machinery builds the effective config; no hand-rolled literals. */
function fakeConfig(tiers: Partial<Record<TierName, CandidateRef[]>> = {}): EffectiveConfig {
  return mergeConfig(DEFAULT_CONFIG, {
    schemaVersion: 1,
    tiers: {
      brain: { candidates: tiers.brain ?? [] },
      pillar: { candidates: tiers.pillar ?? [] },
      crowd: { candidates: tiers.crowd ?? [] },
    },
  });
}

/** Snapshot text of catalog-produced records; never touches model objects. */
function recordText(...records: unknown[]): string {
  return JSON.stringify(records);
}

describe("candidateKey (03-catalog §3.1)", () => {
  it("concatenates provider and id with a NUL separator", () => {
    expect(candidateKey({ provider: "acme", id: "gpt-5" })).toBe("acme\0gpt-5");
  });

  it("never collides across a field boundary", () => {
    expect(candidateKey({ provider: "a/b", id: "c" })).not.toBe(
      candidateKey({ provider: "a", id: "b/c" }),
    );
    expect(candidateKey({ provider: "a/b", id: "c" })).toBe("a/b\0c");
    expect(candidateKey({ provider: "a", id: "b/c" })).toBe("a\0b/c");
  });
});

describe("snapshotRegistry (03-catalog §3.1/§5.1)", () => {
  it("samples getAvailable() exactly once and keys the available set by candidate identity", () => {
    const model = fakeModel("acme", "one");
    const registry = fakeRegistry({ models: [model] });
    const config = fakeConfig({ brain: [{ provider: "acme", id: "one" }] });

    const snapshot = snapshotRegistry(config, registry);

    expect(registry.calls.getAvailable).toBe(1);
    expect(snapshot.available).toEqual(new Set([candidateKey(model)]));
    expect(snapshot.problems).toEqual([]);
  });

  it("looks each unique ref up exactly once, deduplicated across tiers and repeats", () => {
    const one = fakeModel("acme", "one");
    const two = fakeModel("beta", "two");
    const registry = fakeRegistry({ models: [one, two] });
    const config = fakeConfig({
      brain: [
        { provider: "acme", id: "one" },
        { provider: "acme", id: "one" },
      ],
      crowd: [
        { provider: "acme", id: "one" },
        { provider: "beta", id: "two" },
      ],
    });

    const snapshot = snapshotRegistry(config, registry);

    expect(registry.calls.find).toEqual([
      { provider: "acme", id: "one" },
      { provider: "beta", id: "two" },
    ]);
    expect(snapshot.models.size).toBe(2);
    expect(snapshot.models.get(candidateKey({ provider: "acme", id: "one" }))).toBe(one);
    expect(snapshot.models.get(candidateKey({ provider: "beta", id: "two" }))).toBe(two);
  });

  it("keeps an entry for every unique ref, including ones the registry cannot find", () => {
    const one = fakeModel("acme", "one");
    const registry = fakeRegistry({ models: [one] });
    const config = fakeConfig({
      brain: [{ provider: "acme", id: "one" }, { provider: "acme", id: "missing" }],
    });

    const snapshot = snapshotRegistry(config, registry);

    expect(snapshot.models.get(candidateKey({ provider: "acme", id: "missing" }))).toBeUndefined();
    expect(snapshot.models.size).toBe(2);
    expect(snapshot.problems).toEqual([]);
  });

  it("records an availability problem with an empty available set when getAvailable() throws, and still looks refs up", () => {
    const one = fakeModel("acme", "one");
    const registry = fakeRegistry({ models: [one], availableThrows: true });
    const config = fakeConfig({ brain: [{ provider: "acme", id: "one" }] });

    const snapshot = snapshotRegistry(config, registry);

    expect(snapshot.problems).toEqual([{ operation: "availability_snapshot" }]);
    expect(snapshot.available.size).toBe(0);
    expect(snapshot.models.get(candidateKey({ provider: "acme", id: "one" }))).toBe(one);
    expect(registry.calls.find).toEqual([{ provider: "acme", id: "one" }]);
  });

  it("records a ref-addressed problem when find() throws, without affecting other refs", () => {
    const two = fakeModel("beta", "two");
    const boom = { provider: "acme", id: "boom" };
    const registry = fakeRegistry({
      models: [two],
      findThrows: [boom],
    });
    const config = fakeConfig({
      brain: [boom, { provider: "beta", id: "two" }, { provider: "acme", id: "missing" }],
    });

    const snapshot = snapshotRegistry(config, registry);

    expect(snapshot.problems).toEqual([{ operation: "model_lookup", ref: boom }]);
    expect(snapshot.models.get(candidateKey(boom))).toBeUndefined();
    expect(snapshot.models.get(candidateKey({ provider: "beta", id: "two" }))).toBe(two);
    expect(snapshot.models.get(candidateKey({ provider: "acme", id: "missing" }))).toBeUndefined();
    expect(snapshot.available).toEqual(new Set([candidateKey(two)]));
    expect(registry.calls.find).toHaveLength(3);
  });

  it("routes raw exception text only to console.debug, never into snapshot records", () => {
    const registry = fakeRegistry({
      models: [fakeModel("acme", "one")],
      findThrows: [{ provider: "acme", id: "boom" }],
      availableThrows: true,
    });
    const config = fakeConfig({
      brain: [
        { provider: "acme", id: "boom" },
        { provider: "acme", id: "one" },
      ],
    });

    const snapshot = snapshotRegistry(config, registry);

    expect(recordText(snapshot.problems, [...snapshot.available])).not.toContain(SECRET);
    const debugText = vi
      .mocked(console.debug)
      .mock.calls.map((call) => call.map(String).join(" "))
      .join("\n");
    expect(debugText).toContain(SECRET);
    expect(console.debug).toHaveBeenCalledTimes(2);
  });
});

/** Hand-built snapshot for precise admission fixtures; keys derived by candidateKey. */
function snapshotOf(
  models: PhysicalChatModel[],
  spec: { available?: string[]; miss?: CandidateRef[]; problems?: RegistrySnapshotProblem[] } = {},
): CatalogSnapshot {
  const entries = new Map<CandidateKey, PhysicalChatModel | undefined>();
  for (const model of models) {
    entries.set(candidateKey(model), model);
  }
  for (const ref of spec.miss ?? []) {
    entries.set(candidateKey(ref), undefined);
  }
  return {
    models: entries,
    available: new Set(spec.available ?? models.map(candidateKey)),
    problems: spec.problems ?? [],
  };
}

describe("resolveCatalogSnapshot (03-catalog §3.2/§5.2)", () => {
  it("admits an available physical chat model and keeps every tier structurally complete", () => {
    const model = fakeModel("acme", "one");
    const config = fakeConfig({ brain: [{ provider: "acme", id: "one" }] });
    const snapshot = snapshotOf([model]);

    const resolution = resolveCatalogSnapshot(snapshot, config);

    expect(resolution.tiers.brain).toEqual({
      tier: "brain",
      configured: [{ provider: "acme", id: "one" }],
      candidates: [
        {
          tier: "brain",
          configIndex: 0,
          ref: { provider: "acme", id: "one" },
          key: "acme\0one",
          model,
        },
      ],
      skipped: [],
    });
    // The config's candidates array is referenced verbatim; the SDK model too.
    expect(resolution.tiers.brain.configured).toBe(config.tiers.brain.candidates);
    expect(resolution.tiers.brain.candidates[0]?.model).toBe(model);
    expect(resolution.tiers.pillar).toEqual({ tier: "pillar", configured: [], candidates: [], skipped: [] });
    expect(resolution.tiers.crowd).toEqual({ tier: "crowd", configured: [], candidates: [], skipped: [] });
    expect(resolution.diagnostics).toEqual([
      { tier: "pillar", code: "tier_empty", severity: "info" },
      { tier: "crowd", code: "tier_empty", severity: "info" },
    ]);
    expect(resolution.snapshotProblems).toEqual([]);
  });

  it("maps every candidate to its first applicable code in the fixed admission order", () => {
    const notFoundRef = { provider: "acme", id: "ghost" };
    const lookupRef = { provider: "acme", id: "boom" };
    const mismatchRef = { provider: "acme", id: "alias" };
    const virtualRef = { provider: "acme", id: "auto" };
    const imageRef = { provider: "acme", id: "draw" };
    const unavailableRef = { provider: "beta", id: "busy" };

    // The alias target is itself virtual: proves identity-mismatch fires before
    // the virtual check.
    const aliasedVirtual = fakeVirtualModel("acme", "canonical");
    const virtualModel = fakeVirtualModel("acme", "auto");
    const imageModel = fakeImageModel("acme", "draw");
    const unavailableModel = fakeModel("beta", "busy");

    const snapshot: CatalogSnapshot = {
      models: new Map([
        [candidateKey(mismatchRef), aliasedVirtual],
        [candidateKey(virtualRef), virtualModel],
        [candidateKey(imageRef), imageModel],
        [candidateKey(unavailableRef), unavailableModel],
        [candidateKey(notFoundRef), undefined],
        [candidateKey(lookupRef), undefined],
      ]),
      // Only the virtual candidate is marked available: a wrong check order
      // (availability before virtual/non-chat) would admit or miscode it.
      available: new Set([candidateKey(virtualRef)]),
      problems: [{ operation: "model_lookup", ref: lookupRef }],
    };

    const config = fakeConfig({
      brain: [notFoundRef, lookupRef, mismatchRef],
      pillar: [virtualRef, imageRef, unavailableRef],
    });

    const resolution = resolveCatalogSnapshot(snapshot, config);

    expect(resolution.tiers.brain.candidates).toEqual([]);
    expect(resolution.tiers.pillar.candidates).toEqual([]);
    expect(resolution.tiers.crowd.candidates).toEqual([]);
    expect(resolution.diagnostics).toEqual([
      { tier: "brain", code: "tier_exhausted", severity: "warning" },
      { tier: "brain", candidateIndex: 0, ref: notFoundRef, code: "candidate_not_found", severity: "warning" },
      {
        tier: "brain",
        candidateIndex: 1,
        ref: lookupRef,
        code: "candidate_lookup_failed",
        severity: "error",
        operation: "model_lookup",
      },
      { tier: "brain", candidateIndex: 2, ref: mismatchRef, code: "candidate_identity_mismatch", severity: "warning" },
      { tier: "pillar", code: "tier_exhausted", severity: "warning" },
      { tier: "pillar", candidateIndex: 0, ref: virtualRef, code: "candidate_virtual_model", severity: "info" },
      { tier: "pillar", candidateIndex: 1, ref: imageRef, code: "candidate_non_chat_model", severity: "warning" },
      { tier: "pillar", candidateIndex: 2, ref: unavailableRef, code: "candidate_not_available", severity: "warning" },
      { tier: "crowd", code: "tier_empty", severity: "info" },
    ]);
    // Tier-level records never land in skipped.
    expect(resolution.tiers.brain.skipped.map((diagnostic) => diagnostic.code)).toEqual([
      "candidate_not_found",
      "candidate_lookup_failed",
      "candidate_identity_mismatch",
    ]);
    expect(resolution.tiers.pillar.skipped.map((diagnostic) => diagnostic.code)).toEqual([
      "candidate_virtual_model",
      "candidate_non_chat_model",
      "candidate_not_available",
    ]);
    expect(resolution.tiers.crowd.skipped).toEqual([]);
    expect(resolution.snapshotProblems).toBe(snapshot.problems);
  });

  it("keeps admitted candidates in authored order with their config indexes", () => {
    const first = fakeModel("acme", "one");
    const second = fakeModel("beta", "two");
    const third = fakeModel("gamma", "three");
    const snapshot = snapshotOf([first, second, third]);
    const config = fakeConfig({
      crowd: [
        { provider: "gamma", id: "three" },
        { provider: "acme", id: "one" },
        { provider: "beta", id: "two" },
      ],
    });

    const resolution = resolveCatalogSnapshot(snapshot, config);

    const admitted = resolution.tiers.crowd.candidates;
    expect(admitted.map((candidate) => [candidate.ref.id, candidate.configIndex, candidate.tier])).toEqual([
      ["three", 0, "crowd"],
      ["one", 1, "crowd"],
      ["two", 2, "crowd"],
    ]);
    expect(admitted[0]?.model).toBe(third);
    expect(admitted[1]?.model).toBe(first);
    expect(admitted[2]?.model).toBe(second);
    expect(resolution.tiers.crowd.skipped).toEqual([]);
    expect(resolution.diagnostics).toEqual([
      { tier: "brain", code: "tier_empty", severity: "info" },
      { tier: "pillar", code: "tier_empty", severity: "info" },
    ]);
  });

  it("admits the same ref in two tiers without dedup and keeps per-tier skip records", () => {
    const shared = fakeModel("acme", "shared");
    const missing = { provider: "acme", id: "missing" };
    const snapshot = snapshotOf([shared], { miss: [missing] });
    const config = fakeConfig({
      brain: [missing, { provider: "acme", id: "shared" }],
      pillar: [missing, { provider: "acme", id: "shared" }],
    });

    const resolution = resolveCatalogSnapshot(snapshot, config);

    expect(resolution.tiers.brain.candidates.map((candidate) => candidate.tier)).toEqual(["brain"]);
    expect(resolution.tiers.pillar.candidates.map((candidate) => candidate.tier)).toEqual(["pillar"]);
    expect(resolution.tiers.brain.candidates[0]?.configIndex).toBe(1);
    expect(resolution.tiers.pillar.candidates[0]?.configIndex).toBe(1);
    expect(resolution.tiers.brain.candidates[0]?.model).toBe(shared);
    expect(resolution.tiers.pillar.candidates[0]?.model).toBe(shared);
    expect(resolution.diagnostics).toEqual([
      { tier: "brain", candidateIndex: 0, ref: missing, code: "candidate_not_found", severity: "warning" },
      { tier: "pillar", candidateIndex: 0, ref: missing, code: "candidate_not_found", severity: "warning" },
      { tier: "crowd", code: "tier_empty", severity: "info" },
    ]);
  });

  it("resolves an empty config into three tier_empty diagnostics and complete tiers", () => {
    const config = fakeConfig();
    const snapshot = snapshotOf([]);

    const resolution = resolveCatalogSnapshot(snapshot, config);

    expect(Object.keys(resolution.tiers)).toEqual(["brain", "pillar", "crowd"]);
    expect(resolution.diagnostics).toEqual([
      { tier: "brain", code: "tier_empty", severity: "info" },
      { tier: "pillar", code: "tier_empty", severity: "info" },
      { tier: "crowd", code: "tier_empty", severity: "info" },
    ]);
    expect(resolution.tiers.brain.candidates).toEqual([]);
    expect(resolution.tiers.brain.configured).toEqual([]);
  });

  it("does not mutate the config, the snapshot, or the model objects", () => {
    const model = fakeModel("acme", "one");
    const config = fakeConfig({ brain: [{ provider: "acme", id: "one" }] });
    const snapshot = snapshotOf([model]);
    const configClone = structuredClone(config);
    const snapshotClone = structuredClone(snapshot);
    const modelClone = structuredClone(model);

    resolveCatalogSnapshot(snapshot, config);

    expect(config).toEqual(configClone);
    expect(snapshot).toEqual(snapshotClone);
    expect(model).toEqual(modelClone);
  });
});

describe("resolveCatalog (03-catalog §6.2)", () => {
  it("composes snapshot + resolve and samples availability exactly once", () => {
    const one = fakeModel("acme", "one");
    const two = fakeModel("beta", "two");
    const registry = fakeRegistry({ models: [one, two], availableModels: [one] });
    const config = fakeConfig({
      brain: [
        { provider: "acme", id: "one" },
        { provider: "beta", id: "two" },
      ],
    });

    const resolution = resolveCatalog(config, registry);

    expect(registry.calls.getAvailable).toBe(1);
    expect(registry.calls.find).toEqual([
      { provider: "acme", id: "one" },
      { provider: "beta", id: "two" },
    ]);
    expect(resolution).toEqual(resolveCatalogSnapshot(snapshotRegistry(config, registry), config));
    expect(resolution.tiers.brain.candidates.map((candidate) => candidate.key)).toEqual(["acme\0one"]);
    expect(resolution.tiers.brain.candidates[0]?.configIndex).toBe(0);
    expect(resolution.tiers.brain.candidates[0]?.model).toBe(one);
    // found but not available -> candidate_not_available, no credentials copied
    expect(resolution.tiers.brain.skipped).toEqual([
      {
        tier: "brain",
        candidateIndex: 1,
        ref: { provider: "beta", id: "two" },
        code: "candidate_not_available",
        severity: "warning",
      },
    ]);
  });

  it("keeps resolution structurally complete when the registry snapshot fails (03-catalog §5.4)", () => {
    const found = fakeModel("acme", "found");
    const boom = { provider: "acme", id: "boom" };
    const missing = { provider: "acme", id: "missing" };
    const registry = fakeRegistry({
      models: [found],
      findThrows: [boom],
      availableThrows: true,
    });
    const config = fakeConfig({
      brain: [{ provider: "acme", id: "found" }, boom, missing],
    });

    const resolution = resolveCatalog(config, registry);

    expect(registry.calls.getAvailable).toBe(1);
    expect(Object.keys(resolution.tiers)).toEqual(["brain", "pillar", "crowd"]);
    expect(resolution.tiers.brain.candidates).toEqual([]);
    expect(resolution.snapshotProblems).toEqual([
      { operation: "availability_snapshot" },
      { operation: "model_lookup", ref: boom },
    ]);
    expect(resolution.diagnostics).toEqual([
      {
        tier: "brain",
        code: "registry_snapshot_failed",
        severity: "error",
        operation: "availability_snapshot",
      },
      { tier: "brain", code: "tier_exhausted", severity: "warning" },
      {
        tier: "brain",
        candidateIndex: 0,
        ref: { provider: "acme", id: "found" },
        code: "candidate_not_available",
        severity: "warning",
      },
      {
        tier: "brain",
        candidateIndex: 1,
        ref: boom,
        code: "candidate_lookup_failed",
        severity: "error",
        operation: "model_lookup",
      },
      {
        tier: "brain",
        candidateIndex: 2,
        ref: missing,
        code: "candidate_not_found",
        severity: "warning",
      },
      {
        tier: "pillar",
        code: "registry_snapshot_failed",
        severity: "error",
        operation: "availability_snapshot",
      },
      { tier: "pillar", code: "tier_empty", severity: "info" },
      {
        tier: "crowd",
        code: "registry_snapshot_failed",
        severity: "error",
        operation: "availability_snapshot",
      },
      { tier: "crowd", code: "tier_empty", severity: "info" },
    ]);
  });

  it("keeps credential and exception text out of every catalog-produced record", () => {
    const model = fakeModel("acme", "one");
    const boom = { provider: "acme", id: "boom" };
    const registry = fakeRegistry({
      models: [model],
      findThrows: [boom],
      availableThrows: true,
    });
    const config = fakeConfig({
      brain: [boom, { provider: "acme", id: "one" }],
    });

    const resolution = resolveCatalog(config, registry);

    // All candidates are skipped here, so the whole resolution is safe to
    // serialize: nothing in it may carry the fake credentials or raw errors.
    expect(recordText(resolution)).not.toContain(SECRET);
    const debugText = vi
      .mocked(console.debug)
      .mock.calls.map((call) => call.map(String).join(" "))
      .join("\n");
    expect(debugText).toContain(SECRET);
    expect(console.debug).toHaveBeenCalledTimes(2);
  });
});
