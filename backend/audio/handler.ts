/**
 * Speech-to-text endpoints:
 *
 * - `POST /v1/audio/transcriptions`, OpenAI's transcription API: the transcript
 *   as `json`, `text` or `verbose_json` (timed segments), or subtitles as `srt`
 *   or `vtt`.
 * - `POST /v1/audio/subtitles`, the gateway's subtitle API: SRT, WebVTT or JSON
 *   cues for an audio or video file, with the line length and lines per cue
 *   the client asks for.
 *
 * Both take multipart/form-data with the file and a catalog model that accepts
 * audio (Mistral's Voxtral models on Bedrock), need `ai.invoke`, and settle the
 * tokens of every model request as one usage event under the request ID.
 */
import { getBedrockClient } from "../bedrock";
import { calculateCostBreakdown, checkCreditAdmission, deductCredits, type CostBreakdown } from "../credit-service";
import type { CreditSettlement } from "../credit-settlement";
import { resolveModel } from "../model-catalog";
import { errorResponse, logUpstreamError, mapUpstreamError } from "../openai-proxy/errors";
import { authenticateApiKeyPrincipal, requireProxyScope, type ProxyPrincipal } from "../proxy-auth";
import { AudioInputError } from "./errors";
import { FfmpegDecodeError } from "./ffmpeg";
import { guessLanguage, languageName, normalizeLanguageCode } from "./language";
import { runTranscription, type TranscriptionResult } from "./pipeline";
import { buildCues, DEFAULT_MAX_LINE_LENGTH, DEFAULT_MAX_LINES, formatSrt, formatVtt, type Cue } from "./subtitles";
import { segmentsOf } from "./timing";
import { ChunkTranscriptionError, type TokenUsage } from "./transcribe";

/** The largest upload accepted, as OpenAI's transcription API accepts. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** The longest audio accepted. */
export const MAX_AUDIO_SECONDS = 2 * 60 * 60;
/** Room for the other form fields and multipart framing. */
const FORM_OVERHEAD_BYTES = 1024 * 1024;
const MAX_PROMPT_LENGTH = 4_000;

export type AudioEndpoint = "transcriptions" | "subtitles";

const FORMATS: Record<AudioEndpoint, readonly string[]> = {
  transcriptions: ["json", "text", "srt", "verbose_json", "vtt"],
  subtitles: ["srt", "vtt", "json"],
};

class FieldError extends Error {
  constructor(message: string, readonly param: string, readonly code = "invalid_request", readonly status = 400) {
    super(message);
  }
}

interface AudioRequest {
  file: File;
  model: string;
  language?: string;
  prompt?: string;
  temperature: number;
  responseFormat: string;
  maxLineLength: number;
  maxLines: number;
}

function textField(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  if (value === null) return undefined;
  if (typeof value !== "string") throw new FieldError(`${name} must be a text field`, name);
  return value.trim() === "" ? undefined : value.trim();
}

function integerField(form: FormData, name: string, min: number, max: number, fallback: number): number {
  const value = textField(form, name);
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new FieldError(`${name} must be an integer from ${min} to ${max}`, name);
  return number;
}

