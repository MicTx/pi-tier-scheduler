import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, defaultConfig } from "../../src/config/defaults";
import { applySessionOverride, mergeConfig } from "../../src/config/merge";
import type { ConfigFile, SessionConfigPatch } from "../../src/config/types";

/**
 * mergeConfig tests (02-config.md §7.2 item 3): priority order
 * defaults < user < project, key-recursive object merge, wholesale array
 * replacement, scalar replacement, verbatim candidate order, leaf-level
 * provenance with whole-key array entries, and no shared mutable
 * structure between result and inputs.
 */

describe("mergeConfig", () => {
  it("returns the defaults baseline with every leaf provenance-marked defaults (§7.2 item 3)", () => {
    const effective = mergeConfig(DEFAULT_CONFIG);
    expect(effective).toEqual({
      schemaVersion: 1,
      tiers: {
        brain: { candidates: [] },
        pillar: { candidates: [] },
        crowd: { candidates: [] },
      },
      policy: { defaultBias: "medium", sticky: true },
      retry: { maxAttemptsPerRequest: 3, maxTierSwitches: 2 },
      provenance: {
        schemaVersion: "defaults",
        "tiers.brain.candidates": "defaults",
        "tiers.pillar.candidates": "defaults",
        "tiers.crowd.candidates": "defaults",
        "policy.defaultBias": "defaults",
        "policy.sticky": "defaults",
        "retry.maxAttemptsPerRequest": "defaults",
        "retry.maxTierSwitches": "defaults",
      },
    });
  });

  it("merges nested objects by key: an overridden leaf replaces, sibling keys inherit (§3.2)", () => {
    const user: ConfigFile = { schemaVersion: 1, policy: { defaultBias: "low" } };
    const effective = mergeConfig(DEFAULT_CONFIG, user);
    expect(effective.policy).toEqual({ defaultBias: "low", sticky: true });
    expect(effective.provenance["policy.defaultBias"]).toBe("user");
    expect(effective.provenance["policy.sticky"]).toBe("defaults");
  });

  it("replaces candidate arrays wholesale — no concatenation, no dedupe (§3.2)", () => {
    const user: ConfigFile = {
      schemaVersion: 1,
      tiers: {
        brain: {
          candidates: [
            { provider: "openai", id: "gpt-5" },
            { provider: "anthropic", id: "claude-sonnet-4-1" },
          ],
        },
      },
    };
    const project: ConfigFile = {
      schemaVersion: 1,
      tiers: {
        brain: { candidates: [{ provider: "google", id: "gemini-3-pro" }] },
      },
    };
    const effective = mergeConfig(DEFAULT_CONFIG, user, project);
    // Whole replacement: project's single candidate, not merged with user's.
    expect(effective.tiers.brain.candidates).toEqual([
      { provider: "google", id: "gemini-3-pro" },
    ]);
    expect(effective.provenance["tiers.brain.candidates"]).toBe("project");
    // Untouched tiers still inherit defaults.
    expect(effective.tiers.pillar.candidates).toEqual([]);
    expect(effective.provenance["tiers.pillar.candidates"]).toBe("defaults");
  });

  it("keeps candidate order verbatim from the winning layer (§3.2)", () => {
    const project: ConfigFile = {
      schemaVersion: 1,
      tiers: {
        brain: {
          candidates: [
            { provider: "google", id: "gemini-3-pro" },
            { provider: "openai", id: "gpt-5" },
            { provider: "anthropic", id: "claude-sonnet-4-1" },
          ],
        },
      },
    };
    const effective = mergeConfig(DEFAULT_CONFIG, undefined, project);
    expect(effective.tiers.brain.candidates).toEqual(project.tiers?.brain?.candidates);
    expect(effective.provenance["tiers.brain.candidates"]).toBe("project");
  });

  it("replaces scalars, including falsy values (§3.2)", () => {
    const user: ConfigFile = {
      schemaVersion: 1,
      retry: { maxTierSwitches: 0 },
    };
    const effective = mergeConfig(DEFAULT_CONFIG, user);
    expect(effective.retry).toEqual({ maxAttemptsPerRequest: 3, maxTierSwitches: 0 });
    expect(effective.provenance["retry.maxTierSwitches"]).toBe("user");
    expect(effective.provenance["retry.maxAttemptsPerRequest"]).toBe("defaults");
  });

  it("gives project the final say while user keeps leaves project omits (§3.2)", () => {
    const user: ConfigFile = {
      schemaVersion: 1,
      tiers: {
        brain: { candidates: [{ provider: "openai", id: "gpt-5" }] },
      },
      policy: { defaultBias: "low" },
    };
    const project: ConfigFile = {
      schemaVersion: 1,
      policy: { defaultBias: "high" },
      retry: { maxAttemptsPerRequest: 5 },
    };
    const effective = mergeConfig(DEFAULT_CONFIG, user, project);
    expect(effective.policy).toEqual({ defaultBias: "high", sticky: true });
    expect(effective.retry).toEqual({ maxAttemptsPerRequest: 5, maxTierSwitches: 2 });
    expect(effective.tiers.brain.candidates).toEqual([{ provider: "openai", id: "gpt-5" }]);
    expect(effective.provenance).toEqual({
      schemaVersion: "project",
      "tiers.brain.candidates": "user",
      "tiers.pillar.candidates": "defaults",
      "tiers.crowd.candidates": "defaults",
      "policy.defaultBias": "project",
      "policy.sticky": "defaults",
      "retry.maxAttemptsPerRequest": "project",
      "retry.maxTierSwitches": "defaults",
    });
  });

  it("records schemaVersion provenance with no special case: highest writer wins (§2.4)", () => {
    const defaultsOnly = mergeConfig(DEFAULT_CONFIG);
    expect(defaultsOnly.provenance.schemaVersion).toBe("defaults");

    const withUser = mergeConfig(DEFAULT_CONFIG, { schemaVersion: 1 });
    expect(withUser.provenance.schemaVersion).toBe("user");

    const withProject = mergeConfig(
      DEFAULT_CONFIG,
      { schemaVersion: 1 },
      { schemaVersion: 1 },
    );
    expect(withProject.provenance.schemaVersion).toBe("project");
    // The value itself is always 1 — every participating layer passed version validation.
    expect(withProject.schemaVersion).toBe(1);
  });

  it("shares no mutable structure with the defaults input", () => {
    const effective = mergeConfig(DEFAULT_CONFIG);
    expect(effective).not.toBe(DEFAULT_CONFIG);
    expect(effective.tiers).not.toBe(DEFAULT_CONFIG.tiers);
    expect(effective.policy).not.toBe(DEFAULT_CONFIG.policy);
    expect(effective.retry).not.toBe(DEFAULT_CONFIG.retry);
    expect(Object.isFrozen(effective)).toBe(false);
  });

  it("never mutates the passed defaults, even when unfrozen", () => {
    const defaults = defaultConfig();
    const before = structuredClone(defaults);
    const user: ConfigFile = { schemaVersion: 1, policy: { defaultBias: "low" } };
    mergeConfig(defaults, user);
    expect(defaults).toEqual(before);
  });

  it("shares no mutable structure with input layers, in both directions", () => {
    const user: ConfigFile = {
      schemaVersion: 1,
      tiers: {
        brain: {
          candidates: [
            { provider: "openai", id: "gpt-5" },
            { provider: "anthropic", id: "claude-sonnet-4-1" },
          ],
        },
      },
    };
    const effective = mergeConfig(DEFAULT_CONFIG, user);

    // Mutating the result leaves the input layer untouched.
    effective.tiers.brain.candidates.push({ provider: "x", id: "y" });
    expect(user.tiers?.brain?.candidates).toHaveLength(2);

    // Mutating the input layer after the merge leaves the result untouched.
    user.tiers?.brain?.candidates?.pop();
    expect(effective.tiers.brain.candidates).toHaveLength(3);
  });
});

