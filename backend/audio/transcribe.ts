/**
 * Sends speech chunks to a Bedrock speech model through Converse (an audio
 * block and an instruction) and collects their transcripts and token usage.
 *
 * Mistral's Voxtral models follow short instructions best: longer ones made
 * them summarize the first sentences. For timed formats they are asked for
 * "segment timestamps", which they answer in their own format,
 * `[ 0m3s240ms - 0m5s460ms ] text`, usually accurate to a few tenths of a
 * second; Mini sometimes stretches a segment by seconds, so timing.ts takes
 * them only as hints.
 */
import { ConverseCommand, type BedrockRuntimeClient, type ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { languageName } from "./language";
import { encodeWav, SAMPLE_RATE } from "./pcm";
import type { AudioChunk } from "./speech";

export interface TranscriptionSettings {
  /** The upstream Bedrock model ID. */
  modelId: string;
  /** ISO 639-1 code of the spoken language, if the client gave it. */
  language?: string;
  /** The client's context: names, terms, spelling or the preceding text. */
  prompt?: string;
  temperature: number;
  /** The model's configured output limit. */
  maxOutputTokens: number;
  /** Ask for segment timestamps. */
  timed: boolean;
}

/** A segment the model timed, in seconds from the start of the chunk's audio. */
export interface ModelSegment { start?: number; end?: number; text: string }

export interface ChunkTranscript {
  index: number;
  chunk: AudioChunk;
  text: string;
  /** The model's own segments when it timed them usably; otherwise undefined. */
  segments?: ModelSegment[];
  inputTokens: number;
  outputTokens: number;
  /** The model ran into its output limit, which for speech means it repeated itself. */
  truncated: boolean;
}

export interface TokenUsage { inputTokens: number; outputTokens: number; requests: number }

export function transcriptionInstruction(settings: Pick<TranscriptionSettings, "language" | "prompt" | "timed">): string {
  const language = settings.language ? languageName(settings.language) : undefined;
  const spoken = language ? ` The speech is in ${language}.` : "";
  // "Output only the transcription" made Voxtral Mini leave out spoken sentences that
  // sound like instructions ("Subtitles should be generated automatically.").
  let instruction = settings.timed
    ? `Transcribe this audio with segment timestamps.${spoken}`
    : `Transcribe this audio verbatim.${spoken}`;
  if (settings.prompt) instruction += `\nContext, and spelling of names and terms: ${settings.prompt}`;
  return instruction;
}

/** Generous output allowance for speech: fast speech in long-word languages, with timestamps, stays well under it. */
export function maxTokensFor(seconds: number, configuredMax: number, timed: boolean): number {
  return Math.max(16, Math.min(configuredMax, Math.ceil(seconds * (timed ? 16 : 12)) + 64));
}

const TIMESTAMP = String.raw`(?:\d+h)?\d+m\d+s\d+ms`;
const MARKER = new RegExp(String.raw`\[\s*(${TIMESTAMP})\s*(?:-\s*(${TIMESTAMP})\s*)?\]`, "g");

/**
 * Seconds of a Voxtral timestamp. Its "ms" digits read as a decimal fraction:
 * the models write 2.94 s as `2s94ms` as often as `2s944ms`.
 */
export function timestampSeconds(stamp: string): number | undefined {
  const match = /^(?:(\d+)h)?(\d+)m(\d+)s(\d+)ms$/.exec(stamp);
  if (!match) return undefined;
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4]}`);
}

/** The model's timed segments, and its text without the timestamps. */
export function parseSegments(output: string): { segments: ModelSegment[]; text: string } {
  const segments: ModelSegment[] = [];
  const markers = [...output.matchAll(MARKER)];
  const before = output.slice(0, markers[0]?.index ?? output.length).trim();
  if (before) segments.push({ text: before });
  markers.forEach((marker, index) => {
    const textStart = marker.index! + marker[0].length;
    const textEnd = markers[index + 1]?.index ?? output.length;
    const text = output.slice(textStart, textEnd).trim();
    if (!text) return;
    segments.push({ start: timestampSeconds(marker[1]!), end: marker[2] ? timestampSeconds(marker[2]) : undefined, text });
  });
  return { segments, text: segments.map((segment) => segment.text).join(" ") };
}

/**
 * Keep only timestamps that fit the chunk: within its duration, starting in
 * order, and ending after they start. Returns undefined when too few are left
 * to time the chunk by.
 */
export function usableSegments(segments: readonly ModelSegment[], duration: number): ModelSegment[] | undefined {
  const tolerance = 0.5;
  let lastStart = Number.NEGATIVE_INFINITY;
  const checked = segments.map((segment) => {
    let { start, end } = segment;
    if (start === undefined || start < -tolerance || start > duration + tolerance || start < lastStart - tolerance) start = undefined;
    if (start !== undefined) lastStart = start;
    if (end === undefined || start === undefined || end < start || end > duration + 1) end = undefined;
    return { text: segment.text, start, end };
  });
  const timed = checked.filter((segment) => segment.start !== undefined).length;
  return timed > 0 && timed >= checked.length / 2 ? checked : undefined;
}

/**
 * Cut a transcript at the point where it starts repeating itself: a run of
 * `minWords`+ words that occurs `minRepeats` times in a row is kept once.
 * Speech models fall into such loops on noise and at abrupt chunk ends.
 */
export function trimRepetition(text: string, minWords = 2, minRepeats = 3): string {
  const words = text.trim().split(/\s+/);
  const normalized = words.map((word) => word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""));
  // Loops repeat a phrase or a sentence or two.
  const maxWords = Math.min(60, Math.floor(words.length / minRepeats));
  for (let start = 0; start < words.length; start++) {
    for (let size = minWords; size <= maxWords && start + size * minRepeats <= words.length; size++) {
      let repeats = 1;
      while (start + size * (repeats + 1) <= words.length) {
        let same = true;
        for (let offset = 0; offset < size && same; offset++) {
          same = normalized[start + offset] === normalized[start + size * repeats + offset];
        }
        if (!same) break;
        repeats++;
      }
      if (repeats >= minRepeats) return words.slice(0, start + size).join(" ");
    }
  }
  return text.trim();
}

/** Collapse runs of `minRepeats` or more identical segments, as a looping model writes them, to one. */
function dropRepeatedSegments(segments: readonly ModelSegment[], minRepeats: number): ModelSegment[] {
  const key = (segment: ModelSegment) => segment.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const kept: ModelSegment[] = [];
  for (let first = 0; first < segments.length;) {
    let end = first + 1;
    while (end < segments.length && key(segments[end]!) === key(segments[first]!)) end++;
    if (end - first >= minRepeats) kept.push(segments[first]!);
    else kept.push(...segments.slice(first, end));
    first = end;
  }
  return kept;
}

function outputText(output: ConverseCommandOutput): string {
  return (output.output?.message?.content ?? []).map((part) => part.text ?? "").join("").trim();
}

/** Remove the wrapping some models add despite the instruction: quotes and a "Transcript:" label. */
export function cleanTranscript(text: string): string {
  let cleaned = text.trim().replace(/^(?:transcript(?:ion)?|text)\s*:\s*/i, "");
  const quoted = /^(["“”«»])([\s\S]*)(["“”«»])$/.exec(cleaned);
  if (quoted && !quoted[2]!.includes(quoted[1]!)) cleaned = quoted[2]!.trim();
  return cleaned.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

/** A model answer turned into transcript text and, when timed, usable segments. */
export function readTranscript(output: string, duration: number, timed: boolean, looped: boolean): { text: string; segments?: ModelSegment[] } {
  const parsed = parseSegments(output);
  // A looping answer repeats short runs; an ordinary one only long runs repeated often.
  const [minWords, minRepeats] = looped ? [2, 3] : [4, 4];
  const segments = dropRepeatedSegments(parsed.segments, looped ? 2 : 3)
    .map((segment) => ({ ...segment, text: cleanTranscript(trimRepetition(segment.text, minWords, minRepeats)) }))
    .filter((segment) => segment.text);
  const text = cleanTranscript(trimRepetition(segments.map((segment) => segment.text).join(" "), minWords, minRepeats));
  return { text, segments: timed ? usableSegments(segments, duration) : undefined };
}

/** A failed chunk request, with the tokens its answered attempts used. */
export class ChunkRequestError extends Error {
  override name = "ChunkRequestError";
  constructor(override readonly cause: unknown, readonly inputTokens: number, readonly outputTokens: number) {
    super(cause instanceof Error ? cause.message : "Chunk request failed");
  }
}

/**
 * Transcribe one chunk. A response that ran into the output limit is a
 * repetition loop: it is sent once more at a higher temperature, and whichever
 * attempt is usable is kept, with its loop cut off.
 */
export async function transcribeChunk(
  client: BedrockRuntimeClient,
  settings: TranscriptionSettings,
  item: { index: number; chunk: AudioChunk; samples: Int16Array },
  signal?: AbortSignal,
): Promise<ChunkTranscript> {
  const seconds = item.samples.length / SAMPLE_RATE;
  const audio = encodeWav(item.samples);
  const instruction = transcriptionInstruction(settings);
  const maxTokens = maxTokensFor(seconds, settings.maxOutputTokens, settings.timed);
  let inputTokens = 0;
  let outputTokens = 0;
  const attempt = async (temperature: number) => {
    const output = await client.send(new ConverseCommand({
      modelId: settings.modelId,
      messages: [{ role: "user", content: [{ audio: { format: "wav", source: { bytes: audio } } }, { text: instruction }] }],
      inferenceConfig: { maxTokens, temperature },
    }), { abortSignal: signal });
    inputTokens += output.usage?.inputTokens ?? 0;
    outputTokens += output.usage?.outputTokens ?? 0;
    return { output: outputText(output), truncated: output.stopReason === "max_tokens" };
  };

  let result: Awaited<ReturnType<typeof attempt>>;
  try {
    result = await attempt(settings.temperature);
  } catch (error) {
    throw new ChunkRequestError(error, inputTokens, outputTokens);
  }
  if (result.truncated) {
    try {
      const retry = await attempt(Math.max(settings.temperature, 0.5));
      const length = (answer: typeof result) => readTranscript(answer.output, seconds, false, true).text.length;
      if (!retry.truncated || length(retry) > length(result)) result = retry;
    } catch (error) {
      // The first answer is still usable; only a canceled request ends the chunk.
      if (signal?.aborted) throw new ChunkRequestError(error, inputTokens, outputTokens);
    }
  }
  const { text, segments } = readTranscript(result.output, seconds, settings.timed, result.truncated);
  return { index: item.index, chunk: item.chunk, text, segments, inputTokens, outputTokens, truncated: result.truncated };
}

/** Thrown when transcription stopped; `usage` is what the answered requests used. */
export class ChunkTranscriptionError extends Error {
  override name = "ChunkTranscriptionError";
  constructor(override readonly cause: unknown, readonly usage: TokenUsage) {
    super(cause instanceof Error ? cause.message : "Transcription failed");
  }
}

/**
 * Transcribe chunks with up to `concurrency` requests at a time, in the order
 * the source yields them. The first failure stops the rest: requests in flight
 * are canceled and the error is thrown with the usage of the answered requests.
 */
export async function transcribeChunks(
  source: AsyncIterable<{ index: number; chunk: AudioChunk; samples: Int16Array }>,
  transcribe: (item: { index: number; chunk: AudioChunk; samples: Int16Array }, signal: AbortSignal) => Promise<ChunkTranscript>,
  options: { concurrency: number; signal?: AbortSignal },
): Promise<{ transcripts: ChunkTranscript[]; usage: TokenUsage }> {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const iterator = source[Symbol.asyncIterator]();
  const transcripts: ChunkTranscript[] = [];
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, requests: 0 };
  let failure: { error: unknown } | undefined;
  const fail = (error: unknown) => {
    failure ??= { error };
    controller.abort(error);
  };

  const worker = async () => {
    while (!failure && !signal.aborted) {
      let next: IteratorResult<{ index: number; chunk: AudioChunk; samples: Int16Array }>;
      try {
        next = await iterator.next();
      } catch (error) {
        fail(error);
        return;
      }
      if (next.done) return;
      try {
        const transcript = await transcribe(next.value, signal);
        transcripts.push(transcript);
        usage.inputTokens += transcript.inputTokens;
        usage.outputTokens += transcript.outputTokens;
        usage.requests++;
      } catch (error) {
        let cause = error;
        if (error instanceof ChunkRequestError) {
          usage.inputTokens += error.inputTokens;
          usage.outputTokens += error.outputTokens;
          cause = error.cause;
        }
        fail(cause);
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));
  await iterator.return?.();
  if (failure || options.signal?.aborted) {
    throw new ChunkTranscriptionError(failure?.error ?? options.signal?.reason, usage);
  }
  transcripts.sort((a, b) => a.index - b.index);
  return { transcripts, usage };
}
