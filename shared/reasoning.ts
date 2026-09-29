/**
 * Reasoning-effort vocabulary and Bedrock model reasoning profiles.
 *
 * Shared by the backend (request mapping, model catalog responses) and the
 * admin UI (showing what "automatic" detection resolves to). Keep this module
 * free of runtime dependencies.
 */

/** Values accepted in the OpenAI-compatible `reasoning_effort` request field. */
export const REASONING_EFFORT_VALUES = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORT_VALUES)[number];

/** Upstream effort levels, ordered from least to most effort. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** How a model's reasoning controls are expressed in Bedrock Converse requests. */
export const REASONING_MODES = ["auto", "anthropic_adaptive", "anthropic_budget", "nova", "openai"] as const;
export type ReasoningMode = (typeof REASONING_MODES)[number];
export type ReasoningStyle = Exclude<ReasoningMode, "auto">;

export const REASONING_MODE_LABELS: Record<ReasoningMode, string> = {
  auto: "Automatic (detect from model ID)",
  anthropic_adaptive: "Claude adaptive thinking + effort",
  anthropic_budget: "Claude extended thinking budget",
  nova: "Amazon Nova reasoning effort",
  openai: "OpenAI reasoning effort",
};

export interface ReasoningProfile {
  style: ReasoningStyle;
  /** Upstream effort levels the model accepts, in ascending order. */
  efforts: readonly EffortLevel[];
  /** Short human-readable description of the resolved profile. */
  label: string;
  /** True when the profile was recognized from the Bedrock model ID. */
  detected: boolean;
  /**
   * Anthropic adaptive only: thinking configuration that turns thinking off for
   * `reasoning_effort: "none"`. Absent when thinking is already off by default
   * or cannot be turned off, in which case the model default is used.
   */
  thinkingOff?: { type: "disabled" } | { type: "between_tools" };
  /** Anthropic adaptive only: request summarized thinking text (models whose default display is omitted). */
  summarizedDisplay?: boolean;
  /** Anthropic budget only: the model also accepts `output_config.effort` behind the effort-2025-11-24 beta. */
  effortBeta?: boolean;
}

const ALL_LEVELS: readonly EffortLevel[] = EFFORT_LEVELS;
const WITHOUT_XHIGH: readonly EffortLevel[] = ["low", "medium", "high", "max"];
const BASIC_LEVELS: readonly EffortLevel[] = ["low", "medium", "high"];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORT_VALUES as readonly string[]).includes(value);
}

export function isReasoningMode(value: unknown): value is ReasoningMode {
  return typeof value === "string" && (REASONING_MODES as readonly string[]).includes(value);
}

interface ClaudeModel { family: string; major: number | null; minor: number }

function parseClaudeModel(id: string): ClaudeModel | null {
  // Current naming: claude-<family>-<major>[-<minor>], e.g. claude-opus-4-7,
  // claude-sonnet-4-5-20250929-v1:0 or claude-opus-4-20250514-v1:0 (no minor).
  const current = id.match(/(?:^|[./:])(?:anthropic\.)?claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})(?!\d))?/);
  if (current) return { family: current[1]!, major: Number(current[2]), minor: current[3] ? Number(current[3]) : 0 };
  const preview = id.match(/(?:^|[./:])(?:anthropic\.)?claude-(fable|mythos)-preview/);
  if (preview) return { family: `${preview[1]}-preview`, major: null, minor: 0 };
  // Legacy naming: claude-<major>-<minor>-<family>, e.g. claude-3-7-sonnet-20250219-v1:0.
  const legacy = id.match(/(?:^|[./:])(?:anthropic\.)?claude-(\d+)-(\d+)-(opus|sonnet|haiku)/);
  if (legacy) return { family: legacy[3]!, major: Number(legacy[1]), minor: Number(legacy[2]) };
  return null;
}

function adaptive(label: string, efforts: readonly EffortLevel[], options: Pick<ReasoningProfile, "thinkingOff" | "summarizedDisplay"> = {}): ReasoningProfile {
  return { style: "anthropic_adaptive", efforts, label, detected: true, ...options };
}

function budget(label: string, effortBeta = false): ReasoningProfile {
  return { style: "anthropic_budget", efforts: BASIC_LEVELS, label, detected: true, ...(effortBeta && { effortBeta }) };
}

