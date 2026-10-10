import { describe, expect, it } from "vitest";

import { buildCatalogPickGroups, type CatalogPickerRegistry } from "../../src/catalog/picker";

/**
 * Catalog picker unit tests (catalog-driven-candidate-picker; 0.3.2
 * refinements): pure mapping from a narrow fake registry to credential-
 * filtered, provider-grouped pick options.
 */

interface FakeModel {
  provider: string;
  id: string;
  contextWindow?: number;
  reasoning?: boolean;
}

function fakeRegistry(
  models: readonly FakeModel[],
  auth: Readonly<Record<string, { configured: boolean }>> = {},
): CatalogPickerRegistry {
  return {
    getModelsOfType(type: "chat") {
      expect(type).toBe("chat");
      return models as never;
    },
    getProviderAuthStatus(provider: string) {
      return auth[provider] ?? { configured: true };
    },
  };
}

describe("buildCatalogPickGroups", () => {
  it("groups by provider, sorted, with models sorted by id", () => {
    const groups = buildCatalogPickGroups(
      fakeRegistry([
        { provider: "zeta", id: "fast" },
        { provider: "acme", id: "balanced" },
        { provider: "acme", id: "alpha" },
      ]),
    );
    expect(groups.map((g) => g.provider)).toEqual(["acme", "zeta"]);
    expect(groups[0]!.models.map((m) => m.ref.id)).toEqual(["alpha", "balanced"]);
    expect(groups[1]!.models.map((m) => m.ref.id)).toEqual(["fast"]);
  });

  it("filters providers without credentials entirely", () => {
    const groups = buildCatalogPickGroups(
      fakeRegistry(
        [
          { provider: "acme", id: "big" },
          { provider: "beta", id: "plain" },
        ],
        { beta: { configured: false } },
      ),
    );
    expect(groups.map((g) => g.provider)).toEqual(["acme"]);
  });

  it("labels carry context window and reasoning, not the provider or auth state", () => {
    const groups = buildCatalogPickGroups(
      fakeRegistry([
        { provider: "acme", id: "big", contextWindow: 200000, reasoning: true },
        { provider: "acme", id: "small", contextWindow: 8000 },
        { provider: "acme", id: "plain" },
      ]),
    );
    const labels = groups[0]!.models.map((m) => m.label);
    expect(labels).toEqual(["big · 200k ctx · reasoning", "plain", "small · 8k ctx"]);
  });

  it("excludes our own virtual namespace (ts) from the pick groups", () => {
    const groups = buildCatalogPickGroups(
      fakeRegistry([
        { provider: "ts", id: "auto" },
        { provider: "acme", id: "real" },
      ]),
    );
    expect(groups.map((g) => g.provider)).toEqual(["acme"]);
  });

  it("returns an empty group list for an empty registry", () => {
    expect(buildCatalogPickGroups(fakeRegistry([]))).toEqual([]);
  });

  it("propagates registry exceptions to the caller", () => {
    const boom: CatalogPickerRegistry = {
      getModelsOfType() {
        throw new Error("registry exploded");
      },
      getProviderAuthStatus() {
        return { configured: true };
      },
    };
    expect(() => buildCatalogPickGroups(boom)).toThrowError("registry exploded");
  });
});