function parseFields(form: FormData, endpoint: AudioEndpoint): AudioRequest {
  const file = form.get("file");
  if (file === null) throw new FieldError("file is required", "file", "missing_required_parameter");
  if (typeof file === "string") throw new FieldError("file must be a file upload", "file");
  if (file.size === 0) throw new FieldError("file is empty", "file");
  if (file.size > MAX_FILE_BYTES) throw new FieldError(`file must be at most ${MAX_FILE_BYTES / (1024 * 1024)} MB`, "file", "file_too_large", 413);

  const model = textField(form, "model");
  if (!model) throw new FieldError("model is required", "model", "missing_required_parameter");

  const responseFormat = textField(form, "response_format") ?? FORMATS[endpoint][0]!;
  if (!FORMATS[endpoint].includes(responseFormat)) {
    throw new FieldError(`response_format must be one of ${FORMATS[endpoint].join(", ")}`, "response_format");
  }

  const rawLanguage = textField(form, "language");
  const language = rawLanguage === undefined ? undefined : normalizeLanguageCode(rawLanguage);
  if (rawLanguage !== undefined && !language) throw new FieldError("language must be an ISO 639-1 code, such as en or de", "language", "invalid_language");

  const prompt = textField(form, "prompt");
  if (prompt && prompt.length > MAX_PROMPT_LENGTH) throw new FieldError(`prompt must be at most ${MAX_PROMPT_LENGTH} characters`, "prompt");

  const rawTemperature = textField(form, "temperature");
  const temperature = rawTemperature === undefined ? 0 : Number(rawTemperature);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1) throw new FieldError("temperature must be a number from 0 to 1", "temperature");

  for (const name of ["timestamp_granularities[]", "timestamp_granularities"]) {
    for (const value of form.getAll(name)) {
      if (value === "segment") continue;
      if (value === "word") throw new FieldError("Word timestamps are not supported; segment timestamps are", name, "unsupported_value");
      throw new FieldError(`${name} must be segment`, name);
    }
  }
  const stream = textField(form, "stream");
  if (stream !== undefined && stream !== "false") throw new FieldError("Streaming transcription is not supported", "stream", "unsupported_parameter");

  return {
    file, model, language, prompt, temperature, responseFormat,
    maxLineLength: endpoint === "subtitles" ? integerField(form, "max_line_length", 16, 120, DEFAULT_MAX_LINE_LENGTH) : DEFAULT_MAX_LINE_LENGTH,
    maxLines: endpoint === "subtitles" ? integerField(form, "max_lines", 1, 4, DEFAULT_MAX_LINES) : DEFAULT_MAX_LINES,
  };
}

