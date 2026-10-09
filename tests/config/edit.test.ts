import { describe, expect, it } from "vitest";

import {
  applyDraftToEffective,
  createEditDraft,
  createInitDraft,
  resetPolicyField,
  resetRetryField,
  resetTierToInherited,
  setPolicyField,
  setRetryField,
  setTierCandidates,
  TIER_ORDER,
} from "../../src/config/edit";
import { validateConfigLayer } from "../../src/config/schema";
import { defaultConfig } from "../../src/config/defaults";
import { mergeConfig } from "../../src/config/merge";
import type { EditableConfigLayer } from "../../src/config/layer-read";
import type {
  CandidateRef,
  CompleteConfig,
  ConfigFile,
  EffectiveConfig,
} from "../../src/config/types";

/**
 * Pure draft-face tests (07-tui-modes.md §7.1 hooks 2–4; F7.1 spec §7.2
 * hook 2/3/4's pure half; F7.2 hooks 2/3's pure half per §7.2): complete init
 * drafts from any complete shape, deep-clone isolation in both directions,
 * verbatim candidate order, section creation on partial drafts, the
 * partial-layer edit set — missing targets start bare, resets delete keys,
 * `applyDraftToEffective` composes through Phase 2 `mergeConfig` in both
 * scope directions — and the Phase 2 validator staying the authority. No
 * null deletion sentinel is ever written.
 */

const CANDIDATES: CandidateRef[] = [
  { provider: "acme", id: "brain-1" },
  { provider: "acme", id: "brain-2" },
];

function complete(overrides: Partial<CompleteConfig> = {}): CompleteConfig {
  return {
    schemaVersion: 1,
    tiers: {
      brain: { candidates: [...CANDIDATES] },
      pillar: { candidates: [{ provider: "acme", id: "pillar-1" }] },
      crowd: { candidates: [] },
    },
    policy: { defaultBias: "high", sticky: false },
    retry: { maxAttemptsPerRequest: 5, maxTierSwitches: 1 },
    ...overrides,
  };
}

describe("createInitDraft", () => {
  it("builds a complete layer from the passed defaults with verbatim order (hook 3)", () => {
    const draft = createInitDraft(complete());
    expect(draft).toEqual({
      schemaVersion: 1,
      tiers: {
        brain: { candidates: [...CANDIDATES] },
        pillar: { candidates: [{ provider: "acme", id: "pillar-1" }] },
        crowd: { candidates: [] },
      },
      policy: { defaultBias: "high", sticky: false },
      retry: { maxAttemptsPerRequest: 5, maxTierSwitches: 1 },
    });
    expect(draft.tiers?.brain?.candidates?.[0]?.id).toBe("brain-1");
  });

  it("deep-clones the source: later mutation on either side is invisible on the other", () => {
    const source = complete();
    const draft = createInitDraft(source);
    source.tiers.brain.candidates.push({ provider: "acme", id: "intruder" });
    source.policy.defaultBias = "low";
    expect(draft.tiers?.brain?.candidates).toHaveLength(2);
    expect(draft.policy?.defaultBias).toBe("high");

    draft.tiers!.brain!.candidates!.push({ provider: "acme", id: "draft-intruder" });
    draft.retry!.maxAttemptsPerRequest = 1;
    expect(source.tiers.brain.candidates).toHaveLength(3);
    expect(source.retry.maxAttemptsPerRequest).toBe(5);
  });

  it("starts from the built-in defaults in production shape (empty tiers, medium bias)", () => {
    const draft = createInitDraft(defaultConfig());
    expect(draft.tiers).toEqual({
      brain: { candidates: [] },
      pillar: { candidates: [] },
      crowd: { candidates: [] },
    });
    expect(draft.policy).toEqual({ defaultBias: "medium", sticky: true });
    expect(draft.retry).toEqual({ maxAttemptsPerRequest: 3, maxTierSwitches: 2 });
  });

  it("exposes the canonical brain → pillar → crowd tier order", () => {
    expect(TIER_ORDER).toEqual(["brain", "pillar", "crowd"]);
  });
});

describe("setTierCandidates", () => {
  const base: ConfigFile = { schemaVersion: 1 };

  it("sets the tier's list, preserves authored order, and clones the input", () => {
    const source = [...CANDIDATES];
    const next = setTierCandidates(base, "brain", source);
    source.push({ provider: "acme", id: "late" });
    expect(next.tiers?.brain?.candidates).toEqual(CANDIDATES);
    expect(next.tiers?.brain?.candidates).not.toBe(source);
  });

  it("replaces only the named tier and leaves the rest of the draft intact", () => {
    const draft = createInitDraft(complete());
    const next = setTierCandidates(draft, "pillar", [{ provider: "beta", id: "p-9" }]);
    expect(next.tiers?.pillar?.candidates).toEqual([{ provider: "beta", id: "p-9" }]);
    expect(next.tiers?.brain?.candidates).toEqual(CANDIDATES);
    expect(next.policy).toEqual(draft.policy);
    expect(next.retry).toEqual(draft.retry);
    // The input draft is untouched (no in-place mutation).
    expect(draft.tiers?.pillar?.candidates).toEqual([{ provider: "acme", id: "pillar-1" }]);
  });

  it("creates the tiers section when the draft has none", () => {
    const next = setTierCandidates({ schemaVersion: 1 }, "crowd", []);
    expect(next.tiers).toEqual({ crowd: { candidates: [] } });
  });

  it("accepts an empty tier as a legal configuration (hook 3)", () => {
    const next = setTierCandidates(createInitDraft(complete()), "brain", []);
    expect(validateConfigLayer(next, "user")).toEqual({ ok: true, value: next });
  });
});

