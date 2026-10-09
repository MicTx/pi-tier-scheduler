/**
 * Catalog type contracts (03-catalog.md §4.1/§4.2, spec §2.2).
 *
 * Phase 2 config types are imported type-only; the catalog is a runtime view
 * over validated config candidates plus the SDK registry, never a persisted
 * shape of its own. `candidate_constraint_failed` is carried in the code union
 * for F3.2 (capability policy) but is never produced in this package.
 */
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";

import type { CandidateRef, TierName } from "../config/types";

/**
 * A physical chat model entry exactly as the SDK catalog stores it. The catalog
 * only reads these objects and never serializes or copies them.
 */
export type PhysicalChatModel = Model<Api>;

/**
 * Identity key of a candidate: `provider + "\0" + id`. The NUL separator makes
 * the key injective — neither field can contain NUL, so no two distinct refs
 * ever collide across a field boundary (03-catalog.md §3.1). Keys are internal
 * identity tokens only, never URLs or user-facing output.
 */
export type CandidateKey = string;

/**
 * The structural slice of `ModelRegistry` the catalog consumes. Tests pass an
 * in-memory fake with exactly this shape; this is the only registry adapter
 * seam (03-catalog.md §4.1), and it is compile-time proof the catalog can
 * reach no credential or auth-header surface.
 */
export type CatalogRegistry = Pick<ModelRegistry, "find" | "getAvailable">;

/**
 * One registry call that failed during snapshotting. Records only the operation
 * and the candidate identity asked for (03-catalog.md §3.3): no exception text,
 * no error class name, no provider error payload.
 */
export type RegistrySnapshotProblem = {
  operation: "availability_snapshot" | "model_lookup";
  ref?: CandidateRef;
};

/**
 * One frozen view of the registry, taken fresh at the start of every resolution
 * (03-catalog.md §3.1/§5.1 — no watcher, no cache, no module-level state).
 */
export type CatalogSnapshot = {
  /**
   * Every unique configured ref has an entry; `undefined` means the registry
   * found nothing for that ref or the lookup failed (see `problems`).
   */
  models: ReadonlyMap<CandidateKey, PhysicalChatModel | undefined>;
  /** Keys of models `getAvailable()` reported as available at snapshot time. */
  available: ReadonlySet<CandidateKey>;
  /** Registry failures that occurred while snapshotting, availability first. */
  problems: readonly RegistrySnapshotProblem[];
};

/** Why a configured candidate was skipped in admission (03-catalog.md §3.2). */
export type CandidateResolutionCode =
  | "candidate_not_found"
  | "candidate_not_available"
  | "candidate_virtual_model"
  | "candidate_non_chat_model"
  | "candidate_identity_mismatch"
  | "candidate_lookup_failed";

/**
 * All stable diagnostic codes. `candidate_constraint_failed` is reserved for
 * F3.2 capability policy and is never emitted by this package.
 */
export type CatalogDiagnosticCode =
  | CandidateResolutionCode
  | "registry_snapshot_failed"
  | "tier_empty"
  | "tier_exhausted"
  | "candidate_constraint_failed";

/**
 * Stable diagnostic record. Fields are exactly tier/candidateIndex/ref/code/
 * severity/operation (spec §2.2): no credential values, no auth headers, no
 * raw provider error text, no absolute local paths.
 */
export type CatalogDiagnostic = {
  tier: TierName;
  /** Present on candidate-level records only. */
  candidateIndex?: number;
  ref?: CandidateRef;
  code: CatalogDiagnosticCode;
  severity: "info" | "warning" | "error";
  /** The snapshot operation that produced this diagnostic, when one did. */
  operation?: "availability_snapshot" | "model_lookup";
};

/**
 * A candidate that cleared admission. `model` is the SDK object by reference —
 * the catalog never serializes it (03-catalog.md §4.2).
 */
export type ResolvedCandidate = {
  tier: TierName;
  configIndex: number;
  ref: CandidateRef;
  key: CandidateKey;
  model: PhysicalChatModel;
};

/**
 * Per-tier resolution outcome. `configured` is the config's candidates array
 * by reference (verbatim); `skipped` carries candidate-level diagnostics only —
 * tier-level records never land here (spec §2.2).
 */
export type ResolvedTier = {
  tier: TierName;
  configured: readonly CandidateRef[];
  candidates: readonly ResolvedCandidate[];
  skipped: readonly CatalogDiagnostic[];
};

/**
 * Deterministic result of resolving one config against one snapshot. All three
 * tier keys are always present, even when a registry snapshot failed (spec
 * §2.2 / 03-catalog.md §5.4).
 */
export type CatalogResolution = {
  tiers: Record<TierName, ResolvedTier>;
  /**
   * Flat, deterministic: per tier in brain -> pillar -> crowd order, tier-level
   * records first, then candidate-level skips in authored order.
   */
  diagnostics: readonly CatalogDiagnostic[];
  /** Snapshot problems carried separately, never expanded into diagnostics. */
  snapshotProblems: readonly RegistrySnapshotProblem[];
};

/** Capability facts copied from one physical SDK model. */
export type ModelCapabilities = {
  input: readonly ("text" | "image")[];
  reasoning: boolean;
  supportedThinkingLevels: readonly ModelThinkingLevel[];
  contextWindow: number;
  maxTokens: number;
};

/** Requested and SDK-effective thinking levels exposed before dispatch. */
export type ThinkingClamp = {
  requested: ModelThinkingLevel;
  effective: ModelThinkingLevel;
  clamped: boolean;
};

/** Fixed, non-persisted policy for one routing tier. */
export type TierPolicy = {
  preferredThinking: ModelThinkingLevel;
  minimumThinking: ModelThinkingLevel;
  requiresReasoning: boolean;
};

export type CandidateFailureCode =
  | "invalid_model_capability"
  | "input_unsupported"
  | "context_too_small"
  | "output_limit_too_small"
  | "reasoning_unsupported"
  | "thinking_below_minimum"
  | "invalid_task_constraint";

export type CandidateFailure = {
  code: CandidateFailureCode;
  detail?:
    | "metadata"
    | "required_input"
    | "context_window"
    | "max_tokens"
    | "reasoning"
    | "thinking";
};

export type CandidateEvaluation =
  | {
      eligible: true;
      candidate: ResolvedCandidate;
      capabilities: ModelCapabilities;
      thinking: ThinkingClamp;
    }
  | {
      eligible: false;
      candidate: ResolvedCandidate;
      capabilities: ModelCapabilities | undefined;
      failures: readonly CandidateFailure[];
    };

export type TierSelection = {
  tier: TierName;
  requestedThinking: ModelThinkingLevel;
  selected: Extract<CandidateEvaluation, { eligible: true }> | undefined;
  evaluations: readonly CandidateEvaluation[];
  exhausted: boolean;
};

export type TaskConstraints = {
  requiredInput?: "text" | "image";
  minimumContextWindow?: number;
  minimumOutputTokens?: number;
  requiresReasoning?: boolean;
  minimumThinkingLevel?: ModelThinkingLevel;
};

export type NormalizedTaskConstraints = {
  requiredInput?: "text" | "image";
  minimumContextWindow?: number;
  minimumOutputTokens?: number;
  requiresReasoning: boolean;
  minimumThinkingLevel: ModelThinkingLevel;
};

export type InvalidTaskConstraint = {
  invalid: true;
};
