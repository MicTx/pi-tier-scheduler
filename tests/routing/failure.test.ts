import { describe, expect, it } from "vitest";

import { classifyFailure, type FailureAssessment, type FailureInput } from "../../src/routing/failure";

/**
 * Failure classifier lock (06-fallback-diagnostics.md §7.1 hooks 1–2): the
 * ten-class matrix, stable precedence, case/separator-insensitive bounded
 * matching, and the redaction invariant — no raw provider text byte ever
 * appears in the assessment.
 */

/** Compose one failure input; only the three classifier fields are read. */
function failure(
  stopReason: FailureInput["stopReason"] | undefined,
  errorMessage?: string,
  rawStopReason?: string,
): FailureInput {
  return { stopReason, errorMessage, rawStopReason };
}

/** Redaction guard: the serialized assessment must not contain any sample bytes. */
function assertNoLeak(assessment: FailureAssessment, forbidden: readonly string[]): void {
  const serialized = JSON.stringify(assessment);
  for (const sample of forbidden) {
    expect(serialized).not.toContain(sample);
  }
}

const INJECTION_SAMPLES = [
  "sk-live-999",
  "/Users/alice/secret/path",
  "anthropic/claude-secret",
  "api key was ABCDEF123456",
  "raw-stop-secret",
];

describe("classifyFailure — the ten-class matrix (hook 1)", () => {
  it.each([
    ["aborted", failure("aborted", "user cancelled mid-stream"), "aborted", "stop_reason_aborted"],
    ["context overflow (message marker)", failure("error", "prompt too long: context length exceeded"), "context_overflow", "context_marker"],
    ["context overflow (underscore form)", failure("error", "the request hit CONTEXT_LENGTH limits"), "context_overflow", "context_marker"],
    ["output capacity (message marker)", failure("error", "response too long for max output tokens"), "output_limit", "output_marker"],
    ["output capacity (length stop, no markers)", failure("length"), "output_limit", "stop_reason_length"],
    ["authentication", failure("error", "Unauthorized: invalid api key"), "authentication", "auth_marker"],
    ["quota", failure("error", "quota exceeded; billing requires payment"), "quota_exhausted", "quota_marker"],
    ["rate limit", failure("error", "Too Many Requests: rate limit hit (429)"), "rate_limited", "rate_limit_marker"],
    ["transient service", failure("error", "service unavailable after bad gateway (502)"), "transient", "transient_marker"],
    ["invalid request", failure("error", "400 bad request: unsupported parameter"), "invalid_request", "invalid_request_marker"],
    ["provider error (plain error stop)", failure("error", "stream broke mid-response"), "provider_error", "stop_reason_error"],
    ["unknown (unrecognized error stop)", failure("error", "something odd happened"), "provider_error", "stop_reason_error"],
    ["unknown (no text, no stop signal)", failure(undefined), "unknown", "no_stable_signal"],
  ] as const)(
    "%s",
    (_label, input, failureClass, signal) => {
      const result = classifyFailure(input);
      expect(result.failureClass).toBe(failureClass);
      expect(result.signal).toBe(signal);
    },
  );

  it("maps every class to the fixed RetryHint vocabulary", () => {
    const hintOf = (input: FailureInput) => classifyFailure(input).retryHint;
    expect(hintOf(failure("aborted"))).toBe("permanent");
    expect(hintOf(failure("error", "context length"))).toBe("context_overflow");
    expect(hintOf(failure("length"))).toBe("context_overflow");
    expect(hintOf(failure("error", "unauthorized"))).toBe("permanent");
    expect(hintOf(failure("error", "quota"))).toBe("permanent");
    expect(hintOf(failure("error", "rate limit"))).toBe("transient");
    expect(hintOf(failure("error", "timeout"))).toBe("transient");
    expect(hintOf(failure("error", "invalid request"))).toBe("permanent");
    expect(hintOf(failure("error", "plain failure"))).toBe("transient");
    expect(hintOf(failure(undefined))).toBe("unknown");
  });

  it("carries the class policy booleans for the fallback search", () => {
    const abortedPolicy = classifyFailure(failure("aborted"));
    expect(abortedPolicy.retryable).toBe(false);
    expect(abortedPolicy.action).toBe("abort");
    expect(abortedPolicy.tierStrategy).toBe("none");

    const auth = classifyFailure(failure("error", "unauthorized"));
    expect(auth.skipProvider).toBe(true);
    expect(auth.sameProviderFirst).toBe(false);
    expect(auth.retryable).toBe(true);
    expect(auth.tierStrategy).toBe("adjacent");

    const quota = classifyFailure(failure("error", "insufficient credits"));
    expect(quota.skipProvider).toBe(true);

    const rateLimited = classifyFailure(failure("error", "rate limit"));
    expect(rateLimited.skipProvider).toBe(false);
    expect(rateLimited.sameProviderFirst).toBe(true);

    const capacity = classifyFailure(failure("error", "prompt too long"));
    expect(capacity.tierStrategy).toBe("capacity");
    expect(capacity.sameProviderFirst).toBe(true);

    const invalidRequest = classifyFailure(failure("error", "unsupported parameter"));
    expect(invalidRequest.sameProviderFirst).toBe(false);
    expect(invalidRequest.skipProvider).toBe(false);

    const unknown = classifyFailure(failure(undefined));
    expect(unknown.sameProviderFirst).toBe(true);
    expect(unknown.tierStrategy).toBe("adjacent");
  });
});

