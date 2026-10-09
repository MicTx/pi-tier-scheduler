import { isModelType, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  resolveCatalog,
  selectFirstEligible,
  type CatalogRegistry,
  type ResolvedCandidate,
  type TaskConstraints,
} from "../catalog";
import { PI_VIRTUAL_API } from "../catalog/constants";
import type { EffectiveConfig, TierName } from "../config/types";
import {
  adjustTierForBias,
  adjustTierForComplexity,
  fallbackOrder,
  normalizeBias,
  thinkingForBias,
  tierForPhase,
} from "./bias";
import { deriveRouteFacts } from "./facts";
import { classifyFailure } from "./failure";
import {
  chooseFallback,
  failureContextOf,
  type FallbackRequest,
  type RouteFailureContext,
} from "./fallback";
import {
  RouteLimitExceeded,
  RoutingError,
  sameCandidate,
} from "./retry";
import { isTier, sanitizeRouterState, VALID_TIERS } from "./state";
import {
  ROUTER_CONTROL_ENTRY,
  type BiasNormalization,
  type ControlResult,
  type RouteContext,
  type RouteDecision,
  type RouteReason,
  type RouteRequest,
  type RouterControlEntry,
  type RouterState,
  type RoutingDependencies,
} from "./types";

export class NoEligiblePhysicalModel extends RoutingError {
  constructor() {
    super("no_eligible_physical_model", "No eligible physical model is available for ts/auto");
    this.name = "NoEligiblePhysicalModel";
  }
}

function readControlEntry(entry: SessionEntry): ControlResult | undefined {
  if (entry.type !== "custom" || entry.customType !== ROUTER_CONTROL_ENTRY) return undefined;
  const value = entry.data as Partial<RouterControlEntry> | null | undefined;
  if (value?.schemaVersion !== 1 || !isTier(value.manualOverride) && value.manualOverride !== null) {
    return { manualOverride: null, recovered: true };
  }
  return { manualOverride: value.manualOverride, recovered: false };
}

export function readLatestRouterControl(branch: readonly SessionEntry[]): ControlResult {
  let result: ControlResult = { manualOverride: null, recovered: false };
  for (const entry of branch) {
    const parsed = readControlEntry(entry);
    if (parsed !== undefined) result = { ...parsed, recovered: result.recovered || parsed.recovered };
  }
  return result;
}

function branchFor(ctx: RouteContext, dependencies: RoutingDependencies): readonly SessionEntry[] {
  if (dependencies.branch !== undefined) return dependencies.branch;
  try {
    return ctx.sessionManager.getBranch();
  } catch {
    return [];
  }
}

function makeState(
  request: RouteRequest,
  state: RouterState | undefined,
  facts: ReturnType<typeof deriveRouteFacts>,
  bias: import("../config/types").ThinkingBias,
  manualOverride: TierName | null,
  selected: ResolvedCandidate,
  thinkingLevel: ModelThinkingLevel,
  sticky: boolean,
  overrides: Partial<Pick<RouterState, "attempts" | "tierSwitches" | "attempted">> = {},
): RouterState {
  return {
    schemaVersion: 1,
    turn: (state?.turn ?? 0) + (request.reason === "user" ? 1 : 0),
    phase: facts.phase,
    complexity: facts.complexity,
    bias,
    manualOverride,
    sticky,
    attempts: overrides.attempts ?? state?.attempts ?? 0,
    tierSwitches: overrides.tierSwitches ?? state?.tierSwitches ?? 0,
    attempted: overrides.attempted ?? state?.attempted ?? [],
    activeTier: selected.tier,
    activeCandidate: { provider: selected.ref.provider, id: selected.ref.id },
    activeThinking: thinkingLevel,
  };
}

function baseReason(
  requestedTier: TierName,
  selectedTier: TierName,
  facts: ReturnType<typeof deriveRouteFacts>,
  bias: import("../config/types").ThinkingBias,
  baseTier: TierName,
  complexityTier: TierName,
  biasedTier: TierName,
  code: RouteReason["code"],
): RouteReason {
  return {
    code,
    requestedTier,
    selectedTier,
    phase: facts.phase,
    complexity: facts.complexity,
    bias,
    baseTier,
    complexityTier,
    biasedTier,
  };
}

function reasonCode(
  request: RouteRequest,
  manual: TierName | null,
  selected: TierName,
  requested: TierName,
  base: TierName,
  complexityTier: TierName,
  biasedTier: TierName,
  biasRecovered: boolean,
  controlRecovered: boolean,
): RouteReason["code"] {
  if (controlRecovered) return "invalid_control_recovered";
  if (biasRecovered) return "invalid_bias_recovered";
  if (request.reason === "direct") return "direct";
  if (manual !== null) return selected === manual ? "manual_override" : "manual_override_fallback";
  if (selected !== requested) return "automatic_fallback";
  if (biasedTier !== complexityTier) return "thinking_bias";
  if (complexityTier !== base) return "complexity_adjustment";
  return "work_phase";
}

