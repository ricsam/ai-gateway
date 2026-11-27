/**
 * Transcribes an uploaded file: decode it, find its speech, cut the speech
 * into chunks, transcribe the chunks, and, for timed formats, time the
 * transcript's sentences and clauses.
 */
import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { openAudio } from "./decode";
import { SAMPLE_RATE } from "./pcm";
import { cutChunks, findSpeech, LevelMeter, planChunks } from "./speech";
import { timeTranscript, type TimedUnit } from "./timing";
import { transcribeChunk, transcribeChunks, type ChunkTranscript, type TokenUsage, type TranscriptionSettings } from "./transcribe";

/** Requests in flight to the model for one transcription. */
export const CHUNK_CONCURRENCY = 6;

export interface TranscriptionJob {
  bytes: Uint8Array;
  /** `settings.timed` asks for timed sentences and clauses (verbose_json, SRT, WebVTT, subtitles). */
  settings: TranscriptionSettings;
  client: BedrockRuntimeClient;
  maxSeconds: number;
  signal?: AbortSignal;
  concurrency?: number;
  /** Test seam: replaces the Bedrock request for one chunk. */
  transcribe?: (item: Parameters<typeof transcribeChunk>[2], signal: AbortSignal) => Promise<ChunkTranscript>;
}

export interface TranscriptionResult {
  /** Seconds of audio in the file. */
  duration: number;
  /** Seconds of audio sent to the model. */
  sentSeconds: number;
  container: string;
  decoder: "wav" | "ffmpeg";
  chunks: number;
  text: string;
  /** Timed sentences and clauses; empty unless the job was timed. */
  units: TimedUnit[];
  usage: TokenUsage;
}

export async function runTranscription(job: TranscriptionJob): Promise<TranscriptionResult> {
  const source = openAudio(job.bytes, { maxSeconds: job.maxSeconds });

  // First pass: how loud each 10 ms is, to find the speech.
  const meter = new LevelMeter();
  for await (const block of source.blocks(job.signal)) meter.push(block);
  const levels = meter.finish();
  const duration = meter.samples / SAMPLE_RATE;
  const speech = findSpeech(levels);
  const chunks = planChunks(speech.regions, levels);
  const base = {
    duration,
    sentSeconds: chunks.reduce((total, chunk) => total + chunk.end - chunk.start, 0),
    container: source.container,
    decoder: source.decoder,
    chunks: chunks.length,
  };
  if (chunks.length === 0) return { ...base, text: "", units: [], usage: { inputTokens: 0, outputTokens: 0, requests: 0 } };

  // Second pass: cut the chunks and transcribe them.
  const transcribe = job.transcribe ?? ((item, signal) => transcribeChunk(job.client, job.settings, item, signal));
  const { transcripts, usage } = await transcribeChunks(cutChunks(source.blocks(job.signal), chunks), transcribe, {
    concurrency: job.concurrency ?? CHUNK_CONCURRENCY,
    signal: job.signal,
  });
  const text = transcripts.map((transcript) => transcript.text).filter(Boolean).join(" ");
  const units = job.settings.timed ? transcripts.flatMap((transcript) => timeTranscript(transcript, transcript.chunk)) : [];
  return { ...base, text, units, usage };
}
