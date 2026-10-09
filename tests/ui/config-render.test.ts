import { describe, expect, it } from "vitest";

import {
  buildConfigView,
  renderConfigPreview,
  renderConfigView,
  VIEW_CANDIDATES_SHOWN,
} from "../../src/ui/config-render";
import { defaultConfig } from "../../src/config/defaults";
import { mergeConfig } from "../../src/config/merge";
import type {
  ConfigFile,
  ConfigProblem,
  EffectiveConfig,
  LoadResult,
} from "../../src/config/types";

/**
 * Preview renderer tests (07-tui-modes.md §3.3 step 5; F7.1 spec §2.4):
 * stable plain-text labels, the scope label standing in for the target
 * path, bounded candidate lists with the `...(+N more)` marker, and the
 * one-value current contrasts. Pure function: no files, no registry, no
 * throwing on any legal input shape.
 */

function effective(overrides: {
  bias?: "low" | "medium" | "high";
  sticky?: boolean;
  attempts?: number;
  switches?: number;
}): EffectiveConfig {
  const merged = mergeConfig(
    defaultConfig(),
    undefined,
    undefined,
  );
  const effective: EffectiveConfig = {
    ...merged,
    policy: { defaultBias: overrides.bias ?? merged.policy.defaultBias, sticky: overrides.sticky ?? merged.policy.sticky },
    retry: {
      maxAttemptsPerRequest: overrides.attempts ?? merged.retry.maxAttemptsPerRequest,
      maxTierSwitches: overrides.switches ?? merged.retry.maxTierSwitches,
    },
  };
  return effective;
}

function completeDraft(overrides: {
  brain?: { provider: string; id: string }[];
  bias?: "low" | "medium" | "high";
  sticky?: boolean;
  attempts?: number;
  switches?: number;
} = {}): ConfigFile {
  return {
    schemaVersion: 1,
    tiers: {
      brain: { candidates: overrides.brain ?? [{ provider: "acme", id: "brain-1" }] },
      pillar: { candidates: [] },
      crowd: { candidates: [] },
    },
    policy: { defaultBias: overrides.bias ?? "high", sticky: overrides.sticky ?? false },
    retry: {
      maxAttemptsPerRequest: overrides.attempts ?? 5,
      maxTierSwitches: overrides.switches ?? 3,
    },
  };
}

describe("renderConfigPreview", () => {
  it("renders the stable preview block with scope label, counts, identities, and contrasts", () => {
    const text = renderConfigPreview(effective({}), "project", completeDraft());
    expect(text).toBe(
      [
        "pi-tier-scheduler configuration preview",
        "scope: project",
        "brain candidates (1): acme/brain-1",
        "pillar candidates (0): none",
        "crowd candidates (0): none",
        "policy: defaultBias=high (current: medium); sticky=false (current: true)",
        "retry: attempts=5 (current: 3); tier-switches=3 (current: 2)",
      ].join("\n"),
    );
  });

  it("preserves authored candidate order in the rendered identities (hook 3)", () => {
    const draft = completeDraft({
      brain: [
        { provider: "beta", id: "z-model" },
        { provider: "acme", id: "a-model" },
        { provider: "beta", id: "m-model" },
      ],
    });
    const text = renderConfigPreview(effective({}), "user", draft);
    expect(text).toContain("brain candidates (3): beta/z-model, acme/a-model, beta/m-model");
  });

  it("bounds long candidate lists with the stable overflow marker", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ provider: "acme", id: `m-${i}` }));
    const text = renderConfigPreview(effective({}), "project", completeDraft({ brain: many }));
    const shown = Array.from({ length: 6 }, (_, i) => `acme/m-${i}`).join(", ");
    expect(text).toContain(`brain candidates (8): ${shown}, ...(+2 more)`);
  });

  it("marks absent draft sections as inherited instead of fabricating values", () => {
    const text = renderConfigPreview(effective({}), "project", { schemaVersion: 1 });
    expect(text).toContain("brain candidates (0): inherited (not set in this layer)");
    expect(text).toContain("policy: defaultBias=inherited (current: medium); sticky=inherited (current: true)");
    expect(text).toContain("retry: attempts=inherited (current: 3); tier-switches=inherited (current: 2)");
  });

  it("renders identical current values without inventing a change", () => {
    const text = renderConfigPreview(
      effective({ bias: "high", sticky: false, attempts: 5, switches: 3 }),
      "user",
      completeDraft(),
    );
    expect(text).toContain("policy: defaultBias=high (current: high); sticky=false (current: false)");
    expect(text).toContain("retry: attempts=5 (current: 5); tier-switches=3 (current: 3)");
  });

  it("never receives or renders a target path — the scope label is the only location hint", () => {
    // The signature takes no path, so the guarantee is structural; pin that
    // the emitted text carries only the scope label for location.
    const text = renderConfigPreview(effective({}), "user", completeDraft());
    expect(text).toContain("scope: user");
    expect(text).not.toContain(".pi");
    expect(text).not.toContain("tier-scheduler.json");
  });
});

