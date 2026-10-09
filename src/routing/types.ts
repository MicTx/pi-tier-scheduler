import type { Api, Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  ModelRoute,
  ModelRouteRequest,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type {
  CandidateRef,
  EffectiveConfig,
  TierName,
  ThinkingBias,
} from "../config/types";
import type { CatalogRegistry } from "../catalog/types";

export type { TierName, ThinkingBias } from "../config/types";

export type WorkPhase = "planning" | "implementation" | "verification" | "conversation" | "unknown";
export type ComplexityBand = "low" | "standard" | "high";
export type RetryHint = "context_overflow" | "transient" | "permanent" | "unknown";
export type CandidateIdentity = CandidateRef;
export type RoutingErrorCode =
  | "no_eligible_physical_model"
  | "route_limit_exceeded"
  | "invalid_route_result";

export type RetrySelection = {
  hint: RetryHint;
  failed: CandidateIdentity;
  failedTier: TierName | null;
  selected: import("../catalog/types").ResolvedCandidate | undefined;
  selectedThinking: ModelThinkingLevel | undefined;
  sameTier: boolean;
  tierSwitches: number;
  attempted: readonly AttemptedCandidate[];
};

export type MessageShapeFacts = {
  hasImageInput: boolean;
  pathLikeTokenCount: number;
  codeFenceChars: number;
  listItemCount: number;
  implementationVerbCount: number;
  hasVerificationVerb: boolean;
  hasExplicitImplementationVerb: boolean;
  hasHighScopeMarker: boolean;
  hasMultiStepPhrase: boolean;
};

export type ToolEvidence = {
  name: string;
  success: boolean;
};

export type RouteFacts = {
  phase: WorkPhase;
  complexity: ComplexityBand;
  hasImageInput: boolean;
  successfulEditEvidence: boolean;
  userMessageLength: number;
  shape: MessageShapeFacts;
};

export type AttemptedCandidate = CandidateIdentity & { tier: TierName };

export type RouterState = {
  schemaVersion: 1;
  turn: number;
  phase: WorkPhase;
  complexity: ComplexityBand;
  bias: ThinkingBias;
  manualOverride: TierName | null;
  sticky: boolean;
  attempts: number;
  tierSwitches: number;
  attempted: readonly AttemptedCandidate[];
  activeTier: TierName | null;
  activeCandidate: CandidateIdentity | null;
  activeThinking: ModelThinkingLevel | null;
};

export type RouteReasonCode =
  | "manual_override"
  | "manual_override_fallback"
  | "work_phase"
  | "complexity_adjustment"
  | "thinking_bias"
  | "automatic_fallback"
  | "sticky_continuation"
  | "sticky_invalidated"
  | "retry_same_tier"
  | "retry_tier_fallback"
  | "direct"
  | "state_recovered"
  | "invalid_bias_recovered"
  | "invalid_control_recovered"
  | "config_not_ready";

export type RouteReason = {
  code: RouteReasonCode;
  requestedTier: TierName;
  selectedTier: TierName;
  phase: WorkPhase;
  complexity: ComplexityBand;
  bias: ThinkingBias;
  baseTier: TierName;
  complexityTier: TierName;
  biasedTier: TierName;
  fallbackFrom?: TierName;
  candidateIndex?: number;
  retryHint?: RetryHint;
  attempt?: number;
  maxAttempts?: number;
  tierSwitches?: number;
  maxTierSwitches?: number;
  failedCandidate?: CandidateIdentity;
};

export type RouteDecision = {
  model: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
  tier: TierName;
  candidate: CandidateIdentity;
  reason: RouteReason;
  state?: RouterState;
};

export const ROUTER_CONTROL_ENTRY = "pi-tier-scheduler.router-control";

export type RouterControlEntry = {
  schemaVersion: 1;
  manualOverride: TierName | null;
};

export type RoutingDependencies = {
  config: EffectiveConfig;
  registry?: CatalogRegistry;
  branch?: readonly SessionEntry[];
};

export type RouteRequest = ModelRouteRequest<RouterState>;
export type RouteContext = Pick<ExtensionContext, "modelRegistry" | "sessionManager">;
export type RouteResult = ModelRoute<RouterState>;

export type BiasNormalization = {
  bias: ThinkingBias;
  recovered: boolean;
};

/**
 * Result of the route-boundary state sanitizer (04-routing.md §3.9, state.ts).
 *
 * `state` is valid by construction: known schema, plain JSON values, enums
 * inside their unions, counters inside the absolute ceilings, and the
 * attempted list capped at the absolute attempt limit. `undefined` means no
 * usable state exists — an absent input or one that could not be trusted at
 * all (non-object, unknown schema version). `recovered` marks any discarded,
 * clamped, or rebuilt field and drives the `state_recovered` route reason;
 * `biasRecovered` marks an invalid `bias` that was normalized to the fallback
 * and drives the finer-grained `invalid_bias_recovered` reason instead.
 */
export type StateRecoveryResult = {
  state: RouterState | undefined;
  recovered: boolean;
  biasRecovered: boolean;
};

export type ControlResult = {
  manualOverride: TierName | null;
  recovered: boolean;
};

export type FactsInput = Pick<Message, "role" | "content">[] | readonly Message[];
