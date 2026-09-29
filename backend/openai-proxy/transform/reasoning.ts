/**
 * Apply an OpenAI-style `reasoning_effort` to a Bedrock Converse request.
 *
 * Claude 4.6+ uses adaptive thinking with `output_config.effort`; Claude 4.5 and
 * earlier use extended thinking token budgets (Opus 4.5 also accepts effort
 * behind a beta flag); Amazon Nova 2 and OpenAI gpt-oss have their own fields.
 */
import type { ConverseCommandInput } from "@aws-sdk/client-bedrock-runtime";
import { resolveEffortLevel, type EffortLevel, type ReasoningEffort, type ReasoningProfile } from "@/shared/reasoning";

/** Historical thinking budgets for Claude models that only support extended thinking. */
export const THINKING_BUDGETS: Record<"low" | "medium" | "high", number> = { low: 1024, medium: 4096, high: 10000 };
export const EFFORT_BETA = "effort-2025-11-24";

export class ReasoningConfigError extends Error {
  override name = "ReasoningConfigError";
  constructor(message: string, readonly code: string) { super(message); }
}

export interface AppliedReasoning {
  request: ConverseCommandInput;
  /** Upstream level that was requested, or "none" when reasoning was left off. */
  effort: EffortLevel | "none";
}

type Fields = Record<string, unknown>;

function withFields(request: ConverseCommandInput, fields: Fields): ConverseCommandInput {
  const existing = (request.additionalModelRequestFields ?? {}) as Fields;
  return { ...request, additionalModelRequestFields: { ...existing, ...fields } as ConverseCommandInput["additionalModelRequestFields"] };
}

function withoutSampling(request: ConverseCommandInput, keys: ("temperature" | "topP" | "maxTokens")[]): ConverseCommandInput {
  if (!request.inferenceConfig) return request;
  const inferenceConfig = { ...request.inferenceConfig };
  for (const key of keys) delete inferenceConfig[key];
  if (Object.keys(inferenceConfig).length === 0) {
    const { inferenceConfig: _removed, ...rest } = request;
    return rest;
  }
  return { ...request, inferenceConfig };
}

export function applyReasoning(
  request: ConverseCommandInput,
  options: { profile: ReasoningProfile; effort: ReasoningEffort; maxOutputTokens: number },
): AppliedReasoning {
  const { profile, effort, maxOutputTokens } = options;
  if (effort === "none") {
    if (profile.style === "anthropic_adaptive" && profile.thinkingOff) {
      return { request: withFields(request, { thinking: profile.thinkingOff }), effort: "none" };
    }
    return { request, effort: "none" };
  }

  const level = resolveEffortLevel(effort, profile.efforts);
  switch (profile.style) {
    case "anthropic_adaptive": {
      // Claude thinking modes require default sampling parameters.
      const next = withFields(withoutSampling(request, ["temperature", "topP"]), {
        thinking: { type: "adaptive", ...(profile.summarizedDisplay && { display: "summarized" }) },
        output_config: { effort: level },
      });
      return { request: next, effort: level };
    }
    case "anthropic_budget": {
      const budgetLevel = level as keyof typeof THINKING_BUDGETS;
      const budgetTokens = THINKING_BUDGETS[budgetLevel] ?? THINKING_BUDGETS.high;
      if (budgetTokens >= maxOutputTokens) {
        throw new ReasoningConfigError(
          `The configured output limit is too small for ${budgetLevel} reasoning effort`,
          "reasoning_budget_exceeds_model_limit",
        );
      }
      const maxTokens = Math.min(maxOutputTokens, Math.max(request.inferenceConfig?.maxTokens ?? maxOutputTokens, budgetTokens + 1));
      const sampled = withoutSampling(request, ["temperature", "topP"]);
      const fields: Fields = { thinking: { type: "enabled", budget_tokens: budgetTokens } };
      if (profile.effortBeta) {
        const existingBetas = (request.additionalModelRequestFields as Fields | undefined)?.anthropic_beta;
        const betas = Array.isArray(existingBetas) ? existingBetas.filter((beta): beta is string => typeof beta === "string") : [];
        fields.output_config = { effort: budgetLevel };
        fields.anthropic_beta = betas.includes(EFFORT_BETA) ? betas : [...betas, EFFORT_BETA];
      }
      const next = withFields({ ...sampled, inferenceConfig: { ...sampled.inferenceConfig, maxTokens } }, fields);
      return { request: next, effort: budgetLevel };
    }
    case "nova": {
      // Nova 2 rejects sampling parameters and an output cap at high reasoning effort.
      const base = level === "high" ? withoutSampling(request, ["temperature", "topP", "maxTokens"]) : request;
      return { request: withFields(base, { reasoningConfig: { type: "enabled", maxReasoningEffort: level } }), effort: level };
    }
    case "openai":
      return { request: withFields(request, { reasoning_effort: level }), effort: level };
  }
}