describe("setPolicyField", () => {
  it("sets defaultBias and sticky independently, creating the section when absent", () => {
    const draft = createInitDraft(defaultConfig());
    expect(setPolicyField(draft, "defaultBias", "low").policy).toEqual({
      defaultBias: "low",
      sticky: true,
    });
    expect(setPolicyField(draft, "sticky", false).policy).toEqual({
      defaultBias: "medium",
      sticky: false,
    });
    expect(setPolicyField({ schemaVersion: 1 }, "sticky", false).policy).toEqual({
      sticky: false,
    });
  });

  it("does not mutate the input draft", () => {
    const draft = createInitDraft(defaultConfig());
    setPolicyField(draft, "defaultBias", "low");
    expect(draft.policy?.defaultBias).toBe("medium");
  });
});

describe("setRetryField", () => {
  it("sets both bounded fields, creating the section when absent", () => {
    const draft = createInitDraft(defaultConfig());
    expect(setRetryField(draft, "maxAttemptsPerRequest", 5).retry).toEqual({
      maxAttemptsPerRequest: 5,
      maxTierSwitches: 2,
    });
    expect(setRetryField(draft, "maxTierSwitches", 0).retry).toEqual({
      maxAttemptsPerRequest: 3,
      maxTierSwitches: 0,
    });
    expect(setRetryField({ schemaVersion: 1 }, "maxAttemptsPerRequest", 1).retry).toEqual({
      maxAttemptsPerRequest: 1,
    });
  });

  it("keeps the Phase 2 validator authoritative: every legal helper output passes (hook 4)", () => {
    const draft = setRetryField(
      setRetryField(createInitDraft(defaultConfig()), "maxAttemptsPerRequest", 1),
      "maxTierSwitches",
      3,
    );
    const checked = validateConfigLayer(draft, "user");
    expect(checked.ok).toBe(true);
  });

  it("keeps the Phase 2 validator authoritative: an out-of-bounds value cannot pass (hook 4)", () => {
    const draft = setRetryField(createInitDraft(defaultConfig()), "maxAttemptsPerRequest", 99);
    const checked = validateConfigLayer(draft, "user");
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.errors.map((e) => e.code)).toContain("BOUNDS_EXCEEDED");
    }
  });
});

/** Layer probe fixture with the F7.1 adapter's exact shape. */
function layer(
  overrides: Partial<EditableConfigLayer> = {},
): EditableConfigLayer {
  return {
    scope: "project",
    status: "valid",
    value: { schemaVersion: 1 },
    problemCodes: [],
    targetPath: "/internal/plumbing-only/tier-scheduler.json",
    ...overrides,
  };
}

describe("createEditDraft", () => {
  it("starts a missing target at { schemaVersion: 1 } — never a copy of the effective config (hook 2)", () => {
    const draft = createEditDraft(layer({ status: "missing", value: { schemaVersion: 1 } }));
    expect(draft).toEqual({ schemaVersion: 1 });
  });

  it("clones a valid target exactly, preserving partial-layer semantics (hook 3)", () => {
    const value: ConfigFile = {
      schemaVersion: 1,
      tiers: { brain: { candidates: [{ provider: "acme", id: "brain-1" }] } },
      policy: { defaultBias: "high" },
    };
    const draft = createEditDraft(layer({ value }));
    expect(draft).toEqual(value);
    // Isolation in both directions: editing the draft never touches the probe.
    draft.tiers!.brain!.candidates!.push({ provider: "acme", id: "intruder" });
    expect(value.tiers!.brain!.candidates).toHaveLength(1);
  });

  it("never writes a null deletion sentinel for any absent section (hook 3)", () => {
    const draft = createEditDraft(layer({ value: { schemaVersion: 1 } }));
    expect(JSON.stringify(draft)).not.toContain("null");
  });
});

