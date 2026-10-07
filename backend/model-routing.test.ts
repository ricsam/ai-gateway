import { expect, test } from "bun:test";
import { modelReasoningMetadata, resolveModelCatalog, type ModelCatalog } from "./model-routing";
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