function physicalModel(model: Model<Api> | undefined): model is Model<Api> {
  return model !== undefined && model.api !== PI_VIRTUAL_API && isModelType(model, "chat");
}

function constraintsFor(facts: ReturnType<typeof deriveRouteFacts>): TaskConstraints {
  return {
    ...(facts.hasImageInput ? { requiredInput: "image" as const } : {}),
    ...(facts.complexity === "high" ? { requiresReasoning: true, minimumThinkingLevel: "medium" as const } : {}),
  };
}

function factsForRequest(
  request: RouteRequest,
  facts: ReturnType<typeof deriveRouteFacts>,
  state: RouterState | undefined,
  recovered: boolean,
): ReturnType<typeof deriveRouteFacts> {
  // Recovery starts from a fresh classification (04-routing.md §3.9): a rebuilt
  // state never feeds retained phase/complexity back into the route.
  if (recovered) return facts;
  if (request.reason !== "continuation" && request.reason !== "retry") return facts;
  if (state === undefined) return facts;
  return { ...facts, phase: state.phase, complexity: state.complexity };
}

function findTierForIdentity(
  resolution: ReturnType<typeof resolveCatalog>,
  identity: { provider: string; id: string } | undefined,
  preferred: TierName | null | undefined,
): TierName | null {
  if (identity === undefined) return preferred ?? null;
  if (preferred !== null && preferred !== undefined && resolution.tiers[preferred].candidates.some((candidate) => sameCandidate(candidate.ref, identity))) {
    return preferred;
  }
  for (const tier of VALID_TIERS) {
    if (resolution.tiers[tier].candidates.some((candidate) => sameCandidate(candidate.ref, identity))) return tier;
  }
  return preferred ?? null;
}

function evaluatePrevious(
  resolution: ReturnType<typeof resolveCatalog>,
  previous: RouteRequest["previous"],
  tier: TierName | null,
  constraints: TaskConstraints,
  requestedThinking: ModelThinkingLevel,
): { candidate: ResolvedCandidate; thinking: ModelThinkingLevel } | undefined {
  if (!physicalModel(previous?.model) || tier === null) return undefined;
  const resolved = resolution.tiers[tier].candidates.find((candidate) => sameCandidate(candidate.ref, previous.model));
  if (resolved === undefined) return undefined;
  const outcome = selectFirstEligible(
    { ...resolution.tiers[tier], candidates: [resolved] },
    previous.thinkingLevel ?? requestedThinking,
    constraints,
  );
  return outcome.selected === undefined
    ? undefined
    : { candidate: resolved, thinking: outcome.selected.thinking.effective };
}

function selectFresh(
  resolution: ReturnType<typeof resolveCatalog>,
  order: readonly TierName[],
  thinking: ModelThinkingLevel,
  constraints: TaskConstraints,
): { candidate: ResolvedCandidate; thinking: ModelThinkingLevel } | undefined {
  for (const tier of order) {
    const outcome = selectFirstEligible(resolution.tiers[tier], thinking, constraints);
    if (outcome.selected !== undefined) {
      return { candidate: outcome.selected.candidate, thinking: outcome.selected.thinking.effective };
    }
  }
  return undefined;
}

/**
 * Attach the JSON-safe failure context to a Phase 4 RoutingError (06 §3.3):
 * same class, same code, same message — plus the context the F6.2 log sink
 * reads through `inspectRouteFailure`. The slot is additive; no existing
 * error behavior changes.
 */
function withRouteFailure(error: RoutingError, context: RouteFailureContext): never {
  (error as RoutingError & { routeFailure?: RouteFailureContext }).routeFailure = context;
  throw error;
}

/** Values the retry leg reuses from the outer routing decision. */
interface RetryLegShared {
  state: RouterState | undefined;
  manual: TierName | null;
  requestedTier: TierName;
  failedTier: TierName | null;
  constraints: TaskConstraints;
  resolution: ReturnType<typeof resolveCatalog>;
  requestedThinking: ModelThinkingLevel;
  facts: ReturnType<typeof deriveRouteFacts>;
  bias: import("../config/types").ThinkingBias;
  baseTier: TierName;
  complexityTier: TierName;
  biasedTier: TierName;
  stateRecovered: boolean;
  sticky: boolean;
}

