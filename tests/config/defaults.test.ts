import { describe, expect, it } from "vitest";

import {
  MAX_ATTEMPTS_PER_REQUEST,
  MAX_TIER_SWITCHES,
  SCHEMA_VERSION,
} from "../../src/config/constants";
import { DEFAULT_CONFIG, defaultConfig } from "../../src/config/defaults";
import { layerStatusOf } from "../../src/config/types";
import type { CandidateRef, ReadLayerResult } from "../../src/config/types";

describe("config constants", () => {
  it("fixes the schema version and the absolute retry ceilings", () => {
    expect(SCHEMA_VERSION).toBe(1);
    expect(MAX_ATTEMPTS_PER_REQUEST).toBe(5);
    expect(MAX_TIER_SWITCHES).toBe(3);
  });
});

describe("DEFAULT_CONFIG", () => {
  it("matches the canonical shape from 02-config.md §4.1", () => {
    expect(DEFAULT_CONFIG).toEqual({
      schemaVersion: 1,
      tiers: {
        brain: { candidates: [] },
        pillar: { candidates: [] },
        crowd: { candidates: [] },
      },
      policy: { defaultBias: "medium", sticky: true },
      retry: { maxAttemptsPerRequest: 3, maxTierSwitches: 2 },
    });
  });

  it("is frozen at every object level and its candidate arrays", () => {
    expect(Object.isFrozen(DEFAULT_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CONFIG.tiers)).toBe(true);
    for (const tier of Object.values(DEFAULT_CONFIG.tiers)) {
      expect(Object.isFrozen(tier)).toBe(true);
      expect(Object.isFrozen(tier.candidates)).toBe(true);
    }
    expect(Object.isFrozen(DEFAULT_CONFIG.policy)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CONFIG.retry)).toBe(true);
  });

  it("rejects writes at any depth with TypeError and keeps later reads unchanged", () => {
    expect(() => {
      (DEFAULT_CONFIG as { schemaVersion: number }).schemaVersion = 2;
    }).toThrow(TypeError);
    expect(DEFAULT_CONFIG.schemaVersion).toBe(1);

    expect(() => {
      (DEFAULT_CONFIG.policy as { defaultBias: string }).defaultBias = "low";
    }).toThrow(TypeError);
    expect(DEFAULT_CONFIG.policy.defaultBias).toBe("medium");

    expect(() => {
      (DEFAULT_CONFIG.retry as { maxAttemptsPerRequest: number }).maxAttemptsPerRequest = 5;
    }).toThrow(TypeError);
    expect(DEFAULT_CONFIG.retry.maxAttemptsPerRequest).toBe(3);

    expect(() => {
      DEFAULT_CONFIG.tiers.brain.candidates.push({ provider: "x", id: "y" });
    }).toThrow(TypeError);
    expect(DEFAULT_CONFIG.tiers.brain.candidates).toEqual([]);

    expect(() => {
      (DEFAULT_CONFIG.tiers.brain.candidates as [CandidateRef?])[0] = { provider: "x", id: "y" };
    }).toThrow(TypeError);
    expect(DEFAULT_CONFIG.tiers.brain.candidates).toEqual([]);

    expect(() => {
      (DEFAULT_CONFIG.tiers as Record<string, unknown>).brain = { candidates: [] };
    }).toThrow(TypeError);
    expect(DEFAULT_CONFIG.tiers.brain).toEqual({ candidates: [] });
  });
});

describe("defaultConfig", () => {
  it("returns an independent mutable deep copy that never touches DEFAULT_CONFIG", () => {
    const copy = defaultConfig();

    expect(Object.isFrozen(copy)).toBe(false);
    expect(Object.isFrozen(copy.tiers.brain.candidates)).toBe(false);

    copy.tiers.brain.candidates.push({ provider: "anthropic", id: "claude-sonnet-4-1" });
    copy.policy.defaultBias = "high";
    copy.policy.sticky = false;
    copy.retry.maxAttemptsPerRequest = 5;
    copy.retry.maxTierSwitches = 3;

    expect(copy.tiers.brain.candidates).toHaveLength(1);
    expect(copy.policy.defaultBias).toBe("high");
    expect(copy.retry.maxAttemptsPerRequest).toBe(5);

    expect(DEFAULT_CONFIG.tiers.brain.candidates).toEqual([]);
    expect(DEFAULT_CONFIG.policy.defaultBias).toBe("medium");
    expect(DEFAULT_CONFIG.policy.sticky).toBe(true);
    expect(DEFAULT_CONFIG.retry.maxAttemptsPerRequest).toBe(3);
    expect(DEFAULT_CONFIG.retry.maxTierSwitches).toBe(2);
  });

  it("returns a fresh copy on every call", () => {
    const first = defaultConfig();
    const second = defaultConfig();

    expect(first).not.toBe(second);
    expect(first).toEqual(second);

    first.policy.sticky = false;
    expect(second.policy.sticky).toBe(true);
  });
});

describe("layerStatusOf", () => {
  it("maps all four ReadLayerResult kinds onto LayerStatus labels", () => {
    const missing: ReadLayerResult = {
      kind: "missing",
      source: "user",
      path: "~/.pi/agent/tier-scheduler.json",
    };
    const valid: ReadLayerResult = {
      kind: "valid",
      source: "user",
      path: "~/.pi/agent/tier-scheduler.json",
      value: { schemaVersion: 1 },
    };
    const invalid: ReadLayerResult = {
      kind: "invalid",
      source: "project",
      path: ".pi/tier-scheduler.json",
      problems: [
        {
          source: "project",
          path: ".pi/tier-scheduler.json",
          severity: "error",
          code: "SCHEMA_VERSION_UNSUPPORTED",
          message: "config declares schemaVersion 2; this release supports 1",
        },
      ],
    };
    const unreadable: ReadLayerResult = {
      kind: "unreadable",
      source: "project",
      path: ".pi/tier-scheduler.json",
      problems: [
        {
          source: "project",
          path: ".pi/tier-scheduler.json",
          severity: "warning",
          code: "EACCES",
          message: "config file is not readable",
        },
      ],
    };

    expect(layerStatusOf(missing)).toBe("missing");
    expect(layerStatusOf(valid)).toBe("loaded");
    expect(layerStatusOf(invalid)).toBe("invalid");
    expect(layerStatusOf(unreadable)).toBe("unreadable");
  });
});