function claudeProfile(model: ClaudeModel): ReasoningProfile {
  const name = model.major === null
    ? `Claude ${model.family.replace("-preview", " Preview").replace(/^./, (c) => c.toUpperCase())}`
    : `Claude ${model.family.replace(/^./, (c) => c.toUpperCase())} ${model.major}${model.minor ? `.${model.minor}` : ""}`;
  const { family, major, minor } = model;
  // Fable and Mythos only support adaptive thinking, which is always on.
  if (family === "fable-preview" || family === "mythos-preview") return adaptive(name, WITHOUT_XHIGH, { summarizedDisplay: true });
  if (family === "fable" || family === "mythos" || major === null) return adaptive(name, ALL_LEVELS, { summarizedDisplay: true });
  if (major >= 5) {
    // Opus 5.5+ always thinks; Sonnet 5.5+ turns up-front thinking off with between_tools;
    // Opus/Sonnet 5 accept thinking.type "disabled". Unknown variants keep the model default for "none".
    if (family === "opus" && minor >= 5) return adaptive(name, ALL_LEVELS, { summarizedDisplay: true });
    if (family === "sonnet" && minor >= 5) return adaptive(name, ALL_LEVELS, { summarizedDisplay: true, thinkingOff: { type: "between_tools" } });
    if ((family === "opus" || family === "sonnet") && minor === 0) return adaptive(name, ALL_LEVELS, { summarizedDisplay: true, thinkingOff: { type: "disabled" } });
    return adaptive(name, ALL_LEVELS, { summarizedDisplay: true });
  }
  if (major === 4) {
    // 4.7+ reject budget thinking, default to omitted thinking display, and add xhigh.
    if (minor >= 7) return adaptive(name, ALL_LEVELS, { summarizedDisplay: true });
    // 4.6 deprecates budget thinking; its default display is already summarized.
    if (minor === 6) return adaptive(name, WITHOUT_XHIGH);
    if (minor === 5 && family === "opus") return budget(name, true);
    return budget(name);
  }
  return budget(name);
}

/** Recognize the reasoning profile of a Bedrock model, inference profile, or ARN from its identifier. */
export function detectReasoningProfile(modelId: string): ReasoningProfile | null {
  const id = modelId.trim().toLowerCase();
  const claude = parseClaudeModel(id);
  if (claude) return claudeProfile(claude);
  if (/(?:^|[./:])amazon\.nova-2-/.test(id)) return { style: "nova", efforts: BASIC_LEVELS, label: "Amazon Nova 2", detected: true };
  if (/(?:^|[./:])openai\.gpt-oss-/.test(id)) return { style: "openai", efforts: BASIC_LEVELS, label: "OpenAI gpt-oss", detected: true };
  return null;
}

function genericProfile(style: ReasoningStyle): ReasoningProfile {
  switch (style) {
    case "anthropic_adaptive": return { style, efforts: ALL_LEVELS, label: "Claude adaptive thinking", detected: false, summarizedDisplay: true };
    case "anthropic_budget": return { style, efforts: BASIC_LEVELS, label: "Claude extended thinking budget", detected: false };
    case "nova": return { style, efforts: BASIC_LEVELS, label: "Amazon Nova reasoning", detected: false };
    case "openai": return { style, efforts: BASIC_LEVELS, label: "OpenAI reasoning", detected: false };
  }
}

/**
 * Resolve the effective reasoning profile for a configured model. Automatic mode
 * uses model-ID detection and falls back to the historical Claude thinking-budget
 * mapping for identifiers it cannot recognize (for example application inference
 * profile ARNs). An explicit mode reuses detected details when they agree.
 */
export function resolveReasoningProfile(modelId: string, mode: string | null | undefined): ReasoningProfile {
  const detected = detectReasoningProfile(modelId);
  if (!isReasoningMode(mode) || mode === "auto") return detected ?? genericProfile("anthropic_budget");
  return detected?.style === mode ? detected : genericProfile(mode);
}

/** Map a requested effort onto a level the profile supports: minimal behaves like low, then clamp down, then up. */
export function resolveEffortLevel(requested: Exclude<ReasoningEffort, "none">, supported: readonly EffortLevel[]): EffortLevel {
  const wanted: EffortLevel = requested === "minimal" ? "low" : requested;
  if (supported.includes(wanted)) return wanted;
  const rank = EFFORT_LEVELS.indexOf(wanted);
  const below = [...supported].filter((level) => EFFORT_LEVELS.indexOf(level) < rank).pop();
  if (below) return below;
  return supported.find((level) => EFFORT_LEVELS.indexOf(level) > rank) ?? wanted;
}

/** Reasoning-effort values a client can usefully send for a model (empty when reasoning is disabled). */
export function supportedReasoningEfforts(model: { modelId: string; thinking: boolean; reasoningMode?: string | null }): ReasoningEffort[] {
  if (!model.thinking) return [];
  return ["none", ...resolveReasoningProfile(model.modelId, model.reasoningMode).efforts];
}