/**
 * Bounded retry leg (06-fallback-diagnostics.md §3.2/§3.3, §5.1): classify
 * the failed attempt, then let the pure fallback policy select the next
 * physical candidate inside the configured ceilings. An `aborted`
 * assessment is a defensive terminal (Pi 1.0.4 never re-routes an aborted
 * response): the branch state stays unchanged, no budget is consumed, and
 * the mapped `route_limit_exceeded` error ends the turn. Terminal selections
 * throw the identically-coded Phase 4 errors carrying the safe context.
 */
function routeRetryLeg(
  request: RouteRequest,
  dependencies: RoutingDependencies,
  shared: RetryLegShared,
): RouteDecision {
  const assessment = classifyFailure(request.failed?.message ?? {});

  if (assessment.failureClass === "aborted") {
    // Defensive terminal (§3.3): no selection, no recursion, no budget spent.
    throw new RoutingError("route_limit_exceeded", "request aborted; no alternate route");
  }

  const failedModel = request.failed?.model;
  if (failedModel === undefined || shared.failedTier === null) {
    // The SDK contract guarantees a physical `failed` model on retry; a
    // missing identity means no alternate can be named safely.
    throw new NoEligiblePhysicalModel();
  }

  const fallbackInput: FallbackRequest = {
    requestReason: request.reason,
    failed: { provider: failedModel.provider, id: failedModel.id, tier: shared.failedTier },
    assessment,
    state: shared.state,
    catalog: shared.resolution,
    constraints: shared.constraints,
    config: dependencies.config,
    requestedThinking: shared.requestedThinking,
  };
  const selection = chooseFallback(fallbackInput);

  if (selection.terminalCode !== undefined) {
    const context = failureContextOf(fallbackInput, selection);
    if (selection.terminalCode === "route_limit_exceeded") {
      throw withRouteFailure(new RouteLimitExceeded(), context);
    }
    throw withRouteFailure(new NoEligiblePhysicalModel(), context);
  }

  const chosen = selection.selected?.selected;
  if (chosen === undefined || selection.selectedTier === null || selection.selectedThinking === null) {
    // Defensive: a non-terminal selection always carries a chosen candidate.
    throw new RoutingError("invalid_route_result", "fallback selection produced no candidate");
  }

  const reason = baseReason(
    shared.requestedTier,
    selection.selectedTier,
    shared.facts,
    shared.bias,
    shared.baseTier,
    shared.complexityTier,
    shared.biasedTier,
    shared.stateRecovered
      ? "state_recovered"
      : selection.selectedTier === shared.failedTier
        ? "retry_same_tier"
        : "retry_tier_fallback",
  );
  reason.retryHint = assessment.retryHint;
  reason.attempt = selection.attempts;
  reason.maxAttempts = dependencies.config.retry.maxAttemptsPerRequest;
  reason.tierSwitches = selection.tierSwitches;
  reason.maxTierSwitches = dependencies.config.retry.maxTierSwitches;
  reason.failedCandidate = { provider: failedModel.provider, id: failedModel.id };
  if (selection.selectedTier !== shared.requestedTier) reason.fallbackFrom = shared.requestedTier;
  reason.candidateIndex = chosen.candidate.configIndex;
  return {
    model: chosen.candidate.model,
    thinkingLevel: selection.selectedThinking,
    tier: selection.selectedTier,
    candidate: { provider: chosen.candidate.ref.provider, id: chosen.candidate.ref.id },
    reason,
    state: makeState(
      request,
      shared.state,
      shared.facts,
      shared.bias,
      shared.manual,
      chosen.candidate,
      selection.selectedThinking,
      shared.sticky,
      {
        attempts: selection.attempts,
        tierSwitches: selection.tierSwitches,
        attempted: selection.attempted,
      },
    ),
  };
}

