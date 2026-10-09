import type { CompleteConfig } from "./types";

/** Recursively freezes objects, arrays, and every nested value reachable through them. */
function deepFreeze<T>(value: T): T {
  if (value !== null && (typeof value === "object" || typeof value === "function")) {
    const record = value as unknown as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(record)) {
      deepFreeze(record[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Canonical built-in configuration (02-config.md §4.1); deep-frozen before export. */
export const DEFAULT_CONFIG: CompleteConfig = deepFreeze({
  schemaVersion: 1,
  tiers: {
    brain: { candidates: [] },
    pillar: { candidates: [] },
    crowd: { candidates: [] },
  },
  policy: { defaultBias: "medium", sticky: true },
  retry: { maxAttemptsPerRequest: 3, maxTierSwitches: 2 },
});

/**
 * Returns an independent mutable deep copy of DEFAULT_CONFIG. Callers receive a clone or an
 * immutable view and cannot mutate the process-wide fallback; merge starts from this clone
 * so writing into the result can never fail on (or change) the frozen defaults.
 */
export function defaultConfig(): CompleteConfig {
  return structuredClone(DEFAULT_CONFIG);
}
