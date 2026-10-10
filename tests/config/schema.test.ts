import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../src/config/defaults";
import { validateConfigLayer, validateEffectiveConfig } from "../../src/config/schema";
import type { ConfigError } from "../../src/config/types";

type LayerResult = ReturnType<typeof validateConfigLayer>;
type EffectiveResult = ReturnType<typeof validateEffectiveConfig>;

/**
 * Asserts the result carries exactly one error with the given code and JSON
 * path, and returns it for field-level assertions.
 */
function expectError(
  result: LayerResult | EffectiveResult,
  code: ConfigError["code"],
  path: string,
): ConfigError {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  const matches = result.errors.filter((e) => e.code === code && e.path === path);
  expect(matches).toHaveLength(1);
  return matches[0];
}

function expectOk(result: LayerResult | EffectiveResult): void {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`unexpected errors: ${result.errors.map((e) => e.code).join(", ")}`);
}

describe("validateEffectiveConfig", () => {
  it("accepts the built-in defaults (§7.1 item 1)", () => {
    const result = validateEffectiveConfig(DEFAULT_CONFIG, "defaults");
    expectOk(result);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.schemaVersion).toBe(1);
    expect(result.value.tiers.brain.candidates).toEqual([]);
    expect(result.value.tiers.pillar.candidates).toEqual([]);
    expect(result.value.tiers.crowd.candidates).toEqual([]);
    expect(result.value.policy).toEqual({ defaultBias: "medium", sticky: true });
    expect(result.value.retry).toEqual({ maxAttemptsPerRequest: 3, maxTierSwitches: 2 });
  });

  it("accepts a fully populated effective config", () => {
    const result = validateEffectiveConfig(
      {
        schemaVersion: 1,
        tiers: {
          brain: { candidates: [{ provider: "anthropic", id: "claude-sonnet-4-1" }] },
          pillar: { candidates: [] },
          crowd: { candidates: [] },
        },
        policy: { defaultBias: "low", sticky: false },
        retry: { maxAttemptsPerRequest: 1, maxTierSwitches: 0 },
      },
      "merge",
    );
    expectOk(result);
  });

  it("rejects a provenance key at the root as an unknown key", () => {
    expectError(validateEffectiveConfig({ ...DEFAULT_CONFIG, provenance: {} }, "merge"), "UNKNOWN_KEY", "provenance");
  });

  it("collects every missing required section in one pass", () => {
    const result = validateEffectiveConfig({ schemaVersion: 1 }, "merge");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors.map((e) => e.path).sort()).toEqual(["policy", "retry", "tiers"]);
    expect(result.errors.every((e) => e.code === "TYPE_MISMATCH")).toBe(true);
    for (const err of result.errors) {
      expect(err.received).toBe("missing");
    }
  });
});

describe("validateConfigLayer", () => {
  it("accepts a minimal { schemaVersion: 1 } layer (§7.1 item 2)", () => {
    expectOk(validateConfigLayer({ schemaVersion: 1 }, "user"));
  });

  it("accepts a partial layer that only overrides policy.defaultBias (§7.1 item 2)", () => {
    const result = validateConfigLayer({ schemaVersion: 1, policy: { defaultBias: "low" } }, "user");
    expectOk(result);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.policy?.defaultBias).toBe("low");
  });

  it("accepts schemaVersion 1.0 as the integer 1", () => {
    expectOk(validateConfigLayer({ schemaVersion: 1.0 }, "user"));
  });

  it("preserves candidate order and allows the same model in different tiers (§7.1 item 4)", () => {
    const result = validateConfigLayer(
      {
        schemaVersion: 1,
        tiers: {
          brain: {
            candidates: [
              { provider: "anthropic", id: "claude" },
              { provider: "openai", id: "gpt" },
            ],
          },
          pillar: {
            candidates: [{ provider: "anthropic", id: "claude" }],
          },
        },
      },
      "user",
    );
    expectOk(result);
    if (!result.ok) throw new Error("unreachable");
    expect(
      result.value.tiers?.brain?.candidates?.map((c) => `${c.provider}/${c.id}`),
    ).toEqual(["anthropic/claude", "openai/gpt"]);
  });

  it("accepts ids that stay opaque outside the provider charset", () => {
    expectOk(
      validateConfigLayer(
        { schemaVersion: 1, tiers: { brain: { candidates: [{ provider: "anthropic", id: "claude/日本 v2" }] } } },
        "user",
      ),
    );
  });
});