describe("classifyFailure — stable precedence (hook 2)", () => {
  it("an aborted stop reason wins over every message marker", () => {
    const result = classifyFailure(failure("aborted", "rate limit quota unauthorized"));
    expect(result.failureClass).toBe("aborted");
    expect(result.signal).toBe("stop_reason_aborted");
    expect(result.retryable).toBe(false);
  });

  it("a context marker beats auth, quota, rate, transient, and invalid markers", () => {
    const result = classifyFailure(
      failure("error", "unauthorized quota rate limit timeout invalid request prompt too long"),
    );
    expect(result.failureClass).toBe("context_overflow");
    expect(result.signal).toBe("context_marker");
  });

  it("an auth marker beats quota, rate, transient, and invalid markers", () => {
    const result = classifyFailure(failure("error", "quota rate limit timeout bad request unauthorized"));
    expect(result.failureClass).toBe("authentication");
    expect(result.signal).toBe("auth_marker");
  });

  it("a quota marker beats rate, transient, and invalid markers", () => {
    const result = classifyFailure(failure("error", "rate limit timeout invalid request payment required"));
    expect(result.failureClass).toBe("quota_exhausted");
    expect(result.signal).toBe("quota_marker");
  });

  it("a rate-limit marker beats transient and invalid markers", () => {
    const result = classifyFailure(failure("error", "timeout bad request throttled"));
    expect(result.failureClass).toBe("rate_limited");
    expect(result.signal).toBe("rate_limit_marker");
  });

  it("a transient marker beats invalid-request markers", () => {
    const result = classifyFailure(failure("error", "bad request service unavailable"));
    expect(result.failureClass).toBe("transient");
    expect(result.signal).toBe("transient_marker");
  });

  it("a length stop reason without a context marker is output_limit, not context_overflow", () => {
    const result = classifyFailure(failure("length", "the response was truncated"));
    expect(result.failureClass).toBe("output_limit");
    expect(result.signal).toBe("stop_reason_length");
  });

  it("a length stop reason with a context marker classifies as context_overflow", () => {
    const result = classifyFailure(failure("length", "prompt too long"));
    expect(result.failureClass).toBe("context_overflow");
    expect(result.signal).toBe("context_marker");
  });

  it("an unrecognized error stop is provider_error, and no-signal input is unknown", () => {
    expect(classifyFailure(failure("error", "the framework hiccuped")).failureClass).toBe("provider_error");
    expect(classifyFailure(failure(undefined)).failureClass).toBe("unknown");
  });

  it("non-failure stop reasons answer unknown, retryable false, action stop — even with markers", () => {
    for (const stopReason of ["stop", "toolUse", "pending", "deferred"] as const) {
      const result = classifyFailure(failure(stopReason, "rate limit quota"));
      expect(result.failureClass).toBe("unknown");
      expect(result.signal).toBe("no_stable_signal");
      expect(result.retryable).toBe(false);
      expect(result.action).toBe("stop");
    }
  });
});

describe("classifyFailure — bounded, case-insensitive matching (hook 1)", () => {
  it("matches case-insensitively across case, underscores, hyphens, and control characters", () => {
    for (const text of [
      "RATE LIMIT exceeded",
      "rate_limit exceeded",
      "rate-limit exceeded",
      "rate\tlimit exceeded",
      "rate\u0000limit exceeded",
    ]) {
      expect(classifyFailure(failure("error", text)).failureClass).toBe("rate_limited");
    }
  });

  it("ignores marker text past the 4096-code-point bound", () => {
    const padding = "a".repeat(5000);
    const result = classifyFailure(failure("error", `${padding} rate limit`));
    expect(result.failureClass).toBe("provider_error");
  });

  it("still matches a marker inside the first 4096 code points", () => {
    const padding = "a".repeat(4000);
    const result = classifyFailure(failure("error", `rate limit ${padding}`));
    expect(result.failureClass).toBe("rate_limited");
  });

  it("requires exact numeric boundaries so IDs cannot masquerade as status codes", () => {
    expect(classifyFailure(failure("error", "request id429x failed")).failureClass).not.toBe("rate_limited");
    expect(classifyFailure(failure("error", "model gpt-4 reported error 50300")).failureClass).not.toBe("transient");
    expect(classifyFailure(failure("error", "server said 429")).failureClass).toBe("rate_limited");
    expect(classifyFailure(failure("error", "server said 503")).failureClass).toBe("transient");
  });
});