/** A session-seam base built from real layers so original provenance varies per leaf. */
function layeredBase(): ReturnType<typeof mergeConfig> {
  const user: ConfigFile = {
    schemaVersion: 1,
    policy: { defaultBias: "low" },
    tiers: { brain: { candidates: [{ provider: "openai", id: "gpt-5" }] } },
  };
  const project: ConfigFile = {
    schemaVersion: 1,
    policy: { defaultBias: "high" },
    retry: { maxAttemptsPerRequest: 5 },
  };
  return mergeConfig(DEFAULT_CONFIG, user, project);
}

describe("applySessionOverride (reserved seam, §7.2 item 6)", () => {
  it("session patch wins over project/user/default leaves and marks them session", () => {
    const base = layeredBase();
    const patched = applySessionOverride(base, {
      policy: { defaultBias: "medium" },
      retry: { maxTierSwitches: 1 },
    });
    expect(patched.policy.defaultBias).toBe("medium");
    expect(patched.retry.maxTierSwitches).toBe(1);
    expect(patched.provenance["policy.defaultBias"]).toBe("session");
    expect(patched.provenance["retry.maxTierSwitches"]).toBe("session");
    // Untouched leaves keep their original per-layer provenance.
    expect(patched.provenance["policy.sticky"]).toBe("defaults");
    expect(patched.provenance["tiers.brain.candidates"]).toBe("user");
    expect(patched.provenance["retry.maxAttemptsPerRequest"]).toBe("project");
    // The patch vocabulary has no schemaVersion, so that leaf keeps its mark.
    expect(patched.provenance.schemaVersion).toBe("project");
  });

  it("leaves both inputs unchanged and shares no mutable structure with them", () => {
    const base = layeredBase();
    const before = structuredClone(base);
    const patch: SessionConfigPatch = {
      tiers: { brain: { candidates: [{ provider: "google", id: "gemini-3-pro" }] } },
    };
    const patchBefore = structuredClone(patch);
    const patched = applySessionOverride(base, patch);
    expect(base).toEqual(before);
    expect(patch).toEqual(patchBefore);

    patched.tiers.brain.candidates.pop();
    expect(patch.tiers?.brain?.candidates).toHaveLength(1);
  });

  it("returns an equivalent config for an empty patch", () => {
    const base = layeredBase();
    const patched = applySessionOverride(base, {});
    expect(patched).toEqual(base);
    expect(patched).not.toBe(base);
  });

  it("throws for an invalid patch, message carries stable codes and paths only", () => {
    const base = layeredBase();
    const bad = {
      policy: { defaultBias: "extreme" },
      retry: { maxTierSwitches: 99 },
    } as unknown as SessionConfigPatch;
    let caught: Error | undefined;
    try {
      applySessionOverride(base, bad);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught?.message).toContain("INVALID_VALUE@policy.defaultBias");
    expect(caught?.message).toContain("BOUNDS_EXCEEDED@retry.maxTierSwitches");
    expect(caught?.message).not.toContain("extreme");
    expect(caught?.message).not.toContain("99");
  });

  it("neutralizes a smuggled schemaVersion key via the injected constant", () => {
    const base = layeredBase();
    const smuggled = {
      schemaVersion: 99,
      policy: { defaultBias: "low" },
    } as unknown as SessionConfigPatch;
    const patched = applySessionOverride(base, smuggled);
    expect(patched.schemaVersion).toBe(1);
    expect(patched.provenance.schemaVersion).toBe("project");
    expect(patched.provenance["policy.defaultBias"]).toBe("session");
  });
});
