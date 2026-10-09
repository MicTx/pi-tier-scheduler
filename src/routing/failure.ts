import type { AssistantMessage } from "@earendil-works/pi-ai";

import type { RetryHint } from "./types";

/**
 * Failure classification core (06-fallback-diagnostics.md §3.1, F6.1).
 *
 * Pure, deterministic, and bounded: one failure input in, one stable
 * assessment out. The error text is normalized (at most 4096 code points,
 * case-folded, control characters and separator characters folded to spaces)
 * and used only for marker matching; neither the normalized string, the raw
 * `errorMessage`, nor `rawStopReason` ever crosses this function's boundary.
 * A provider message may mention model IDs, keys, or paths — none of those
 * bytes can appear in the returned value because the assessment carries only
 * enum and boolean fields.
 */

/** Normalization bound: the classifier inspects at most this many code points. */
const FAILURE_TEXT_LIMIT_CODEPOINTS = 4096;

/**
 * Exactly the failure fields the classifier consumes; nothing else is read.
 * `stopReason`/`errorMessage` are optional here because a defensive
 * classifier must answer malformed or partial fakes with `unknown` rather
 * than assuming the SDK always delivers a well-formed message.
 */
export type FailureInput = {
  stopReason?: AssistantMessage["stopReason"];
  errorMessage?: AssistantMessage["errorMessage"];
  rawStopReason?: AssistantMessage["rawStopReason"];
};

/** Stable failure vocabulary; the log sink (F6.2) stores these codes only. */
export type FailureClass =
  | "aborted"
  | "context_overflow"
  | "output_limit"
  | "authentication"
  | "quota_exhausted"
  | "rate_limited"
  | "transient"
  | "invalid_request"
  | "provider_error"
  | "unknown";

/** Coarse action the bounded policy derives from the class (§3.1 table). */
export type RetryAction =
  | "abort"
  | "retry_same_provider"
  | "try_next_candidate"
  | "switch_tier"
  | "stop";

/** How the fallback search crosses tiers for this failure class. */
export type TierFallbackStrategy = "capacity" | "escalate" | "degrade" | "adjacent" | "none";

/** Which stable signal produced the class; never carries matched text. */
export type FailureSignal =
  | "stop_reason_aborted"
  | "context_marker"
  | "output_marker"
  | "auth_marker"
  | "quota_marker"
  | "rate_limit_marker"
  | "transient_marker"
  | "invalid_request_marker"
  | "stop_reason_error"
  | "stop_reason_length"
  | "no_stable_signal";

/** Bounded assessment: enums and booleans only, no raw provider bytes. */
export type FailureAssessment = {
  failureClass: FailureClass;
  retryHint: RetryHint;
  action: RetryAction;
  retryable: boolean;
  skipProvider: boolean;
  sameProviderFirst: boolean;
  tierStrategy: TierFallbackStrategy;
  signal: FailureSignal;
};

/**
 * Fixed class policy (§3.1 mapping table). `retryable` means "an alternate
 * route may be attempted", never "repeat the same physical request"; the
 * capacity classes keep `sameProviderFirst` true because the fallback
 * enforces the strictly-larger-capacity constraint itself (§3.2).
 */
const CLASS_POLICY: Readonly<
  Record<FailureClass, Omit<FailureAssessment, "failureClass" | "signal">>
> = {
  aborted: {
    retryHint: "permanent",
    action: "abort",
    retryable: false,
    skipProvider: false,
    sameProviderFirst: false,
    tierStrategy: "none",
  },
  context_overflow: {
    retryHint: "context_overflow",
    action: "try_next_candidate",
    retryable: true,
    skipProvider: false,
    sameProviderFirst: true,
    tierStrategy: "capacity",
  },
  output_limit: {
    retryHint: "context_overflow",
    action: "try_next_candidate",
    retryable: true,
    skipProvider: false,
    sameProviderFirst: true,
    tierStrategy: "capacity",
  },
  authentication: {
    retryHint: "permanent",
    action: "try_next_candidate",
    retryable: true,
    skipProvider: true,
    sameProviderFirst: false,
    tierStrategy: "adjacent",
  },
  quota_exhausted: {
    retryHint: "permanent",
    action: "try_next_candidate",
    retryable: true,
    skipProvider: true,
    sameProviderFirst: false,
    tierStrategy: "adjacent",
  },
  rate_limited: {
    retryHint: "transient",
    action: "retry_same_provider",
    retryable: true,
    skipProvider: false,
    sameProviderFirst: true,
    tierStrategy: "adjacent",
  },
  transient: {
    retryHint: "transient",
    action: "retry_same_provider",
    retryable: true,
    skipProvider: false,
    sameProviderFirst: true,
    tierStrategy: "adjacent",
  },
  invalid_request: {
    retryHint: "permanent",
    action: "try_next_candidate",
    retryable: true,
    skipProvider: false,
    sameProviderFirst: false,
    tierStrategy: "adjacent",
  },
  provider_error: {
    retryHint: "transient",
    action: "retry_same_provider",
    retryable: true,
    skipProvider: false,
    sameProviderFirst: true,
    tierStrategy: "adjacent",
  },
  unknown: {
    retryHint: "unknown",
    action: "retry_same_provider",
    retryable: true,
    skipProvider: false,
    sameProviderFirst: true,
    tierStrategy: "adjacent",
  },
};

