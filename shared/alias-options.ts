import { detectReasoningProfile, EFFORT_LEVELS, resolveReasoningProfile, type EffortLevel } from "./reasoning";

export type AliasReasoningSource = "alias" | "client";
export interface AliasSettings {
  /** Omitted by legacy callers: preserve the pinned alias policy. */
  reasoningSource?: AliasReasoningSource;
  thinking: boolean;
  effort: EffortLevel | null;
}
export interface AliasUpstream {
  modelId: string;
  thinking: boolean;
  reasoningMode?: string | null;
  maxOutputTokens: number;
}

/** Explicit capabilities: an alias must never claim to turn off an always-thinking model. */
export function getAliasCapabilities(model: AliasUpstream) {
  const profile = resolveReasoningProfile(model.modelId, model.reasoningMode);
  const recognized = detectReasoningProfile(model.modelId);
  const noControls = !model.thinking && !recognized && (!model.reasoningMode || model.reasoningMode === "auto");
  const canDisableThinking = noControls || profile.style === "anthropic_budget" || profile.style === "nova"
    || (profile.style === "anthropic_adaptive" && (profile.thinkingOptional === true || profile.thinkingOff?.type === "disabled"));
  const efforts = profile.style === "anthropic_budget"
    ? profile.efforts.filter((level) => ({ low: 1024, medium: 4096, high: 10000 }[level as "low" | "medium" | "high"] ?? Infinity) < model.maxOutputTokens)
    : profile.efforts;
  return {
    efforts,
    canEnableThinking: model.thinking,
    canDisableThinking,
    canSetEffortWithoutThinking: model.thinking && (profile.style === "anthropic_adaptive" || profile.effortBeta === true),
    thinkingOffDescription: canDisableThinking ? "Thinking can be disabled."
      : profile.thinkingOff?.type === "between_tools"
        ? "This model only disables up-front thinking; thinking between tools remains enabled. It cannot be configured as thinking off."
        : "This model does not support disabling thinking.",
  };
}

export function validateAliasSettings(model: AliasUpstream, settings: AliasSettings): string | null {
  if (settings.reasoningSource === "client") return null;
  if (settings.reasoningSource !== undefined && settings.reasoningSource !== "alias") return "Unsupported alias reasoning source";
  const capabilities = getAliasCapabilities(model);
  if (settings.effort !== null && !(EFFORT_LEVELS as readonly string[]).includes(settings.effort)) return "Unsupported alias effort";
  if (settings.thinking) {
    if (!capabilities.canEnableThinking) return "Enable reasoning controls on the upstream model before enabling alias thinking";
    if (settings.effort === null) return "Choose an effort level when thinking is enabled";
  } else {
    if (!capabilities.canDisableThinking) return capabilities.thinkingOffDescription;
    if (settings.effort !== null && !capabilities.canSetEffortWithoutThinking) return "This model cannot set effort independently of thinking";
  }
  if (settings.effort !== null && !capabilities.efforts.includes(settings.effort)) return "Choose an effort supported by the upstream model and its output limit";
  return null;
}