describe("rejection matrix: schemaVersion (§7.1 item 3)", () => {
  it("rejects a missing schemaVersion with SCHEMA_VERSION_MISSING", () => {
    const err = expectError(validateConfigLayer({}, "user"), "SCHEMA_VERSION_MISSING", "schemaVersion");
    expect(err.source).toBe("user");
    expect(err.expected).toBe("integer 1");
    expect(err.received).toBe("missing");
  });

  it("rejects an unsupported integer schemaVersion", () => {
    const err = expectError(validateConfigLayer({ schemaVersion: 2 }, "user"), "SCHEMA_VERSION_UNSUPPORTED", "schemaVersion");
    expect(err.received).toBe("2");
    expect(err.message).toContain("supports");
  });

  it("rejects a non-integer numeric schemaVersion with INVALID_VALUE", () => {
    expectError(validateConfigLayer({ schemaVersion: 2.5 }, "user"), "INVALID_VALUE", "schemaVersion");
  });

  it("rejects a string schemaVersion with TYPE_MISMATCH", () => {
    const err = expectError(validateConfigLayer({ schemaVersion: "1" }, "user"), "TYPE_MISMATCH", "schemaVersion");
    expect(err.received).toBe('"1"');
  });

  it("rejects null and boolean schemaVersions with TYPE_MISMATCH", () => {
    expectError(validateConfigLayer({ schemaVersion: null }, "user"), "TYPE_MISMATCH", "schemaVersion");
    expectError(validateConfigLayer({ schemaVersion: true }, "user"), "TYPE_MISMATCH", "schemaVersion");
  });
});

describe("rejection matrix: root shape (§7.1 item 3)", () => {
  it("rejects non-object roots with TYPE_MISMATCH at the root path", () => {
    for (const raw of [[], "config", 42, true, null]) {
      const err = expectError(validateConfigLayer(raw, "user"), "TYPE_MISMATCH", "");
      expect(err.expected).toBe("object");
    }
  });

  it("rejects unknown root keys with UNKNOWN_KEY", () => {
    const err = expectError(validateConfigLayer({ schemaVersion: 1, extra: true }, "user"), "UNKNOWN_KEY", "extra");
    expect(err.source).toBe("user");
    expect(err.expected).toBe("one of schemaVersion, tiers, policy, retry");
  });

  it("rejects unknown tier keys", () => {
    expectError(
      validateConfigLayer({ schemaVersion: 1, tiers: { braiin: { candidates: [] } } }, "user"),
      "UNKNOWN_KEY",
      "tiers.braiin",
    );
  });
});

