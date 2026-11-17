import { z } from "zod";
import { REASONING_EFFORT_VALUES, REASONING_MODES } from "./reasoning";

/** The largest price the numeric(20,8) price columns hold (USD per million tokens). */
export const MAX_PRICE_PER_MTOK = 999_999_999_999;
/** The largest token count the integer columns hold. */
export const MAX_TOKEN_COUNT = 2_147_483_647;

// Model writes, shared by the admin UI (RPC contract) and the management API.
// Nullable fields accept null to clear them: no cache price, no context window,
// no description, the AWS default region, or the model's own default effort.
const price = z.number().nonnegative().max(MAX_PRICE_PER_MTOK);
const tokens = z.number().int().positive().max(MAX_TOKEN_COUNT);
export const modelCreateSchema = z.object({
  /** Bedrock model ID, inference profile or ARN; also the model's public ID in /v1/models. */
  modelId: z.string().trim().min(1).max(2048),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  inputPricePerMTok: price,
  outputPricePerMTok: price,
  cacheWrite5mPricePerMTok: price.nullable().optional(),
  cacheWrite1hPricePerMTok: price.nullable().optional(),
  cacheReadPricePerMTok: price.nullable().optional(),
  contextWindow: tokens.nullable().optional(),
  maxOutputTokens: tokens.optional(),
  thinking: z.boolean().optional(),
  managedCache: z.boolean().optional(),
  reasoningMode: z.enum(REASONING_MODES).optional(),
  defaultReasoningEffort: z.enum(REASONING_EFFORT_VALUES).nullable().optional(),
  enabled: z.boolean().optional(),
  region: z.string().max(64).nullable().optional(),
});
export const modelUpdateSchema = modelCreateSchema.partial();
export type ModelCreateInput = z.infer<typeof modelCreateSchema>;
export type ModelUpdateInput = z.infer<typeof modelUpdateSchema>;
