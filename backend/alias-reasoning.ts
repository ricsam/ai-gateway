import type { ConverseCommandInput } from "@aws-sdk/client-bedrock-runtime";
import { getAliasCapabilities, validateAliasSettings, type AliasSettings, type AliasUpstream } from "../shared/alias-options";
import { detectReasoningProfile, resolveReasoningProfile } from "../shared/reasoning";
import { applyReasoning, EFFORT_BETA, ReasoningConfigError } from "./openai-proxy/transform/reasoning";

type Fields = Record<string, unknown>;
function object(value: unknown): Fields {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
}

/** Remove client provider-specific reasoning controls before applying the pinned policy. */
function cleanFields(value: unknown): Fields {
  const fields = { ...object(value) };
  delete fields.thinking;
  delete fields.reasoning_effort;
  delete fields.reasoningConfig;
  const output = { ...object(fields.output_config) };
  delete output.effort;
  if (Object.keys(output).length) fields.output_config = output; else delete fields.output_config;
  return fields;
}

export function applyAliasConverse(request: ConverseCommandInput, model: AliasUpstream, settings: AliasSettings): ConverseCommandInput {
  if (settings.reasoningSource === "client") return { ...request, modelId: model.modelId };
  const invalid = validateAliasSettings(model, settings);
  if (invalid) throw new ReasoningConfigError(invalid, "invalid_alias_configuration");
  if (request.inferenceConfig?.maxTokens !== undefined && (!Number.isInteger(request.inferenceConfig.maxTokens) || request.inferenceConfig.maxTokens <= 0 || request.inferenceConfig.maxTokens > model.maxOutputTokens)) {
    throw new ReasoningConfigError(`maxTokens must be a positive integer no greater than ${model.maxOutputTokens}`, "invalid_max_tokens");
  }
  const profile = resolveReasoningProfile(model.modelId, model.reasoningMode);
  const fields = cleanFields(request.additionalModelRequestFields);
  let result: ConverseCommandInput = {
    ...request, modelId: model.modelId,
    inferenceConfig: { ...request.inferenceConfig, maxTokens: request.inferenceConfig?.maxTokens ?? model.maxOutputTokens },
    additionalModelRequestFields: fields as ConverseCommandInput["additionalModelRequestFields"],
  };
  if (settings.thinking) {
    result = applyReasoning(result, { profile, effort: settings.effort!, maxOutputTokens: model.maxOutputTokens }).request;
    // Preserve independent output configuration options while replacing effort.
    const applied = object(result.additionalModelRequestFields);
    if (applied.output_config) applied.output_config = { ...object(fields.output_config), ...object(applied.output_config) };
    return result;
  }
  const hasControls = model.thinking || detectReasoningProfile(model.modelId) || (model.reasoningMode && model.reasoningMode !== "auto");
  if (hasControls) {
    if (profile.style === "anthropic_adaptive" || profile.style === "anthropic_budget") fields.thinking = { type: "disabled" };
    if (profile.style === "nova") fields.reasoningConfig = { type: "disabled" };
  }
  if (settings.effort && getAliasCapabilities(model).canSetEffortWithoutThinking) {
    fields.output_config = { ...object(fields.output_config), effort: settings.effort };
    if (profile.effortBeta) {
      const betas = Array.isArray(fields.anthropic_beta) ? fields.anthropic_beta.filter((v): v is string => typeof v === "string") : [];
      fields.anthropic_beta = [...new Set([...betas, EFFORT_BETA])];
    }
  }
  return result;
}

/** Native Invoke bodies are provider-specific. Only the supported Anthropic shape is rewritten. */
export function applyAliasInvoke(value: unknown, model: AliasUpstream, settings: AliasSettings): Fields {
  const profile = resolveReasoningProfile(model.modelId, model.reasoningMode);
  if (settings.reasoningSource !== "client" && (!profile.style.startsWith("anthropic_") || (!detectReasoningProfile(model.modelId) && (!model.reasoningMode || model.reasoningMode === "auto")))) {
    throw new ReasoningConfigError("Use chat/completions or Converse for this alias; native Invoke aliasing supports configured Anthropic models only", "alias_endpoint_unsupported");
  }
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { throw new ReasoningConfigError("Alias Invoke body must be a JSON object", "invalid_json"); }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ReasoningConfigError("Alias Invoke body must be a JSON object", "invalid_json");
  const body = { ...parsed } as Fields;
  if (settings.reasoningSource === "client") return body;
  const input = applyAliasConverse({
    modelId: model.modelId,
    inferenceConfig: {
      ...(body.max_tokens !== undefined && { maxTokens: body.max_tokens as number }),
      ...(body.temperature !== undefined && { temperature: body.temperature as number }),
      ...(body.top_p !== undefined && { topP: body.top_p as number }),
    },
    additionalModelRequestFields: cleanFields(body) as ConverseCommandInput["additionalModelRequestFields"],
  }, model, settings);
  const result = { ...object(input.additionalModelRequestFields) };
  delete result.temperature;
  delete result.top_p;
  delete result.max_tokens;
  if (input.inferenceConfig?.temperature !== undefined) result.temperature = input.inferenceConfig.temperature;
  if (input.inferenceConfig?.topP !== undefined) result.top_p = input.inferenceConfig.topP;
  if (input.inferenceConfig?.maxTokens !== undefined) result.max_tokens = input.inferenceConfig.maxTokens;
  return result;
}
