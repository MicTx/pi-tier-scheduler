/**
 * Catalog-driven candidate picker (spec: catalog-driven-candidate-picker;
 * 0.3.2 refinements: credential filter + two-level navigation).
 *
 * Turns Pi's machine-readable model registry into the pick options the
 * configuration dialogs offer instead of free-text provider/id entry. Pure
 * module: a narrow structural registry goes in, provider-grouped pick
 * options come out. Registry exceptions propagate to the caller — the
 * command face catches them and degrades to the pre-existing text path
 * (fail-soft, matching the snapshot discipline in snapshot.ts).
 *
 * Providers whose credentials are not configured never appear: routing
 * filters them at request time, so offering them for configuration is
 * noise. Manual entry remains available for pre-configuration.
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

/**
 * One provider's pickable models. Grouping by provider keeps every dialog
 * short: the first dialog lists providers, the second lists one provider's
 * models — a flat list overflows the select dialog, which does not scroll.
 */
export interface CatalogPickGroup {
  provider: string;
  models: readonly CatalogPickOption[];
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
 * Build the provider-grouped pick list for one dialog session: chat models
 * only, own virtual namespace excluded, uncredentialed providers filtered
 * out entirely, groups sorted by provider and models by id. Model labels
 * carry the context window and the reasoning flag; the provider is the
 * group's context, so it is not repeated in every label.
 */
export function buildCatalogPickGroups(registry: CatalogPickerRegistry): CatalogPickGroup[] {
  const byProvider = new Map<string, CatalogPickOption[]>();
  const credentialed = new Map<string, boolean>();
  for (const model of registry.getModelsOfType("chat")) {
    if (isOwnVirtualModel(model.provider)) continue;
    let configured = credentialed.get(model.provider);
    if (configured === undefined) {
      configured = registry.getProviderAuthStatus(model.provider).configured;
      credentialed.set(model.provider, configured);
    }
    if (!configured) continue;
    const parts: string[] = [];
    const context = contextLabel(model.contextWindow);
    if (context !== null) parts.push(context);
    if (model.reasoning === true) parts.push("reasoning");
    const label = parts.length > 0 ? `${model.id} · ${parts.join(" · ")}` : model.id;
    const group = byProvider.get(model.provider) ?? [];
    group.push({ ref: { provider: model.provider, id: model.id }, label });
    byProvider.set(model.provider, group);
  }
  return [...byProvider.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, models]) => ({
      provider,
      models: models.sort((a, b) => a.ref.id.localeCompare(b.ref.id)),
    }));
}