// ---------------------------------------------------------------------------
// F7.2 effective view (07-tui-modes.md §3.5/§4.4; hooks 1 and 7.2 hook 1).
// ---------------------------------------------------------------------------

/** LoadResult fixture: merged layers, explicit per-layer status, bounded problems. */
function viewLoad(options: {
  user?: ConfigFile;
  project?: ConfigFile;
  problems?: ConfigProblem[];
  userStatus?: "loaded" | "missing" | "invalid" | "unreadable";
  projectStatus?: "loaded" | "missing" | "invalid" | "unreadable";
}): LoadResult {
  return {
    effective: mergeConfig(defaultConfig(), options.user, options.project),
    problems: options.problems ?? [],
    paths: { userPath: "/home/u/.pi/agent/tier-scheduler.json", projectPath: "/w/.pi/tier-scheduler.json" },
    layers: {
      user: options.userStatus ?? (options.user === undefined ? "missing" : "loaded"),
      project: options.projectStatus ?? (options.project === undefined ? "missing" : "loaded"),
    },
  };
}

describe("buildConfigView + renderConfigView — effective view", () => {
  it("renders the canonical view: merged values, source labels, provenance, order, override note (hook 1)", () => {
    const load = viewLoad({
      project: {
        schemaVersion: 1,
        tiers: {
          brain: { candidates: [{ provider: "anthropic", id: "claude-opus-4-1" }] },
          pillar: {
            candidates: [
              { provider: "anthropic", id: "claude-sonnet-4-1" },
              { provider: "openai", id: "gpt-5" },
            ],
          },
        },
        policy: { defaultBias: "medium" },
      },
    });
    const text = renderConfigView(buildConfigView(load, null));
    expect(text).toBe(
      [
        "pi-tier-scheduler configuration",
        "effective: valid",
        "sources: user=missing; project=loaded",
        "policy: defaultBias=medium (project); sticky=true (defaults)",
        "retry: attempts=3 (defaults); tier-switches=2 (defaults)",
        "brain candidates (project, 1): anthropic/claude-opus-4-1",
        "pillar candidates (project, 2): anthropic/claude-sonnet-4-1, openai/gpt-5",
        "crowd candidates (defaults, 0): none",
        "session override: automatic",
      ].join("\n"),
    );
  });

  it.each(["invalid", "unreadable"] as const)(
    "renders the %s layer status as its literal label, never folded (hook 1)",
    (status) => {
      const load = viewLoad({
        problems: [
          { source: "user", path: "", severity: "error", code: "NOT_JSON", message: "raw parser detail" },
        ],
        userStatus: status,
      });
      const text = renderConfigView(buildConfigView(load, null));
      expect(text).toContain(`user=${status}`);
      expect(text).toContain("effective: degraded");
      expect(text).toContain("problems: 1");
      // Problem text renders as a count, never the raw message.
      expect(text).not.toContain("raw parser detail");
    },
  );

  it("renders every LayerStatus literal verbatim for both sources (hook 1)", () => {
    for (const status of ["loaded", "missing", "invalid", "unreadable"] as const) {
      const load = viewLoad({ userStatus: status, projectStatus: status });
      const text = renderConfigView(buildConfigView(load, null));
      expect(text).toContain(`user=${status}`);
      expect(text).toContain(`project=${status}`);
    }
  });

  it("reports the manual override from router state and bounds long candidate lists (hook 1)", () => {
    const many = Array.from({ length: VIEW_CANDIDATES_SHOWN + 2 }, (_, i) => ({
      provider: "acme",
      id: `m-${i}`,
    }));
    const load = viewLoad({
      user: { schemaVersion: 1, tiers: { brain: { candidates: many } } },
    });
    const text = renderConfigView(buildConfigView(load, "brain"));
    expect(text).toContain("brain candidates (user, 8): acme/m-0, acme/m-1, acme/m-2, acme/m-3, acme/m-4, acme/m-5, ...(+2 more)");
    expect(text).toContain("session override: brain");
    // No paths, no secrets, no raw errors anywhere in the view.
    expect(text).not.toContain("/home");
    expect(text).not.toContain("/w/");
  });

  it("omits the problems line entirely when the load is clean", () => {
    const text = renderConfigView(buildConfigView(viewLoad({}), null));
    expect(text).toContain("effective: valid");
    expect(text).not.toContain("problems:");
  });
});