/** Make one bounded, local routing decision. The catalog is snapshotted once. */
export function routeRequest(
  request: RouteRequest,
  ctx: RouteContext,
  dependencies: RoutingDependencies,
): RouteDecision {
  const registry: CatalogRegistry = dependencies.registry ?? ctx.modelRegistry;
  // Invariant order (04-routing.md §3.1): sanitize state first, then derive facts.
  const normalized = normalizeBias(request.thinkingLevel, dependencies.config.policy.defaultBias);
  const sanitized = sanitizeRouterState(request.state, normalized.bias);
  const state = sanitized.state;
  const rawFacts = deriveRouteFacts(request.messages);
  const facts = factsForRequest(request, rawFacts, state, sanitized.recovered);
  const bias: BiasNormalization = state !== undefined && (request.reason === "continuation" || request.reason === "retry")
    ? { bias: state.bias, recovered: sanitized.biasRecovered || normalized.recovered }
    : normalized;
  const branch = branchFor(ctx, dependencies);
  const control = readLatestRouterControl(branch);
  const hasControlEntry = branch.some((entry) => entry.type === "custom" && entry.customType === ROUTER_CONTROL_ENTRY);
  // Manual precedence (04-routing.md §3.5): the latest control entry sets or
  // clears the override; the state mirror applies only when the branch has
  // no control entry at all (e.g. a failed branch read).
  const manual = hasControlEntry ? control.manualOverride : (state?.manualOverride ?? null);

  const baseTier = tierForPhase(facts.phase);
  const complexityTier = adjustTierForComplexity(baseTier, facts.complexity);
  const biasedTier = adjustTierForBias(complexityTier, bias.bias);
  const requestedTier = manual ?? biasedTier;
  const constraints = constraintsFor(facts);
  const resolution = resolveCatalog(dependencies.config, registry);
  const normalOrder = fallbackOrder(requestedTier, manual !== null);

  if (request.reason === "retry") {
    return routeRetryLeg(request, dependencies, {
      state,
      manual,
      requestedTier,
      failedTier: findTierForIdentity(resolution, request.failed?.model, state?.activeTier),
      constraints,
      resolution,
      requestedThinking: thinkingForBias(bias.bias),
      facts,
      bias: bias.bias,
      baseTier,
      complexityTier,
      biasedTier,
      stateRecovered: sanitized.recovered,
      sticky: dependencies.config.policy.sticky,
    });
  }

  const activeTier = state?.activeTier ?? requestedTier;
  const stickySuperseded = state !== undefined && hasControlEntry && control.manualOverride !== state.manualOverride;
  const stickyCandidate = request.reason === "continuation"
      && dependencies.config.policy.sticky
      && state?.sticky === true
      && !stickySuperseded
      && !sanitized.recovered
    ? evaluatePrevious(resolution, request.previous, activeTier, constraints, thinkingForBias(bias.bias))
    : undefined;
  if (stickyCandidate !== undefined && state !== undefined) {
    const reason = baseReason(
      activeTier,
      stickyCandidate.candidate.tier,
      facts,
      bias.bias,
      baseTier,
      complexityTier,
      biasedTier,
      "sticky_continuation",
    );
    reason.candidateIndex = stickyCandidate.candidate.configIndex;
    return {
      model: stickyCandidate.candidate.model,
      thinkingLevel: stickyCandidate.thinking,
      tier: stickyCandidate.candidate.tier,
      candidate: { provider: stickyCandidate.candidate.ref.provider, id: stickyCandidate.candidate.ref.id },
      reason,
      state,
    };
  }

  const directPrevious = request.reason === "direct"
    ? evaluatePrevious(resolution, request.previous, activeTier, constraints, thinkingForBias(bias.bias))
    : undefined;
  const selected = directPrevious ?? selectFresh(resolution, normalOrder, thinkingForBias(bias.bias), constraints);
  if (selected === undefined) throw new NoEligiblePhysicalModel();
  const code = sanitized.recovered
    ? "state_recovered"
    : request.reason === "continuation" && state !== undefined
      ? "sticky_invalidated"
      : reasonCode(request, manual, selected.candidate.tier, requestedTier, baseTier, complexityTier, biasedTier, bias.recovered, control.recovered);
  const reason = baseReason(requestedTier, selected.candidate.tier, facts, bias.bias, baseTier, complexityTier, biasedTier, code);
  if (selected.candidate.tier !== requestedTier) reason.fallbackFrom = requestedTier;
  reason.candidateIndex = selected.candidate.configIndex;
  const initialAttempted = request.reason === "user"
    ? [{ provider: selected.candidate.ref.provider, id: selected.candidate.ref.id, tier: selected.candidate.tier }]
    : state?.attempted ?? [];
  return {
    model: selected.candidate.model,
    thinkingLevel: selected.thinking,
    tier: selected.candidate.tier,
    candidate: { provider: selected.candidate.ref.provider, id: selected.candidate.ref.id },
    reason,
    // Direct requests have no branch state and Pi ignores any returned state;
    // staying undefined keeps the contract explicit (04-routing.md §3.9).
    state: request.reason === "direct"
      ? undefined
      : makeState(
        request,
        state,
        facts,
        bias.bias,
        manual,
        selected.candidate,
        selected.thinking,
        dependencies.config.policy.sticky,
        { attempts: request.reason === "user" ? 1 : state?.attempts ?? 0, attempted: initialAttempted },
      ),
  };
}

export function routeRequestAsModelRoute(
  request: RouteRequest,
  ctx: RouteContext,
  dependencies: RoutingDependencies,
): { model: RouteDecision["model"]; thinkingLevel: ModelThinkingLevel; state?: RouterState } {
  const decision = routeRequest(request, ctx, dependencies);
  return { model: decision.model, thinkingLevel: decision.thinkingLevel, state: decision.state };
}

export type { EffectiveConfig };
export { RouteLimitExceeded, RoutingError };