describe("reset-to-inherit deleters", () => {
  it("resetTierToInherited deletes the tier key and drops an emptied tiers section (hook 3)", () => {
    const draft: ConfigFile = {
      schemaVersion: 1,
      tiers: { crowd: { candidates: [] } },
    };
    expect(resetTierToInherited(draft, "crowd")).toEqual({ schemaVersion: 1 });
    const twoTiers: ConfigFile = {
      schemaVersion: 1,
      tiers: { brain: { candidates: [] }, crowd: { candidates: [] } },
    };
    expect(resetTierToInherited(twoTiers, "brain")).toEqual({
      schemaVersion: 1,
      tiers: { crowd: { candidates: [] } },
    });
    // The input draft is untouched.
    expect(twoTiers.tiers).toHaveProperty("brain");
  });

  it("resetPolicyField and resetRetryField delete leaf keys and empty sections (hook 3)", () => {
    expect(resetPolicyField({ schemaVersion: 1, policy: { sticky: false } }, "sticky")).toEqual({
      schemaVersion: 1,
    });
    expect(
      resetPolicyField(
        { schemaVersion: 1, policy: { defaultBias: "low", sticky: true } },
        "defaultBias",
      ),
    ).toEqual({ schemaVersion: 1, policy: { sticky: true } });
    expect(
      resetRetryField(
        { schemaVersion: 1, retry: { maxAttemptsPerRequest: 5, maxTierSwitches: 1 } },
        "maxTierSwitches",
      ),
    ).toEqual({ schemaVersion: 1, retry: { maxAttemptsPerRequest: 5 } });
    expect(
      resetRetryField({ schemaVersion: 1, retry: { maxTierSwitches: 0 } }, "maxTierSwitches"),
    ).toEqual({ schemaVersion: 1 });
  });

  it("a draft with every editable key reset saves as { schemaVersion: 1 } and validates (hook 3)", () => {
    let draft: ConfigFile = createInitDraft(defaultConfig());
    for (const tier of TIER_ORDER) draft = resetTierToInherited(draft, tier);
    draft = resetPolicyField(resetPolicyField(draft, "defaultBias"), "sticky");
    draft = resetRetryField(resetRetryField(draft, "maxAttemptsPerRequest"), "maxTierSwitches");
    expect(draft).toEqual({ schemaVersion: 1 });
    expect(validateConfigLayer(draft, "user")).toEqual({ ok: true, value: draft });
    expect(JSON.stringify(draft)).not.toContain("null");
  });
});

describe("applyDraftToEffective", () => {
  const userLayer: ConfigFile = {
    schemaVersion: 1,
    tiers: { brain: { candidates: [{ provider: "acme", id: "user-brain" }] } },
    policy: { defaultBias: "low" },
  };
  const projectLayer: ConfigFile = {
    schemaVersion: 1,
    policy: { sticky: false },
    retry: { maxTierSwitches: 3 },
  };

  it("composes a project-scope draft exactly as mergeConfig(defaults, user, draft)", () => {
    const draft: ConfigFile = {
      schemaVersion: 1,
      tiers: { pillar: { candidates: [{ provider: "beta", id: "p-1" }] } },
    };
    const viaHelper = applyDraftToEffective({ user: userLayer }, draft, "project");
    const direct = mergeConfig(defaultConfig(), userLayer, draft);
    expect(viaHelper).toEqual(direct);
    // The project layer above the user values is fully replaced by the draft.
    expect(viaHelper.policy.defaultBias).toBe("low"); // inherited from user
    expect(viaHelper.policy.sticky).toBe(true); // defaults — the old project sticky is gone
    expect(viaHelper.provenance["policy.defaultBias"]).toBe("user");
  });

  it("composes a user-scope draft exactly as mergeConfig(defaults, draft, project)", () => {
    const draft: ConfigFile = { schemaVersion: 1, policy: { defaultBias: "high" } };
    const viaHelper = applyDraftToEffective({ project: projectLayer }, draft, "user");
    const direct = mergeConfig(defaultConfig(), draft, projectLayer);
    expect(viaHelper).toEqual(direct);
    // The project layer still wins above the edited user draft.
    expect(viaHelper.policy.defaultBias).toBe("high"); // no project defaultBias
    expect(viaHelper.policy.sticky).toBe(false); // project wins over defaults
    expect(viaHelper.provenance["policy.sticky"]).toBe("project");
    expect(viaHelper.retry.maxTierSwitches).toBe(3);
  });

  it("shares no mutable structure with the draft or the layer pair", () => {
    const draft: ConfigFile = {
      schemaVersion: 1,
      tiers: { crowd: { candidates: [{ provider: "acme", id: "c-1" }] } },
    };
    const result = applyDraftToEffective({ user: userLayer }, draft, "project") as EffectiveConfig;
    draft.tiers!.crowd!.candidates!.push({ provider: "acme", id: "intruder" });
    userLayer.tiers!.brain!.candidates!.push({ provider: "acme", id: "layer-intruder" });
    expect(result.tiers.crowd.candidates).toHaveLength(1);
    expect(result.tiers.brain.candidates).toHaveLength(1);
  });
});
