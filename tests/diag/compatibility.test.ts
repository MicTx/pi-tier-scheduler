import { describe, expect, it } from "vitest";

import {
  inspectCompatibility,
  MINIMUM_PI_VERSION,
  REQUIRED_API_NAMES,
  type CompatibilityInput,
  type RequiredApiName,
} from "../../src/diag/compatibility";

/**
 * F6.3 compatibility probe (06-fallback-diagnostics.md §3.5 check 6,
 * §7.3 hook 2 version matrix): strict numeric major.minor.patch comparison
 * against the 1.0.4 floor, unknown versions never fabricate a pass, and the
 * API-surface verdict is independent of the version verdict.
 */

function input(
  runtimeVersion: string | undefined,
  missing: readonly RequiredApiName[] = [],
): CompatibilityInput {
  const apiPresent = {} as Record<RequiredApiName, boolean>;
  for (const name of REQUIRED_API_NAMES) {
    apiPresent[name] = !missing.includes(name);
  }
  return { runtimeVersion, apiPresent };
}

describe("MINIMUM_PI_VERSION — floor contract", () => {
  it("locks the compatibility floor at 1.0.4", () => {
    expect(MINIMUM_PI_VERSION).toBe("1.0.4");
  });

  it("fixes the required API surface and its canonical probe order", () => {
    expect(REQUIRED_API_NAMES).toEqual([
      "registerVirtualModel",
      "registerCommand",
      "appendEntry",
      "session_branch_access",
      "model_find",
      "model_availability",
      "provider_auth_status",
    ]);
  });
});

describe("inspectCompatibility — version matrix", () => {
  it("passes the exact floor and every newer numeric version", () => {
    for (const version of ["1.0.4", "1.0.5", "1.1.0", "2.0.0", "10.20.30"]) {
      const snapshot = inspectCompatibility(input(version));
      expect(snapshot.versionStatus, version).toBe("pass");
      expect(snapshot.missingApis).toEqual([]);
      expect(snapshot.runtimeVersion).toBe(version);
      expect(snapshot.minimumVersion).toBe("1.0.4");
    }
  });

  it("fails every below-floor version as an error", () => {
    for (const version of ["0.0.1", "0.9.9", "1.0.3", "1.0.0"]) {
      const snapshot = inspectCompatibility(input(version));
      expect(snapshot.versionStatus, version).toBe("error");
      expect(snapshot.missingApis).toEqual([]);
    }
  });

  it("treats unparseable or absent versions as a warning, never a pass", () => {
    for (const version of [undefined, "", "1", "1.0", "1.0.4.1", "v1.0.4", "1.0.4-beta", "garbage"]) {
      const snapshot = inspectCompatibility(input(version));
      expect(snapshot.versionStatus, String(version)).toBe("warning");
    }
  });

  it("keeps the raw version string and never invents one", () => {
    expect(inspectCompatibility(input(undefined)).runtimeVersion).toBeUndefined();
    expect(inspectCompatibility(input("0.9.9")).runtimeVersion).toBe("0.9.9");
  });
});

describe("inspectCompatibility — API surface matrix", () => {
  it("reports a missing face in canonical order without touching the version verdict", () => {
    const snapshot = inspectCompatibility(input("1.1.0", ["appendEntry"]));
    expect(snapshot.missingApis).toEqual(["appendEntry"]);
    expect(snapshot.versionStatus).toBe("pass");
  });

  it("lists multiple missing faces in canonical probe order", () => {
    const snapshot = inspectCompatibility(
      input("1.0.4", ["provider_auth_status", "registerVirtualModel", "session_branch_access"]),
    );
    expect(snapshot.missingApis).toEqual([
      "registerVirtualModel",
      "session_branch_access",
      "provider_auth_status",
    ]);
  });

  it("keeps a below-floor verdict when faces are also missing", () => {
    const snapshot = inspectCompatibility(input("1.0.3", ["model_find"]));
    expect(snapshot.versionStatus).toBe("error");
    expect(snapshot.missingApis).toEqual(["model_find"]);
  });

  it("keeps the unknown-version warning when faces are also missing", () => {
    const snapshot = inspectCompatibility(input(undefined, ["appendEntry"]));
    expect(snapshot.versionStatus).toBe("warning");
    expect(snapshot.missingApis).toEqual(["appendEntry"]);
  });

  it("is pure and deterministic: equal inputs produce equal snapshots", () => {
    const first = inspectCompatibility(input("1.0.4", ["appendEntry"]));
    const second = inspectCompatibility(input("1.0.4", ["appendEntry"]));
    expect(first).toEqual(second);
  });
});
