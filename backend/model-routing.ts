import { validateAliasSettings } from "../shared/alias-options";
import type { modelsTable } from "./schema";
import type { EffortLevel } from "../shared/reasoning";

type Model = typeof modelsTable.$inferSelect;
export interface RoutingAlias {
  id: string; modelId: string; name: string; description: string | null;
  upstreamModelId: string; thinking: boolean; effort: EffortLevel | null; enabled: boolean; createdAt: Date;
}
export interface RoutingApp {
  id: string; name: string; description: string | null; enabled: boolean;
  tiers: Array<{ name: string; aliasId: string | null }>; createdAt: Date;
}
export interface ModelCatalog { models: Model[]; aliases: RoutingAlias[]; apps: RoutingApp[] }
export interface ResolvedModel {
  modelId: string;
  name: string;
  createdAt: Date;
  upstream: Model;
  alias?: RoutingAlias;
}

/** One authoritative enabled catalog for invocation and discovery. No fallback from broken aliases. */
export function resolveModelCatalog(catalog: ModelCatalog): ResolvedModel[] {
  const models = new Map(catalog.models.filter((model) => model.enabled && model.provider === "bedrock").map((model) => [model.id, model]));
  const resolved: ResolvedModel[] = [...models.values()].map((model) => ({ modelId: model.modelId, name: model.name, createdAt: model.createdAt, upstream: model }));
  const aliases = new Map<string, ResolvedModel>();
  for (const alias of catalog.aliases) {
    const upstream = models.get(alias.upstreamModelId);
    if (!alias.enabled || !upstream || validateAliasSettings(upstream, alias)) continue;
    const entry = { modelId: alias.modelId, name: alias.name, createdAt: alias.createdAt, upstream, alias };
    aliases.set(alias.id, entry);
    resolved.push(entry);
  }
  for (const app of catalog.apps) {
    if (!app.enabled) continue;
    for (const tier of app.tiers) {
      const target = tier.aliasId ? aliases.get(tier.aliasId) : undefined;
      if (target) resolved.push({ ...target, modelId: `${app.name}-${tier.name}`, name: `${app.name} / ${tier.name}`, createdAt: app.createdAt });
    }
  }
  // Fail closed if data was written outside the admin namespace lock.
  const counts = new Map<string, number>();
  for (const entry of resolved) counts.set(entry.modelId, (counts.get(entry.modelId) ?? 0) + 1);
  return resolved.filter((entry) => counts.get(entry.modelId) === 1).sort((a, b) => a.modelId.localeCompare(b.modelId));
}