describe("classifyFailure — redaction invariant (hook 1)", () => {
  it("never returns raw errorMessage or rawStopReason bytes", () => {
    const results = [
      classifyFailure(failure("error", `Unauthorized for sk-live-999 at /Users/alice/secret`, "raw-stop-secret")),
      classifyFailure(failure("error", "rate limit for anthropic/claude-secret")),
      classifyFailure(failure("length", "hit api key was ABCDEF123456")),
      classifyFailure(failure("aborted", "aborted sk-live-999")),
    ];
    for (const result of results) {
      assertNoLeak(result, INJECTION_SAMPLES);
    }
  });

  it("emits only enum and boolean fields", () => {
    const result = classifyFailure(failure("error", "quota exceeded for /Users/alice"));
    expect(Object.keys(result).sort()).toEqual([
      "action",
      "failureClass",
      "retryable",
      "sameProviderFirst",
      "signal",
      "skipProvider",
      "tierStrategy",
      "retryHint",
    ].sort());
  });
});

describe("classifyFailure — malformed-failure corpus case (§3.3)", () => {
  /**
   * Corpus case `malformed-failure`: missing/invalid stop and error fields
   * must recover to the stable, non-secret conservative assessment — the
   * same `unknown` class policy the bounded retry machinery already caps
   * (attempt-bound tests), so a malformed failure can never loop.
   */
  const UNKNOWN_POLICY = {
    retryHint: "unknown",
    action: "retry_same_provider",
    retryable: true,
    skipProvider: false,
    sameProviderFirst: true,
    tierStrategy: "adjacent",
  };

  it("a message-absent failed block classifies to the stable unknown assessment", () => {
    // Router feeds `classifyFailure(request.failed?.message ?? {})`: a retry
    // whose failed block carries no message arrives here, not as a crash.
    const result = classifyFailure({});
    expect(result.failureClass).toBe("unknown");
    expect(result.signal).toBe("no_stable_signal");
    expect(result).toEqual({ failureClass: "unknown", signal: "no_stable_signal", ...UNKNOWN_POLICY });
  });

  it("an unrecognized stop-reason string is defensive: unknown, never a crash", () => {
    const result = classifyFailure(failure("future-stop-reason" as FailureInput["stopReason"]));
    expect(result).toEqual({ failureClass: "unknown", signal: "no_stable_signal", ...UNKNOWN_POLICY });
  });

  it("empty-string error text with no stop signal stays unknown without markers", () => {
    const result = classifyFailure(failure(undefined, ""));
    expect(result).toEqual({ failureClass: "unknown", signal: "no_stable_signal", ...UNKNOWN_POLICY });
  });

  it("the malformed recovery is the capped unknown policy, so the retry bounds govern it", () => {
    // Same policy object as the unknown class: maxAttemptsPerRequest and
    // maxTierSwitches terminate this path exactly like `attempt-bound` and
    // `tier-bound` (retry.test.ts stops at both ceilings).
    const malformed = classifyFailure({ stopReason: 7, errorMessage: undefined } as unknown as FailureInput);
    const opaque = classifyFailure(failure(undefined, "opaque provider noise"));
    const policyOf = ({ failureClass: _fc, signal: _sig, ...policy }: FailureAssessment) => policy;
    expect(opaque.failureClass).toBe("unknown");
    expect(policyOf(malformed)).toEqual(policyOf(opaque));
    expect(policyOf(malformed)).toEqual(UNKNOWN_POLICY);
  });

  it("malformed shapes never surface raw or prototype bytes", () => {
    const hostile = classifyFailure({
      stopReason: "constructor",
      errorMessage: "__proto__ sk-live-999 /Users/alice/secret/path",
      rawStopReason: "raw-stop-secret",
    } as unknown as FailureInput);
    assertNoLeak(hostile, [...INJECTION_SAMPLES, "__proto__", "constructor"]);
  });
});
