/**
 * Pi compatibility floor probe (06-fallback-diagnostics.md §3.5 check 6, §6.2, F6.3).
 *
 * Pure version + API-surface inspection with no Pi import, no I/O, and no
 * process introspection: the caller supplies the runtime `VERSION` string and
 * the presence booleans of the required API faces, so the same probe runs in
 * unit tests, doctor collection, and a live host without any environment
 * coupling.
 *
 * Verdict semantics (spec 2026-10-08_add-ms-doctor-command §2.2):
 * - `VERSION >= 1.0.4` and every required face present → `versionStatus`
 *   "pass" and `missingApis` empty;
 * - a below-floor version → `versionStatus` "error" (`below_floor`);
 * - an unparseable or absent version → `versionStatus` "warning"
 *   (`version_unknown`) — an unverifiable version never fabricates a pass;
 * - a missing API face is reported independently through `missingApis`
 *   (`api_missing`) and dominates the check regardless of the version.
 *
 * Version comparison is a strict numeric major.minor.patch comparison against
 * the floor: any string that is not exactly three dot-separated numeric fields
 * is "unknown", never partially parsed into a pass.
 */

/** Compatibility floor this package was verified against (Pi 1.0.4). */
export const MINIMUM_PI_VERSION = "1.0.4" as const;

/**
 * The host API faces doctor requires, in stable probe order: the three
 * `ExtensionAPI` methods the package registers through, plus the four
 * command-context faces collection reads (branch access, model lookup,
 * availability, provider-auth presence).
 */
export type RequiredApiName =
  | "registerVirtualModel"
  | "registerCommand"
  | "appendEntry"
  | "session_branch_access"
  | "model_find"
  | "model_availability"
  | "provider_auth_status";

/** Canonical probe order; `missingApis` preserves it. */
export const REQUIRED_API_NAMES: readonly RequiredApiName[] = [
  "registerVirtualModel",
  "registerCommand",
  "appendEntry",
  "session_branch_access",
  "model_find",
  "model_availability",
  "provider_auth_status",
];

/** The pi-side subset of the required faces (probed through the wiring map). */
export type PiApiName = Extract<
  RequiredApiName,
  "registerVirtualModel" | "registerCommand" | "appendEntry"
>;

/** Input of the pure probe: runtime version plus presence booleans. */
export type CompatibilityInput = {
  runtimeVersion: string | undefined;
  apiPresent: Readonly<Record<RequiredApiName, boolean>>;
};

/** Frozen result (06 §4.3): version verdict plus missing-face list. */
export type CompatibilitySnapshot = {
  runtimeVersion: string | undefined;
  minimumVersion: "1.0.4";
  versionStatus: "pass" | "warning" | "error";
  missingApis: readonly string[];
};

/** Exactly three dot-separated numeric fields; anything else is unknown. */
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

const FLOOR: readonly [number, number, number] = [1, 0, 4];

/**
 * Parse a version string into numeric major/minor/patch fields; `undefined`
 * for anything that is not exactly `N.N.N`.
 */
function parseVersion(
  value: string | undefined,
): [number, number, number] | undefined {
  if (value === undefined) return undefined;
  const match = VERSION_PATTERN.exec(value);
  if (match === null) return undefined;
  return [
    Number.parseInt(match[1] ?? "", 10),
    Number.parseInt(match[2] ?? "", 10),
    Number.parseInt(match[3] ?? "", 10),
  ];
}

function isBelowFloor(
  version: [number, number, number],
  floor: readonly [number, number, number],
): boolean {
  for (let index = 0; index < 3; index += 1) {
    const actual = version[index] ?? 0;
    const required = floor[index] ?? 0;
    if (actual !== required) return actual < required;
  }
  return false;
}

/**
 * Inspect one runtime version + API-surface sample against the floor.
 * `missingApis` carries the absent face names in canonical probe order; the
 * version verdict is independent of the surface verdict so the doctor check
 * can report both facts without a combined status field.
 */
export function inspectCompatibility(input: CompatibilityInput): CompatibilitySnapshot {
  const missingApis = REQUIRED_API_NAMES.filter(
    (name) => input.apiPresent[name] !== true,
  );
  const parsed = parseVersion(input.runtimeVersion);
  const versionStatus =
    parsed === undefined
      ? "warning"
      : isBelowFloor(parsed, FLOOR)
        ? "error"
        : "pass";
  return {
    runtimeVersion: input.runtimeVersion,
    minimumVersion: MINIMUM_PI_VERSION,
    versionStatus,
    missingApis,
  };
}