describe("rejection matrix: tiers and candidates (§7.1 item 3)", () => {
  it("rejects non-object tiers", () => {
    expectError(validateConfigLayer({ schemaVersion: 1, tiers: "brain" }, "user"), "TYPE_MISMATCH", "tiers");
    expectError(validateConfigLayer({ schemaVersion: 1, tiers: null }, "user"), "TYPE_MISMATCH", "tiers");
  });

  it("rejects unknown fields inside a tier", () => {
    expectError(
      validateConfigLayer({ schemaVersion: 1, tiers: { brain: { candidates: [], weight: 2 } } }, "user"),
      "UNKNOWN_KEY",
      "tiers.brain.weight",
    );
  });

  it("rejects a non-array candidates value", () => {
    expectError(
      validateConfigLayer({ schemaVersion: 1, tiers: { brain: { candidates: "auto" } } }, "user"),
      "TYPE_MISMATCH",
      "tiers.brain.candidates",
    );
    expectError(
      validateConfigLayer({ schemaVersion: 1, tiers: { brain: { candidates: null } } }, "user"),
      "TYPE_MISMATCH",
      "tiers.brain.candidates",
    );
  });

  it("rejects non-object candidates", () => {
    expectError(
      validateConfigLayer({ schemaVersion: 1, tiers: { brain: { candidates: ["auto"] } } }, "user"),
      "TYPE_MISMATCH",
      "tiers.brain.candidates[0]",
    );
    expectError(
      validateConfigLayer({ schemaVersion: 1, tiers: { brain: { candidates: [null] } } }, "user"),
      "TYPE_MISMATCH",
      "tiers.brain.candidates[0]",
    );
  });

  it("rejects missing or non-string provider", () => {
    expectError(
      validateConfigLayer({ schemaVersion: 1, tiers: { brain: { candidates: [{ id: "claude" }] } } }, "user"),
      "TYPE_MISMATCH",
      "tiers.brain.candidates[0].provider",
    );
    expectError(
      validateConfigLayer({ schemaVersion: 1, tiers: { brain: { candidates: [{ provider: 5, id: "claude" }] } } }, "user"),
      "TYPE_MISMATCH",
      "tiers.brain.candidates[0].provider",
    );
  });

  it("rejects empty provider and id with INVALID_VALUE", () => {
    expectError(
      validateConfigLayer({ schemaVersion: 1, tiers: { brain: { candidates: [{ provider: "", id: "claude" }] } } }, "user"),
      "INVALID_VALUE",
      "tiers.brain.candidates[0].provider",
    );
    expectError(
      validateConfigLayer({ schemaVersion: 1, tiers: { brain: { candidates: [{ provider: "anthropic", id: "" }] } } }, "user"),
      "INVALID_VALUE",
      "tiers.brain.candidates[0].id",
    );
  });

  it("rejects control characters in provider and id", () => {
    expectError(
      validateConfigLayer(
        { schemaVersion: 1, tiers: { brain: { candidates: [{ provider: "anth\rropic", id: "claude" }] } } },
        "user",
      ),
      "INVALID_VALUE",
      "tiers.brain.candidates[0].provider",
    );
    expectError(
      validateConfigLayer(
        { schemaVersion: 1, tiers: { brain: { candidates: [{ provider: "anthropic", id: "clau\u0000de" }] } } },
        "user",
      ),
      "INVALID_VALUE",
      "tiers.brain.candidates[0].id",
    );
  });

  it("rejects providers outside the conservative charset", () => {
    expectError(
      validateConfigLayer(
        { schemaVersion: 1, tiers: { brain: { candidates: [{ provider: "anthropic lab", id: "claude" }] } } },
        "user",
      ),
      "INVALID_VALUE",
      "tiers.brain.candidates[0].provider",
    );
    expectError(
      validateConfigLayer(
        { schemaVersion: 1, tiers: { brain: { candidates: [{ provider: "anthropic/日本", id: "claude" }] } } },
        "user",
      ),
      "INVALID_VALUE",
      "tiers.brain.candidates[0].provider",
    );
  });

  it("rejects unknown fields on a candidate", () => {
    expectError(
      validateConfigLayer(
        { schemaVersion: 1, tiers: { brain: { candidates: [{ provider: "anthropic", id: "claude", weight: 2 }] } } },
        "user",
      ),
      "UNKNOWN_KEY",
      "tiers.brain.candidates[0].weight",
    );
  });

  it("rejects duplicate candidates within a tier at the duplicate index", () => {
    expectError(
      validateConfigLayer(
        {
          schemaVersion: 1,
          tiers: {
            brain: {
              candidates: [
                { provider: "anthropic", id: "claude" },
                { provider: "openai", id: "gpt" },
                { provider: "anthropic", id: "claude" },
              ],
            },
          },
        },
        "user",
      ),
      "DUPLICATE_CANDIDATE",
      "tiers.brain.candidates[2]",
    );
  });
});

describe("rejection matrix: policy (§7.1 item 3)", () => {
  it("rejects an out-of-vocabulary bias with INVALID_VALUE", () => {
    expectError(
      validateConfigLayer({ schemaVersion: 1, policy: { defaultBias: "strong" } }, "user"),
      "INVALID_VALUE",
      "policy.defaultBias",
    );
  });

  it("rejects a non-string bias with TYPE_MISMATCH", () => {
    expectError(
      validateConfigLayer({ schemaVersion: 1, policy: { defaultBias: 5 } }, "user"),
      "TYPE_MISMATCH",
      "policy.defaultBias",
    );
  });

  it("rejects a non-boolean sticky with TYPE_MISMATCH", () => {
    expectError(
      validateConfigLayer({ schemaVersion: 1, policy: { sticky: "yes" } }, "user"),
      "TYPE_MISMATCH",
      "policy.sticky",
    );
  });

  it("rejects unknown policy keys", () => {
    expectError(
      validateConfigLayer({ schemaVersion: 1, policy: { bias: "low" } }, "user"),
      "UNKNOWN_KEY",
      "policy.bias",
    );
  });

  it("rejects null policy with TYPE_MISMATCH", () => {
    expectError(validateConfigLayer({ schemaVersion: 1, policy: null }, "user"), "TYPE_MISMATCH", "policy");
  });
});

