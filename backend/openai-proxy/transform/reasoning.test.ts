import { describe, expect, test } from "bun:test";
import type { ConverseCommandInput } from "@aws-sdk/client-bedrock-runtime";
import {
  detectReasoningProfile,
  resolveEffortLevel,
  resolveReasoningProfile,
  supportedReasoningEfforts,
  type EffortLevel,
} from "@/shared/reasoning";
import { applyReasoning, ReasoningConfigError } from "./reasoning";

const base: ConverseCommandInput = {
  modelId: "model",
  messages: [{ role: "user", content: [{ text: "Hi" }] }],
  inferenceConfig: { maxTokens: 32000, temperature: 0.2, topP: 0.8, stopSequences: ["STOP"] },
};

describe("reasoning profile detection", () => {
  const cases: Array<[string, string | null, EffortLevel[] | null]> = [
    ["anthropic.claude-3-7-sonnet-20250219-v1:0", "anthropic_budget", ["low", "medium", "high"]],
    ["us.anthropic.claude-sonnet-4-20250514-v1:0", "anthropic_budget", ["low", "medium", "high"]],
    ["anthropic.claude-opus-4-1-20250805-v1:0", "anthropic_budget", ["low", "medium", "high"]],
    ["global.anthropic.claude-sonnet-4-5-20250929-v1:0", "anthropic_budget", ["low", "medium", "high"]],
    ["us.anthropic.claude-haiku-4-5-20251001-v1:0", "anthropic_budget", ["low", "medium", "high"]],
    ["global.anthropic.claude-opus-4-5-20251101-v1:0", "anthropic_budget", ["low", "medium", "high"]],
    ["us.anthropic.claude-opus-4-6-v1", "anthropic_adaptive", ["low", "medium", "high", "max"]],
    ["anthropic.claude-sonnet-4-6", "anthropic_adaptive", ["low", "medium", "high", "max"]],
    ["global.anthropic.claude-opus-4-7", "anthropic_adaptive", ["low", "medium", "high", "xhigh", "max"]],
    ["anthropic.claude-opus-4-8", "anthropic_adaptive", ["low", "medium", "high", "xhigh", "max"]],
    ["anthropic.claude-sonnet-5", "anthropic_adaptive", ["low", "medium", "high", "xhigh", "max"]],
    ["anthropic.claude-opus-5-5", "anthropic_adaptive", ["low", "medium", "high", "xhigh", "max"]],
    ["anthropic.claude-fable-5-1", "anthropic_adaptive", ["low", "medium", "high", "xhigh", "max"]],
    ["anthropic.claude-mythos-preview", "anthropic_adaptive", ["low", "medium", "high", "max"]],
    ["arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-4-7", "anthropic_adaptive", ["low", "medium", "high", "xhigh", "max"]],
    ["arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6", "anthropic_adaptive", ["low", "medium", "high", "max"]],
    ["us.amazon.nova-2-lite-v1:0", "nova", ["low", "medium", "high"]],
    ["openai.gpt-oss-120b-1:0", "openai", ["low", "medium", "high"]],
    ["arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123", null, null],
    ["amazon.nova-pro-v1:0", null, null],
    ["meta.llama3-70b-instruct-v1:0", null, null],
  ];

  for (const [modelId, style, efforts] of cases) {
    test(`${modelId} -> ${style ?? "undetected"}`, () => {
      const profile = detectReasoningProfile(modelId);
      expect(profile?.style ?? null).toBe(style as never);
      expect(profile ? [...profile.efforts] : null).toEqual(efforts);
    });
  }

  test("captures per-model thinking controls", () => {
    expect(detectReasoningProfile("anthropic.claude-opus-4-5-20251101-v1:0")?.effortBeta).toBe(true);
    expect(detectReasoningProfile("anthropic.claude-sonnet-4-5-20250929-v1:0")?.effortBeta).toBeUndefined();
    expect(detectReasoningProfile("anthropic.claude-opus-4-6-v1")?.summarizedDisplay).toBeUndefined();
    expect(detectReasoningProfile("anthropic.claude-opus-4-7")?.summarizedDisplay).toBe(true);
    expect(detectReasoningProfile("anthropic.claude-opus-4-7")?.thinkingOff).toBeUndefined();
    expect(detectReasoningProfile("anthropic.claude-opus-5")?.thinkingOff).toEqual({ type: "disabled" });
    expect(detectReasoningProfile("anthropic.claude-sonnet-5-5")?.thinkingOff).toEqual({ type: "between_tools" });
    expect(detectReasoningProfile("anthropic.claude-opus-5-5")?.thinkingOff).toBeUndefined();
    expect(detectReasoningProfile("anthropic.claude-opus-4-20250514-v1:0")?.label).toBe("Claude Opus 4");
    expect(detectReasoningProfile("anthropic.claude-3-7-sonnet-20250219-v1:0")?.label).toBe("Claude Sonnet 3.7");
  });

  test("automatic mode keeps the historical budget mapping for unrecognized identifiers", () => {
    const profile = resolveReasoningProfile("arn:aws:bedrock:us-east-1:1:application-inference-profile/x", "auto");
    expect(profile).toMatchObject({ style: "anthropic_budget", detected: false });
  });

  test("an explicit mode overrides detection and reuses matching details", () => {
    expect(resolveReasoningProfile("arn:aws:bedrock:us-east-1:1:application-inference-profile/x", "anthropic_adaptive"))
      .toMatchObject({ style: "anthropic_adaptive", detected: false, summarizedDisplay: true, efforts: ["low", "medium", "high", "xhigh", "max"] });
    expect(resolveReasoningProfile("anthropic.claude-opus-4-6-v1", "anthropic_adaptive")).toMatchObject({ detected: true, efforts: ["low", "medium", "high", "max"] });
    expect(resolveReasoningProfile("anthropic.claude-opus-4-6-v1", "anthropic_budget")).toMatchObject({ style: "anthropic_budget", detected: false });
    expect(resolveReasoningProfile("anthropic.claude-opus-4-7", "bogus")).toMatchObject({ style: "anthropic_adaptive", detected: true });
  });

  test("lists supported request values only for reasoning-enabled models", () => {
    expect(supportedReasoningEfforts({ modelId: "anthropic.claude-opus-4-7", thinking: false })).toEqual([]);
    expect(supportedReasoningEfforts({ modelId: "anthropic.claude-sonnet-4-6", thinking: true, reasoningMode: "auto" }))
      .toEqual(["none", "low", "medium", "high", "max"]);
  });
});