/**
 * Marker table in stable precedence order (§3.1 steps 2–7). Patterns run
 * against the normalized text: case-folded, control characters and `_`/`-`
 * folded to spaces, runs collapsed. Word boundaries matter only for the
 * numeric signals, which use `\b` so an ID fragment like "ID429x" cannot
 * masquerade as a 429.
 */
const MARKERS: readonly { signal: FailureSignal; failureClass: FailureClass; patterns: readonly RegExp[] }[] = [
  {
    signal: "context_marker",
    failureClass: "context_overflow",
    patterns: [
      /context length/,
      /context window/,
      /maximum context/,
      /prompt too long/,
      /too many tokens/,
      /input token limit/,
      /request too large/,
    ],
  },
  {
    signal: "output_marker",
    failureClass: "output_limit",
    patterns: [
      /output token limit/,
      /maximum output/,
      /output limit/,
      /max(?:imum)? output tokens/,
      /response too long/,
    ],
  },
  {
    signal: "auth_marker",
    failureClass: "authentication",
    patterns: [
      /unauthorized/,
      /invalid api key/,
      /authentication/,
      /credentials/,
      /\b403\b/,
      /forbidden/,
    ],
  },
  {
    signal: "quota_marker",
    failureClass: "quota_exhausted",
    patterns: [
      /quota/,
      /billing/,
      /insufficient credits/,
      /spending limit/,
      /payment required/,
    ],
  },
  {
    signal: "rate_limit_marker",
    failureClass: "rate_limited",
    patterns: [
      /rate limit/,
      /too many requests/,
      /throttl/,
      /\b429\b/,
    ],
  },
  {
    signal: "transient_marker",
    failureClass: "transient",
    patterns: [
      /timed out/,
      /timeout/,
      /overload/,
      /temporarily unavailable/,
      /connection reset/,
      /service unavailable/,
      /bad gateway/,
      /\b5\d\d\b/,
    ],
  },
  {
    signal: "invalid_request_marker",
    failureClass: "invalid_request",
    patterns: [
      /bad request/,
      /invalid request/,
      /unsupported parameter/,
      /unsupported modality/,
      /not found/,
    ],
  },
];

/** Stop reasons that are not provider failures at all. */
const NON_FAILURE_STOP_REASONS: readonly unknown[] = ["stop", "toolUse", "pending", "deferred"];

/**
 * Normalize error text for marker matching only. The result is local to
 * `classifyFailure` and never escapes: the assessment stores no strings.
 */
function normalizeFailureText(value: string | undefined): string {
  if (value === undefined || value === "") return "";
  // Code-point slicing keeps the 4096 bound exact even with surrogate pairs.
  const bounded = Array.from(value).slice(0, FAILURE_TEXT_LIMIT_CODEPOINTS).join("");
  return bounded
    .toLowerCase()
    .replace(/[\p{C}_-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function assessment(failureClass: FailureClass, signal: FailureSignal): FailureAssessment {
  return { failureClass, signal, ...CLASS_POLICY[failureClass] };
}

/**
 * Classify one provider failure (§3.1). Stable precedence:
 * 1. `aborted` stop reason — user cancellation is never retried.
 * 2. Non-failure stop reasons (stop/toolUse/pending/deferred) — the caller
 *    passed something that is not a provider failure; answer `unknown`,
 *    `retryable: false`, `action: "stop"`, and never manufacture a retry.
 * 3. Marker classes in the documented order (context, output, auth, quota,
 *    rate limit, transient, invalid request) over any stop reason.
 * 4. `stopReason: "length"` without a context marker → `output_limit`.
 * 5. `stopReason: "error"` without a more specific marker → `provider_error`.
 * 6. Anything else → `unknown` with the conservative bounded policy.
 */
export function classifyFailure(input: FailureInput): FailureAssessment {
  const stopReason = input.stopReason;
  if (stopReason === "aborted") {
    return assessment("aborted", "stop_reason_aborted");
  }
  if (NON_FAILURE_STOP_REASONS.includes(stopReason)) {
    return { ...assessment("unknown", "no_stable_signal"), retryable: false, action: "stop" };
  }
  const text = normalizeFailureText(input.errorMessage);
  if (text !== "") {
    for (const marker of MARKERS) {
      if (marker.patterns.some((pattern) => pattern.test(text))) {
        return assessment(marker.failureClass, marker.signal);
      }
    }
  }
  if (stopReason === "length") return assessment("output_limit", "stop_reason_length");
  if (stopReason === "error") return assessment("provider_error", "stop_reason_error");
  return assessment("unknown", "no_stable_signal");
}
