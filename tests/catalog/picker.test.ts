import { describe, expect, it } from "vitest";

import { buildCatalogPickList, type CatalogPickerRegistry } from "../../src/catalog/picker";

/**
 * Catalog picker unit tests (spec: catalog-driven-candidate-picker): pure
 * mapping from a narrow fake registry to sorted, labeled pick options.
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

describe("buildCatalogPickList", () => {
  it("sorts by provider then id and maps refs", () => {
    const options = buildCatalogPickList(
      fakeRegistry([
        { provider: "zeta", id: "fast" },
        { provider: "acme", id: "balanced" },
        { provider: "acme", id: "alpha" },
      ]),
    );
    expect(options.map((o) => `${o.ref.provider}/${o.ref.id}`)).toEqual([
      "acme/alpha",
      "acme/balanced",
      "zeta/fast",
    ]);
  });

  it("labels context window, reasoning, and missing credentials", () => {
    const options = buildCatalogPickList(
      fakeRegistry(
        [
          { provider: "acme", id: "big", contextWindow: 200000, reasoning: true },
          { provider: "acme", id: "small", contextWindow: 8000 },
          { provider: "beta", id: "plain" },
        ],
        { beta: { configured: false } },
      ),
    );
    const byLabel = new Map(options.map((o) => [o.ref.id, o.label]));
    expect(byLabel.get("big")).toBe("acme/big · 200k ctx · reasoning");
    expect(byLabel.get("small")).toBe("acme/small · 8k ctx");
    expect(byLabel.get("plain")).toBe("beta/plain · no key");
  });

  it("excludes our own virtual namespace (ts) from the pick list", () => {
    const options = buildCatalogPickList(
      fakeRegistry([
        { provider: "ts", id: "auto" },
        { provider: "acme", id: "real" },
      ]),
    );
    expect(options.map((o) => o.ref.id)).toEqual(["real"]);
  });

  it("returns an empty list for an empty registry", () => {
    expect(buildCatalogPickList(fakeRegistry([]))).toEqual([]);
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
    expect(() => buildCatalogPickList(boom)).toThrowError("registry exploded");
  });
});