describe("effort level resolution", () => {
  test("keeps supported levels and maps minimal to low", () => {
    expect(resolveEffortLevel("medium", ["low", "medium", "high"])).toBe("medium");
    expect(resolveEffortLevel("minimal", ["low", "medium", "high"])).toBe("low");
  });

  test("clamps unsupported levels to the nearest lower level, then upward", () => {
    expect(resolveEffortLevel("xhigh", ["low", "medium", "high", "max"])).toBe("high");
    expect(resolveEffortLevel("max", ["low", "medium", "high"])).toBe("high");
    expect(resolveEffortLevel("low", ["medium", "high"])).toBe("medium");
  });
});

describe("applying reasoning effort to Converse requests", () => {
  test("adaptive Claude models get adaptive thinking, effort, summarized display, and default sampling", () => {
    const profile = resolveReasoningProfile("global.anthropic.claude-opus-4-7", "auto");
    const { request, effort } = applyReasoning(base, { profile, effort: "xhigh", maxOutputTokens: 64000 });
    expect(effort).toBe("xhigh");
    expect(request.additionalModelRequestFields).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "xhigh" },
    });
    expect(request.inferenceConfig).toEqual({ maxTokens: 32000, stopSequences: ["STOP"] });
  });

  test("Claude 4.6 keeps its default thinking display and clamps unsupported xhigh", () => {
    const profile = resolveReasoningProfile("anthropic.claude-sonnet-4-6", "auto");
    const { request, effort } = applyReasoning(base, { profile, effort: "xhigh", maxOutputTokens: 64000 });
    expect(effort).toBe("high");
    expect(request.additionalModelRequestFields).toEqual({ thinking: { type: "adaptive" }, output_config: { effort: "high" } });
  });

  test("none turns thinking off only where the model supports an explicit off switch", () => {
    const sonnet55 = applyReasoning(base, { profile: resolveReasoningProfile("anthropic.claude-sonnet-5-5", "auto"), effort: "none", maxOutputTokens: 64000 });
    expect(sonnet55.request.additionalModelRequestFields).toEqual({ thinking: { type: "between_tools" } });
    expect(sonnet55.request.inferenceConfig).toEqual(base.inferenceConfig);
    const opus47 = applyReasoning(base, { profile: resolveReasoningProfile("anthropic.claude-opus-4-7", "auto"), effort: "none", maxOutputTokens: 64000 });
    expect(opus47.request).toBe(base);
    const budget = applyReasoning(base, { profile: resolveReasoningProfile("anthropic.claude-sonnet-4-5-20250929-v1:0", "auto"), effort: "none", maxOutputTokens: 64000 });
    expect(budget.request).toBe(base);
  });

  test("budget Claude models keep the historical token budgets", () => {
    const profile = resolveReasoningProfile("anthropic.claude-sonnet-4-5-20250929-v1:0", "auto");
    const { request, effort } = applyReasoning({ ...base, inferenceConfig: { maxTokens: 2000, temperature: 0.5 } }, { profile, effort: "medium", maxOutputTokens: 32000 });
    expect(effort).toBe("medium");
    expect(request.additionalModelRequestFields).toEqual({ thinking: { type: "enabled", budget_tokens: 4096 } });
    expect(request.inferenceConfig).toEqual({ maxTokens: 4097 });
  });

  test("budget models clamp xhigh and max to the high budget", () => {
    const profile = resolveReasoningProfile("anthropic.claude-opus-4-1-20250805-v1:0", "auto");
    const { request, effort } = applyReasoning(base, { profile, effort: "max", maxOutputTokens: 32000 });
    expect(effort).toBe("high");
    expect(request.additionalModelRequestFields).toEqual({ thinking: { type: "enabled", budget_tokens: 10000 } });
  });

  test("Opus 4.5 adds the effort beta and output_config alongside its budget", () => {
    const profile = resolveReasoningProfile("global.anthropic.claude-opus-4-5-20251101-v1:0", "auto");
    const { request } = applyReasoning({ ...base, additionalModelRequestFields: { anthropic_beta: ["other-beta"] } }, { profile, effort: "low", maxOutputTokens: 32000 });
    expect(request.additionalModelRequestFields).toEqual({
      anthropic_beta: ["other-beta", "effort-2025-11-24"],
      thinking: { type: "enabled", budget_tokens: 1024 },
      output_config: { effort: "low" },
    });
  });

  test("rejects a budget that does not fit the model output limit", () => {
    const profile = resolveReasoningProfile("anthropic.claude-sonnet-4-5-20250929-v1:0", "auto");
    expect(() => applyReasoning(base, { profile, effort: "high", maxOutputTokens: 8192 })).toThrow(ReasoningConfigError);
  });

  test("Nova 2 uses reasoningConfig and drops parameters rejected at high effort", () => {
    const profile = resolveReasoningProfile("us.amazon.nova-2-lite-v1:0", "auto");
    const medium = applyReasoning(base, { profile, effort: "medium", maxOutputTokens: 32000 });
    expect(medium.request.additionalModelRequestFields).toEqual({ reasoningConfig: { type: "enabled", maxReasoningEffort: "medium" } });
    expect(medium.request.inferenceConfig).toEqual(base.inferenceConfig);
    const high = applyReasoning(base, { profile, effort: "max", maxOutputTokens: 32000 });
    expect(high.effort).toBe("high");
    expect(high.request.inferenceConfig).toEqual({ stopSequences: ["STOP"] });
  });

  test("gpt-oss receives reasoning_effort", () => {
    const profile = resolveReasoningProfile("openai.gpt-oss-120b-1:0", "auto");
    const { request } = applyReasoning(base, { profile, effort: "low", maxOutputTokens: 16000 });
    expect(request.additionalModelRequestFields).toEqual({ reasoning_effort: "low" });
    expect(request.inferenceConfig).toEqual(base.inferenceConfig);
  });
});
