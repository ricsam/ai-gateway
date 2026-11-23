import { expect, test } from "bun:test";
import { listedModel, modelReasoningMetadata, resolveModelCatalog, type ModelCatalog } from "./model-routing";
import type { ReasoningEffort } from "../shared/reasoning";
function catalog(): ModelCatalog {
  return {
    models: [{ id: "up", modelId: "anthropic.claude-opus-5-5", name: "Opus", enabled: true, provider: "bedrock", thinking: true, reasoningMode: "auto", maxOutputTokens: 32000, inputPricePerMTok: 5, region: "us-east-1", createdAt: new Date(0) }] as ModelCatalog["models"],
    aliases: [{ id: "a", modelId: "opus-max-thinking", name: "Opus max", description: null, upstreamModelId: "up", thinking: true, effort: "max", enabled: true, createdAt: new Date(0) }],
    apps: [{ id: "app", name: "chat-app", description: null, enabled: true, tiers: [{ name: "max", aliasId: "a" }, { name: "low", aliasId: null }], createdAt: new Date(0) }],
  };
}
test("discovery resolves precisely the callable model IDs and inherits upstream pricing and region", () => {
  const data = catalog();
  const result = resolveModelCatalog(data);
  expect(result.map((row) => row.modelId)).toEqual(["anthropic.claude-opus-5-5", "chat-app-max", "opus-max-thinking"]);
  expect(result.find((row) => row.modelId === "chat-app-max")?.upstream).toBe(data.models[0]!);
});
test("disabling any dependency hides its downstream IDs; dangling/invalid mappings never fall back", () => {
  const data = catalog();
  data.apps[0]!.enabled = false;
  expect(resolveModelCatalog(data)).toHaveLength(2);
  data.apps[0]!.enabled = true;
  data.aliases[0]!.enabled = false;
  expect(resolveModelCatalog(data)).toHaveLength(1);
  data.aliases[0]!.enabled = true;
  data.models[0]!.enabled = false;
  expect(resolveModelCatalog(data)).toHaveLength(0);
  data.models[0]!.enabled = true;
  data.aliases[0]!.thinking = false;
  expect(resolveModelCatalog(data)).toHaveLength(1);
  data.aliases[0]!.thinking = true;
  data.aliases[0]!.upstreamModelId = "missing";
  expect(resolveModelCatalog(data)).toHaveLength(1);
});
test("client aliases and app tiers expose upstream reasoning controls instead of pinned values", () => {
  const data = catalog();
  data.aliases[0]!.reasoningSource = "client";
  data.aliases[0]!.thinking = false;
  data.aliases[0]!.effort = null;
  data.models[0]!.defaultReasoningEffort = "medium";
  const entries = resolveModelCatalog(data);
  expect(entries).toHaveLength(3); // False thinking is not a promise to disable an always-thinking model.
  for (const entry of entries.filter((entry) => entry.alias)) {
    expect(modelReasoningMetadata(entry)).toMatchObject({
      thinking: true, reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium",
      alias: { reasoningSource: "client", thinking: false, effort: null },
    });
  }
  data.models[0]!.thinking = false;
  expect(modelReasoningMetadata(resolveModelCatalog(data)[1]!)).toMatchObject({ thinking: false, reasoningEfforts: [], defaultReasoningEffort: null });
});
test("pinned and legacy aliases have no editable reasoning controls", () => {
  const entry = resolveModelCatalog(catalog()).find((entry) => entry.alias)!;
  expect(modelReasoningMetadata(entry)).toMatchObject({ thinking: true, reasoningEfforts: [], defaultReasoningEffort: "max", alias: { reasoningSource: "alias" } });
});
test("remapping a tier preserves its public ID while changing the upstream policy", () => {
  const data = catalog();
  data.aliases.push({ ...data.aliases[0]!, id: "b", modelId: "opus-low-thinking", effort: "low" });
  data.apps[0]!.tiers[0]!.aliasId = "b";
  expect(resolveModelCatalog(data).find((row) => row.modelId === "chat-app-max")?.alias?.effort).toBe("low");
});

const OPUS_5_5_EFFORTS: ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];
/** /v1/models as a map of ID to its entry's other fields. */
const listing = (data: ModelCatalog) => Object.fromEntries(resolveModelCatalog(data).map((entry) => {
  const { id, ...fields } = listedModel(entry);
  return [id, fields];
}));
test("/v1/models lists each ID's name and efforts, and the effort a pinned alias and its app tiers run at", () => {
  const common = { object: "model", created: 0, owned_by: "ai-gateway" } as const;
  expect(listing(catalog())).toEqual({
    "anthropic.claude-opus-5-5": { ...common, name: "Opus", efforts: OPUS_5_5_EFFORTS, default_effort: null },
    "chat-app-max": { ...common, name: "chat-app / max", efforts: [], default_effort: null, effort: "max" },
    "opus-max-thinking": { ...common, name: "Opus max", efforts: [], default_effort: null, effort: "max" },
  });
});
test("/v1/models lists a client alias with its upstream's efforts and the level a request without one runs at", () => {
  const data = catalog();
  data.aliases[0]!.reasoningSource = "client";
  data.models[0]!.defaultReasoningEffort = "minimal";
  for (const fields of Object.values(listing(data))) {
    expect(fields).toMatchObject({ efforts: OPUS_5_5_EFFORTS, default_effort: "low" });
    expect(fields).not.toHaveProperty("effort");
  }
  data.models[0]!.defaultReasoningEffort = "none";
  expect(listing(data)["opus-max-thinking"]).toMatchObject({ default_effort: "none" });
  // Without reasoning enabled, requests can't choose an effort, and a configured default doesn't apply.
  data.models[0]!.thinking = false;
  data.models[0]!.defaultReasoningEffort = "high";
  for (const fields of Object.values(listing(data))) expect(fields).toMatchObject({ efforts: [], default_effort: null });
});
test("/v1/models maps a default effort onto the model's levels, and lists none for a pinned alias without thinking", () => {
  const data = catalog();
  data.models = [{ ...data.models[0]!, modelId: "anthropic.claude-sonnet-4-5-20250929-v1:0", name: "Claude Sonnet 4.5", defaultReasoningEffort: "max" }];
  data.aliases[0] = { ...data.aliases[0]!, modelId: "sonnet-no-thinking", name: "Sonnet without thinking", thinking: false, effort: null };
  expect(listing(data)).toMatchObject({
    "anthropic.claude-sonnet-4-5-20250929-v1:0": { name: "Claude Sonnet 4.5", efforts: ["none", "low", "medium", "high"], default_effort: "high" },
    "sonnet-no-thinking": { name: "Sonnet without thinking", efforts: [], default_effort: null, effort: "none" },
    "chat-app-max": { name: "chat-app / max", effort: "none" },
  });
});
