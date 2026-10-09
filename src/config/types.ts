/**
 * Configuration type contracts (02-config.md §4.2/§4.3).
 *
 * Exact export names are fixed by the design document so later phases can depend on them.
 * This module is a pure declaration layer: no file system, no merge, no persistence.
 */

export type TierName = "brain" | "pillar" | "crowd";

export type ThinkingBias = "low" | "medium" | "high";

export type ConfigSource = "defaults" | "user" | "project" | "session";

export type CandidateRef = {
  provider: string;
  id: string;
};

export type TierConfig = {
  candidates: CandidateRef[];
};

export type PolicyConfig = {
  defaultBias: ThinkingBias;
  sticky: boolean;
};

export type RetryConfig = {
  maxAttemptsPerRequest: number;
  maxTierSwitches: number;
};

/** A config file layer: only `schemaVersion` is required, everything else is partial. */
export type ConfigFile = {
  schemaVersion: 1;
  tiers?: Partial<Record<TierName, Partial<TierConfig>>>;
  policy?: Partial<PolicyConfig>;
  retry?: Partial<RetryConfig>;
};

/** The fully merged shape without provenance; the input type of mergeConfig (§6.2). */
export type CompleteConfig = {
  schemaVersion: 1;
  tiers: Record<TierName, TierConfig>;
  policy: PolicyConfig;
  retry: RetryConfig;
};

/** What validateEffectiveConfig returns before provenance is attached. */
export type EffectiveConfigWithoutProvenance = CompleteConfig;

export type EffectiveConfig = CompleteConfig & {
  provenance: Record<string, ConfigSource>;
};

export type ConfigError = {
  source: string;
  /** JSON path of the offending value, e.g. "retry.maxTierSwitches"; "" at the root. */
  path: string;
  code:
    | "NOT_JSON"
    | "SCHEMA_VERSION_MISSING"
    | "SCHEMA_VERSION_UNSUPPORTED"
    | "TYPE_MISMATCH"
    | "UNKNOWN_KEY"
    | "INVALID_VALUE"
    | "DUPLICATE_CANDIDATE"
    | "BOUNDS_EXCEEDED";
  message: string;
  expected?: string;
  received?: string;
};

export type ConfigProblem = {
  source: "user" | "project";
  path: string;
  severity: "warning" | "error";
  code: string;
  message: string;
  backupPath?: string;
};

export type LoadResult = {
  effective: EffectiveConfig;
  problems: ConfigProblem[];
  paths: { userPath: string; projectPath: string };
  /**
   * Per-layer status derived once at load time through `layerStatusOf`
   * (the additive F5.1 seam, spec 2026-10-08_add-ms-status-command §2.2):
   * the four-value vocabulary is authoritative for every later view model,
   * so consumers never re-derive layer state from `problems`.
   */
  layers: { user: LayerStatus; project: LayerStatus };
};

/**
 * Discovery returns a tagged layer instead of collapsing failures into an empty object.
 * `kind` is the sole authority for layer status in every later view model.
 */
export type ReadLayerResult =
  | { kind: "missing"; source: "user" | "project"; path: string }
  | { kind: "valid"; source: "user" | "project"; path: string; value: ConfigFile }
  | { kind: "invalid"; source: "user" | "project"; path: string; problems: ConfigProblem[] }
  | { kind: "unreadable"; source: "user" | "project"; path: string; problems: ConfigProblem[] };

export type LayerStatus = "loaded" | "missing" | "invalid" | "unreadable";

/** valid → "loaded"; missing → "missing"; invalid → "invalid"; unreadable → "unreadable". */
export function layerStatusOf(result: ReadLayerResult): LayerStatus {
  switch (result.kind) {
    case "valid":
      return "loaded";
    case "missing":
      return "missing";
    case "invalid":
      return "invalid";
    case "unreadable":
      return "unreadable";
  }
}

/**
 * Declared, versioned, tested seam for the session-patch position, reserved for future
 * releases (02-config.md §4.3): no first-release caller supplies a patch, so it is never
 * persisted and runtime provenance never contains the `session` mark in this release.
 */
export type SessionConfigPatch = {
  tiers?: Partial<Record<TierName, Partial<TierConfig>>>;
  policy?: Partial<PolicyConfig>;
  retry?: Partial<RetryConfig>;
};
