/**
 * Catalog-driven candidate picker (spec: 2026-10-09_add-catalog-driven-candidate-picker).
 *
 * Turns Pi's machine-readable model registry into the labeled option list the
 * configuration dialogs offer instead of free-text provider/id entry. Pure
 * module: a narrow structural registry goes in, sorted pick options come out.
 * Registry exceptions propagate to the caller — the command face catches them
 * and degrades to the pre-existing text path (fail-soft, matching the
 * snapshot discipline in snapshot.ts).
 */
import type { Api, Model } from "@earendil-works/pi-ai";

import type { CandidateRef } from "../config/types";
import { PROVIDER_NAMESPACE } from "../shared/constants";

/**
 * Narrow registry surface the picker reads — structural, so the live
 * ModelRegistry and the test fakes both satisfy it without an import.
 */
export interface CatalogPickerRegistry {
  getModelsOfType(type: "chat"): readonly Model<Api>[];
  getProviderAuthStatus(provider: string): { configured: boolean };
}

/** One selectable catalog entry: the pick label and the ref it stands for. */
export interface CatalogPickOption {
  ref: CandidateRef;
  label: string;
}

/** Our own virtual model never belongs in a candidate list. */
function isOwnVirtualModel(provider: string): boolean {
  return provider === PROVIDER_NAMESPACE;
}

/** Compact token count: 200000 → "200k", 8000 → "8k"; raw when smaller. */
function contextLabel(contextWindow: number | undefined): string | null {
  if (contextWindow === undefined || contextWindow <= 0) return null;
  return contextWindow >= 1000 ? `${Math.round(contextWindow / 1000)}k ctx` : `${contextWindow} ctx`;
}

/**
 * Build the pick list for one dialog session: chat models only, our own
 * virtual namespace excluded, sorted by provider then id, each labeled with
 * the context window, the reasoning flag, and the credential badge so the
 * user can see eligibility before picking.
 */
export function buildCatalogPickList(registry: CatalogPickerRegistry): CatalogPickOption[] {
  const models = registry.getModelsOfType("chat");
  const picked = models
    .filter((model) => !isOwnVirtualModel(model.provider))
    .map((model) => {
      const parts: string[] = [];
      const context = contextLabel(model.contextWindow);
      if (context !== null) parts.push(context);
      if (model.reasoning === true) parts.push("reasoning");
      if (!registry.getProviderAuthStatus(model.provider).configured) parts.push("no key");
      return {
        ref: { provider: model.provider, id: model.id },
        label: parts.length > 0 ? `${model.provider}/${model.id} · ${parts.join(" · ")}` : `${model.provider}/${model.id}`,
      };
    })
    .sort((a, b) =>
      a.ref.provider === b.ref.provider
        ? a.ref.id.localeCompare(b.ref.id)
        : a.ref.provider.localeCompare(b.ref.provider),
    );
  // provider/id pairs are unique inside one registry snapshot, so labels are
  // unique by construction; assert it cheaply against future field changes.
  const seen = new Set<string>();
  for (const option of picked) {
    if (seen.has(option.label)) {
      throw new Error(`duplicate catalog pick label: ${option.label}`);
    }
    seen.add(option.label);
  }
  return picked;
}
