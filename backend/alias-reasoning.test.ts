import { describe, expect, test } from "bun:test";
import { applyAliasConverse, applyAliasInvoke } from "./alias-reasoning";
import { getAliasCapabilities, validateAliasSettings } from "../shared/alias-options";
const upstream = (modelId = "anthropic.claude-opus-5") => ({ modelId, thinking: true, reasoningMode: "auto", maxOutputTokens: 32000 });

describe("pinned alias reasoning", () => {
  test("adaptive thinking and effort override client native fields without mutating input", () => {
    const input = { modelId: "app-max", inferenceConfig: { temperature: 0.5, topP: 0.9 }, additionalModelRequestFields: { thinking: { type: "disabled" }, reasoning_effort: "low", output_config: { effort: "low", format: { type: "json_schema" } } } };
    const result = applyAliasConverse(input, upstream(), { thinking: true, effort: "max" });
    expect(result.modelId).toBe(upstream().modelId);
    expect(result.inferenceConfig).toEqual({ maxTokens: 32000 });
    expect(result.additionalModelRequestFields).toEqual({ thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "max", format: { type: "json_schema" } } });
    expect(input.additionalModelRequestFields.thinking.type).toBe("disabled");
  });
  test("thinking off and independent effort produce an explicit disabled policy", () => {
    const result = applyAliasConverse({ modelId: "alias", additionalModelRequestFields: { thinking: { type: "adaptive" }, output_config: { effort: "low" } } }, upstream(), { thinking: false, effort: "max" });
    expect(result.additionalModelRequestFields).toEqual({ thinking: { type: "disabled" }, output_config: { effort: "max" } });
  });
  test("budget thinking and native Invoke get pinned budget/output/sampling", () => {
    const result = applyAliasInvoke(JSON.stringify({ messages: [], max_tokens: 4096, temperature: 0.7, top_p: 0.9, thinking: { type: "disabled" }, output_config: { effort: "low" } }), upstream("anthropic.claude-opus-4-5"), { thinking: true, effort: "high" });
    expect(result).toMatchObject({ messages: [], max_tokens: 10001, thinking: { type: "enabled", budget_tokens: 10000 }, output_config: { effort: "high" }, anthropic_beta: ["effort-2025-11-24"] });
    expect(result.temperature).toBeUndefined(); expect(result.top_p).toBeUndefined();
  });
  test("thinking off removes budget and client effort but keeps unrelated Invoke fields", () => {
    const result = applyAliasInvoke({ messages: [], anthropic_version: "bedrock-2023-05-31", max_tokens: 300, temperature: 0.5, thinking: { type: "enabled", budget_tokens: 200 }, reasoning_effort: "max" }, upstream("anthropic.claude-sonnet-4-5"), { thinking: false, effort: null });
    expect(result).toEqual({ messages: [], anthropic_version: "bedrock-2023-05-31", max_tokens: 300, temperature: 0.5, thinking: { type: "disabled" } });
  });
  test("Nova and OpenAI provider-specific reasoning", () => {
    expect(applyAliasConverse({ modelId: "alias" }, upstream("amazon.nova-2-lite-v1:0"), { thinking: true, effort: "high" }).additionalModelRequestFields).toEqual({ reasoningConfig: { type: "enabled", maxReasoningEffort: "high" } });
    expect(applyAliasConverse({ modelId: "alias" }, upstream("amazon.nova-2-lite-v1:0"), { thinking: false, effort: null }).additionalModelRequestFields).toEqual({ reasoningConfig: { type: "disabled" } });
    expect(applyAliasConverse({ modelId: "alias" }, upstream("openai.gpt-oss-120b-1:0"), { thinking: true, effort: "high" }).additionalModelRequestFields).toEqual({ reasoning_effort: "high" });
    expect(() => applyAliasInvoke({}, upstream("amazon.nova-2-lite-v1:0"), { thinking: true, effort: "high" })).toThrow("Converse");
  });
  test("rejects invalid off/effort combinations and limits rather than silently clamping", () => {
    for (const modelId of ["anthropic.claude-opus-5-5", "anthropic.claude-sonnet-5-5", "anthropic.claude-opus-4-7", "openai.gpt-oss-120b-1:0"]) {
      expect(getAliasCapabilities(upstream(modelId)).canDisableThinking).toBe(false);
      expect(validateAliasSettings(upstream(modelId), { thinking: false, effort: null })).not.toBeNull();
    }
    expect(validateAliasSettings(upstream("anthropic.claude-opus-4-6"), { thinking: false, effort: "max" })).toBeNull();
    expect(validateAliasSettings(upstream("amazon.nova-2-lite-v1:0"), { thinking: true, effort: "max" })).not.toBeNull();
    expect(validateAliasSettings({ ...upstream("anthropic.claude-sonnet-4-5"), maxOutputTokens: 1024 }, { thinking: true, effort: "low" })).not.toBeNull();
    expect(() => applyAliasConverse({ modelId: "alias", inferenceConfig: { maxTokens: 32001 } }, upstream(), { thinking: true, effort: "low" })).toThrow("maxTokens");
  });
});
