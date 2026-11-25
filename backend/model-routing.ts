import { validateAliasSettings, type AliasSettings } from "../shared/alias-options";
import type { modelsTable } from "./schema";
import {
  isReasoningEffort, resolveEffortLevel, resolveReasoningProfile, supportedReasoningEfforts, type ReasoningEffort,
} from "../shared/reasoning";

type Model = typeof modelsTable.$inferSelect;
export interface RoutingAlias extends AliasSettings {
  id: string; modelId: string; name: string; description: string | null;
  upstreamModelId: string; enabled: boolean; createdAt: Date;
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

/** Discovery and playground controls must match invocation policy, including app tiers. */
export function modelReasoningMetadata({ upstream: model, alias }: ResolvedModel) {
  const pinned = alias && alias.reasoningSource !== "client";
  return {
    thinking: pinned ? alias.thinking : model.thinking,
    ...(alias && { alias: { modelId: alias.modelId, reasoningSource: alias.reasoningSource ?? "alias", thinking: alias.thinking, effort: alias.effort } }),
    reasoningEfforts: pinned ? [] : supportedReasoningEfforts(model),
    defaultReasoningEffort: pinned ? alias.effort : model.thinking && isReasoningEffort(model.defaultReasoningEffort) ? model.defaultReasoningEffort : null,
  };
}

/** The effort a request to `model` without `reasoning_effort` runs at, as one of `supportedReasoningEfforts(model)`:
 * its configured default mapped onto the levels it takes (as requests are), or null when it has none. */
function effectiveDefaultEffort(model: Model): ReasoningEffort | null {
  if (!model.thinking || !isReasoningEffort(model.defaultReasoningEffort)) return null;
  if (model.defaultReasoningEffort === "none") return "none";
  return resolveEffortLevel(model.defaultReasoningEffort, resolveReasoningProfile(model.modelId, model.reasoningMode).efforts);
}

/**
 * An entry of `GET /v1/models`: OpenAI's model object with the gateway's own fields. `name` is the display name;
 * `context_window` and `max_output_tokens` are the model's configured context window (null when none is configured)
 * and output limit (the most a request may ask for, and what it gets without a limit); an alias and its app tiers
 * list their upstream model's. `efforts` are the `reasoning_effort` values a request may send (none for a pinned
 * alias, or a model without reasoning enabled); `default_effort` is the one a request without `reasoning_effort`
 * runs at, or null when no default effort is configured. Pinned aliases and their app tiers also list `effort`, the
 * effort every request runs at: `none` when the alias turns thinking off without one.
 */
export function listedModel(entry: ResolvedModel) {
  const { upstream: model, alias } = entry;
  const pinned = alias && alias.reasoningSource !== "client" ? alias : undefined;
  const efforts = pinned ? [] : supportedReasoningEfforts(model);
  return {
    id: entry.modelId,
    object: "model" as const,
    created: Math.floor(entry.createdAt.getTime() / 1000),
    owned_by: "ai-gateway" as const,
    name: entry.name,
    context_window: model.contextWindow ?? null,
    max_output_tokens: model.maxOutputTokens,
    efforts,
    default_effort: efforts.length ? effectiveDefaultEffort(model) : null,
    ...(pinned && { effort: pinned.effort ?? ("none" as const) }),
  };
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