describe("rejection matrix: retry (§7.1 item 3)", () => {
  it("rejects non-integer retry values with INVALID_VALUE", () => {
    expectError(
      validateConfigLayer({ schemaVersion: 1, retry: { maxAttemptsPerRequest: 2.5 } }, "user"),
      "INVALID_VALUE",
      "retry.maxAttemptsPerRequest",
    );
    expectError(
      validateConfigLayer({ schemaVersion: 1, retry: { maxTierSwitches: 0.5 } }, "user"),
      "INVALID_VALUE",
      "retry.maxTierSwitches",
    );
  });

  it("rejects out-of-bounds retry values with BOUNDS_EXCEEDED on both axes", () => {
    for (const value of [0, 6, -1]) {
      expectError(
        validateConfigLayer({ schemaVersion: 1, retry: { maxAttemptsPerRequest: value } }, "user"),
        "BOUNDS_EXCEEDED",
        "retry.maxAttemptsPerRequest",
      );
    }
    for (const value of [-1, 4]) {
      expectError(
        validateConfigLayer({ schemaVersion: 1, retry: { maxTierSwitches: value } }, "user"),
        "BOUNDS_EXCEEDED",
        "retry.maxTierSwitches",
      );
    }
  });

  it("accepts retry values at the exact bounds", () => {
    expectOk(
      validateConfigLayer({ schemaVersion: 1, retry: { maxAttemptsPerRequest: 1, maxTierSwitches: 0 } }, "user"),
    );
    expectOk(
      validateConfigLayer({ schemaVersion: 1, retry: { maxAttemptsPerRequest: 5, maxTierSwitches: 3 } }, "user"),
    );
  });

  it("rejects non-number retry values with TYPE_MISMATCH", () => {
    expectError(
      validateConfigLayer({ schemaVersion: 1, retry: { maxAttemptsPerRequest: "3" } }, "user"),
      "TYPE_MISMATCH",
      "retry.maxAttemptsPerRequest",
    );
    expectError(
      validateConfigLayer({ schemaVersion: 1, retry: { maxTierSwitches: null } }, "user"),
      "TYPE_MISMATCH",
      "retry.maxTierSwitches",
    );
  });

  it("reports NaN and Infinity as named values instead of JSON null", () => {
    const nanErr = expectError(
      validateConfigLayer({ schemaVersion: 1, retry: { maxAttemptsPerRequest: Number.NaN } }, "user"),
      "INVALID_VALUE",
      "retry.maxAttemptsPerRequest",
    );
    expect(nanErr.received).toBe("NaN");
    const infErr = expectError(
      validateConfigLayer({ schemaVersion: 1, retry: { maxTierSwitches: Number.POSITIVE_INFINITY } }, "user"),
      "INVALID_VALUE",
      "retry.maxTierSwitches",
    );
    expect(infErr.received).toBe("Infinity");
  });

  it("rejects unknown retry keys", () => {
    expectError(
      validateConfigLayer({ schemaVersion: 1, retry: { attempts: 3 } }, "user"),
      "UNKNOWN_KEY",
      "retry.attempts",
    );
  });

  it("rejects null retry with TYPE_MISMATCH", () => {
    expectError(validateConfigLayer({ schemaVersion: 1, retry: null }, "user"), "TYPE_MISMATCH", "retry");
  });
});