/** The request body, read with a size limit; multipart without a Content-Length is allowed. */
async function readForm(request: Request): Promise<FormData> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType)) {
    throw new FieldError("Send the audio as multipart/form-data with a file field", "file", "invalid_content_type");
  }
  const limit = MAX_FILE_BYTES + FORM_OVERHEAD_BYTES;
  const tooLarge = () => new FieldError(`file must be at most ${MAX_FILE_BYTES / (1024 * 1024)} MB`, "file", "file_too_large", 413);
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw tooLarge();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(new Uint8Array(value));
    }
  }
  try {
    return await new Response(new Blob(chunks), { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new FieldError("The multipart/form-data body could not be read", "file", "invalid_multipart");
  }
}

type Accounting =
  | { status: "settled"; costs: CostBreakdown; settlement: CreditSettlement }
  | { status: "free" }
  | { status: "failed" };

async function settle(params: {
  principal: ProxyPrincipal; endpoint: AudioEndpoint; requestId: string;
  model: { modelId: string; inputPricePerMTok: number; outputPricePerMTok: number };
  usage: TokenUsage;
}): Promise<Accounting> {
  const { principal, model, usage } = params;
  if (usage.requests === 0 && usage.inputTokens === 0 && usage.outputTokens === 0) return { status: "free" };
  const costs = calculateCostBreakdown({
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    inputPricePerMTok: model.inputPricePerMTok, outputPricePerMTok: model.outputPricePerMTok,
  });
  try {
    const settlement = await deductCredits({
      userId: principal.userId,
      amount: costs.total,
      type: "api",
      description: `${params.endpoint === "subtitles" ? "Subtitles" : "Audio transcription"} using ${model.modelId}`,
      requestId: params.requestId,
      apiKeyId: principal.credentialType === "api_key" ? principal.credentialId : undefined,
      source: "api",
      modelId: model.modelId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      inputCost: costs.inputCost,
      outputCost: costs.outputCost,
    });
    return { status: "settled", costs, settlement };
  } catch (error) {
    console.error(`[Audio] Billing settlement failed: request=${params.requestId}`, error instanceof Error ? error.message : "unknown error");
    return { status: "failed" };
  }
}

/** OpenAI's token usage of a transcription, with the gateway's settled cost (as in chat completions). */
function usageBody(usage: TokenUsage, duration: number, accounting: Accounting) {
  const base = {
    type: "tokens" as const,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    /** Seconds of audio in the file. */
    seconds: Math.round(duration * 1000) / 1000,
  };
  if (accounting.status === "failed") return { ...base, cost_details: { currency: "USD" as const, status: "failed" as const } };
  if (accounting.status === "free") {
    return { ...base, cost: 0, cost_details: { currency: "USD" as const, status: "settled" as const, calculated_cost: 0, input_cost: 0, output_cost: 0, partially_charged: false } };
  }
  return {
    ...base,
    cost: accounting.settlement.creditsCharged,
    cost_details: {
      currency: "USD" as const, status: "settled" as const, calculated_cost: accounting.settlement.actualCost,
      input_cost: accounting.costs.inputCost, output_cost: accounting.costs.outputCost,
      partially_charged: accounting.settlement.partiallyCharged,
    },
  };
}

/** A USD amount with up to 8 decimals, never in exponent form ("0.0000005", not "5e-7"). */
function formatCost(amount: number): string {
  return amount.toFixed(8).replace(/\.?0+$/, "") || "0";
}

/** Accounting headers, for the formats whose body has no room for usage, and for failed requests that were charged. */
function usageHeaders(requestId: string, usage: TokenUsage, accounting: Accounting): Headers {
  const headers = new Headers({ "x-request-id": requestId, "cache-control": "no-store" });
  headers.set("x-usage-input-tokens", String(usage.inputTokens));
  headers.set("x-usage-output-tokens", String(usage.outputTokens));
  headers.set("x-usage-cost-status", accounting.status === "failed" ? "failed" : "settled");
  if (accounting.status !== "failed") headers.set("x-usage-cost", formatCost(accounting.status === "free" ? 0 : accounting.settlement.creditsCharged));
  return headers;
}

/** An error response with the request's headers: its ID, and its accounting when it was charged. */
function failedRequest(response: Response, headers: Headers): Response {
  for (const [name, value] of headers) response.headers.set(name, value);
  return response;
}

function cueBody(cue: Cue) {
  return { start: round(cue.start), end: round(cue.end), text: cue.lines.join("\n"), lines: cue.lines };
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

function respond(endpoint: AudioEndpoint, request: AudioRequest, result: TranscriptionResult, requestId: string, accounting: Accounting): Response {
  const headers = usageHeaders(requestId, result.usage, accounting);
  const usage = usageBody(result.usage, result.duration, accounting);
  const language = (request.language ? languageName(request.language) : undefined)
    ?? (() => { const guessed = guessLanguage(result.text); return guessed ? languageName(guessed) : undefined; })();
  const languageLabel = language?.toLowerCase() ?? "unknown";
  const cues = () => buildCues(result.units, { maxLineLength: request.maxLineLength, maxLines: request.maxLines });
  const send = (body: string, type: string) => {
    headers.set("content-type", type);
    return new Response(body, { headers });
  };

  switch (request.responseFormat) {
    case "text": return send(result.text, "text/plain; charset=utf-8");
    case "srt": return send(formatSrt(cues()), "application/x-subrip; charset=utf-8");
    case "vtt": return send(formatVtt(cues()), "text/vtt; charset=utf-8");
    case "verbose_json":
      return Response.json({
        task: "transcribe",
        language: languageLabel,
        duration: round(result.duration),
        text: result.text,
        // OpenAI's segment fields; the gateway has no tokens, log probabilities or speech probabilities to report.
        segments: segmentsOf(result.units).map((segment, id) => ({
          id, seek: 0, start: round(segment.start), end: round(segment.end), text: segment.text,
          tokens: [], temperature: request.temperature, avg_logprob: 0, compression_ratio: 0, no_speech_prob: 0,
        })),
        usage,
      }, { headers });
    default:
      if (endpoint === "subtitles") {
        return Response.json({ language: languageLabel, duration: round(result.duration), text: result.text, cues: cues().map(cueBody), usage }, { headers });
      }
      return Response.json({ text: result.text, usage }, { headers });
  }
}

function requestIdOf(request: Request): string {
  const supplied = request.headers.get("x-request-id")?.trim();
  return supplied && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : `audio-${crypto.randomUUID()}`;
}

export async function handleAudio(
  request: Request,
  endpoint: AudioEndpoint,
  /**
   * Called once the upload is read and admitted: the server lifts its idle timeout for the request,
   * which sends nothing until the transcript is done. Bun 1.4 already spares requests with a body
   * from the idle timeout (it cuts off only bodiless ones), but doesn't document that.
   */
  options: { keepAlive?: () => void } = {},
): Promise<Response> {
  const auth = requireProxyScope(await authenticateApiKeyPrincipal(request), "ai.invoke");
  if (!auth.ok) {
    return errorResponse(auth.message, auth.status === 401 ? "authentication_error" : "permission_error", auth.status, auth.code);
  }
  const principal = auth.principal;

  let audio: AudioRequest;
  try {
    audio = parseFields(await readForm(request), endpoint);
  } catch (error) {
    if (error instanceof FieldError) return errorResponse(error.message, "invalid_request_error", error.status, error.code, error.param);
    if (request.signal.aborted) return errorResponse("Client request aborted", "invalid_request_error", 400, "request_aborted");
    throw error;
  }

  const resolved = await resolveModel(audio.model);
  const model = resolved?.upstream;
  if (!model) return errorResponse(`Model "${audio.model}" is not available for API access`, "invalid_request_error", 400, "model_not_available", "model");

  const admission = await checkCreditAdmission(principal.userId);
  if (!admission.ok) return errorResponse(admission.message, "invalid_request_error", 402, admission.code);

  const requestId = requestIdOf(request);
  const context = `request=${requestId} model=${model.modelId} endpoint=${endpoint}`;
  console.log(`[Audio] ${context} user=${principal.userId.slice(0, 8)} format=${audio.responseFormat} bytes=${audio.file.size} language=${audio.language ?? "auto"}`);
  options.keepAlive?.();

  const bytes = new Uint8Array(await audio.file.arrayBuffer());
  const timed = ["verbose_json", "srt", "vtt"].includes(audio.responseFormat) || endpoint === "subtitles";
  let result: TranscriptionResult;
  try {
    const client = await getBedrockClient(model.region);
    result = await runTranscription({
      bytes,
      client,
      maxSeconds: MAX_AUDIO_SECONDS,
      signal: request.signal,
      settings: {
        modelId: model.modelId, language: audio.language, prompt: audio.prompt,
        temperature: audio.temperature, maxOutputTokens: model.maxOutputTokens, timed,
      },
    });
  } catch (error) {
    const failure = error instanceof ChunkTranscriptionError ? error : undefined;
    const cause = failure ? failure.cause : error;
    // What the model already answered is charged, as for a stream that breaks off.
    const accounting = failure ? await settle({ principal, endpoint, requestId, model, usage: failure.usage }) : { status: "free" as const };
    const headers = accounting.status === "free"
      ? new Headers({ "x-request-id": requestId, "cache-control": "no-store" })
      : usageHeaders(requestId, failure!.usage, accounting);
    if (request.signal.aborted) {
      console.info(`[Audio] Request canceled: ${context} after=${failure?.usage.requests ?? 0} chunks`);
      return failedRequest(errorResponse("Client request aborted", "invalid_request_error", 400, "request_aborted"), headers);
    }
    if (cause instanceof AudioInputError) {
      const detail = cause instanceof FfmpegDecodeError ? ` detail=${JSON.stringify(cause.detail.slice(0, 300))}` : "";
      console.warn(`[Audio] Rejected file: ${context} code=${cause.code}${detail}`);
      return failedRequest(errorResponse(cause.message, "invalid_request_error", cause.status, cause.code, "file"), headers);
    }
    const mapped = mapUpstreamError(cause);
    logUpstreamError(mapped, cause, context, "[Audio]");
    return failedRequest(errorResponse(mapped.message, mapped.type, mapped.status, mapped.code), headers);
  }

  const accounting = await settle({ principal, endpoint, requestId, model, usage: result.usage });
  const charged = accounting.status === "settled"
    ? `actualCost=${accounting.costs.total.toFixed(6)} charged=${accounting.settlement.creditsCharged.toFixed(6)} balanceAfter=${accounting.settlement.balanceAfter.toFixed(6)} partial=${accounting.settlement.partiallyCharged}`
    : `cost=${accounting.status}`;
  console.log(`[Audio] Complete: ${context} container=${result.container} decoder=${result.decoder} duration=${result.duration.toFixed(1)}s sent=${result.sentSeconds.toFixed(1)}s chunks=${result.chunks} input=${result.usage.inputTokens} output=${result.usage.outputTokens} ${charged}`);
  return respond(endpoint, audio, result, requestId, accounting);
}