describe("effective mode requires the complete shape (§7.1 item 3)", () => {
  type EffectiveFixture = {
    schemaVersion: number;
    tiers: Record<string, { candidates: unknown[] }>;
    policy: Record<string, unknown>;
    retry: Record<string, unknown>;
  };

  function effectiveFixture(): EffectiveFixture {
    return {
      schemaVersion: 1,
      tiers: {
        brain: { candidates: [{ provider: "anthropic", id: "claude-sonnet-4-1" }] },
        pillar: { candidates: [] },
        crowd: { candidates: [] },
      },
      policy: { defaultBias: "medium", sticky: true },
      retry: { maxAttemptsPerRequest: 3, maxTierSwitches: 2 },
    };
  }

  it("accepts a layer that omits required effective keys, but rejects it in effective mode", () => {
    expectOk(validateConfigLayer({ schemaVersion: 1, retry: { maxAttemptsPerRequest: 2 } }, "user"));
    expectError(validateEffectiveConfig({ schemaVersion: 1, retry: { maxAttemptsPerRequest: 2 } }, "merge"), "TYPE_MISMATCH", "tiers");
  });

  it("rejects a missing tier", () => {
    const fixture = effectiveFixture();
    delete fixture.tiers.brain;
    expectError(validateEffectiveConfig(fixture, "merge"), "TYPE_MISMATCH", "tiers.brain");
  });

  it("rejects a tier without candidates", () => {
    const fixture = effectiveFixture();
    fixture.tiers.brain = {} as { candidates: unknown[] };
    expectError(validateEffectiveConfig(fixture, "merge"), "TYPE_MISMATCH", "tiers.brain.candidates");
  });

  it("rejects missing policy fields", () => {
    const withoutSticky = effectiveFixture();
    delete withoutSticky.policy.sticky;
    expectError(validateEffectiveConfig(withoutSticky, "merge"), "TYPE_MISMATCH", "policy.sticky");

    const withoutBias = effectiveFixture();
    delete withoutBias.policy.defaultBias;
    expectError(validateEffectiveConfig(withoutBias, "merge"), "TYPE_MISMATCH", "policy.defaultBias");
  });

  it("rejects missing retry fields", () => {
    const withoutSwitches = effectiveFixture();
    delete withoutSwitches.retry.maxTierSwitches;
    expectError(validateEffectiveConfig(withoutSwitches, "merge"), "TYPE_MISMATCH", "retry.maxTierSwitches");

    const withoutAttempts = effectiveFixture();
    delete withoutAttempts.retry.maxAttemptsPerRequest;
    expectError(validateEffectiveConfig(withoutAttempts, "merge"), "TYPE_MISMATCH", "retry.maxAttemptsPerRequest");
  });

  it("applies the same candidate constraints in effective mode", () => {
    const fixture = effectiveFixture();
    fixture.tiers.pillar.candidates = [
      { provider: "openai", id: "gpt" },
      { provider: "openai", id: "gpt" },
    ];
    expectError(validateEffectiveConfig(fixture, "merge"), "DUPLICATE_CANDIDATE", "tiers.pillar.candidates[1]");
  });
});

describe("error record shape (§7.1 item 3)", () => {
  it("stamps source and records expected/received exactly on representative errors", () => {
    const bounds = expectError(
      validateConfigLayer({ schemaVersion: 1, retry: { maxAttemptsPerRequest: 6 } }, "project"),
      "BOUNDS_EXCEEDED",
      "retry.maxAttemptsPerRequest",
    );
    expect(bounds.source).toBe("project");
    expect(bounds.expected).toBe("integer between 1 and 5");
    expect(bounds.received).toBe("6");

    const bias = expectError(
      validateConfigLayer({ schemaVersion: 1, policy: { defaultBias: "strong" } }, "user"),
      "INVALID_VALUE",
      "policy.defaultBias",
    );
    expect(bias.expected).toBe("one of minimal, low, medium, high, xhigh, max");
    expect(bias.received).toBe('"strong"');
  });

  it("never leaks raw control characters into message or received text", () => {
    const err = expectError(
      validateConfigLayer(
        { schemaVersion: 1, tiers: { brain: { candidates: [{ provider: "bad\rprovider", id: "x" }] } } },
        "user",
      ),
      "INVALID_VALUE",
      "tiers.brain.candidates[0].provider",
    );
    expect(err.message).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
    expect(err.received).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
  });

  it("truncates long received previews to the sanitized cap", () => {
    const longBias = `${"a".repeat(80)}\u0000${"b".repeat(80)}`;
    const err = expectError(
      validateConfigLayer({ schemaVersion: 1, policy: { defaultBias: longBias } }, "user"),
      "INVALID_VALUE",
      "policy.defaultBias",
    );
    expect(err.received).toBeDefined();
    expect(err.received).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
    expect(err.received!.length).toBeLessThanOrEqual(61);
    expect(err.received!.startsWith('"aaa')).toBe(true);
    expect(err.received!.endsWith("…")).toBe(true);
  });
});
