/**
 * Finds where an audio file has speech and cuts it into the chunks sent to the
 * model. Speech models invent text for silence and noise (and can repeat it
 * until their output limit), so only speech is sent: an adaptive energy
 * detector marks speech regions, and chunks of at most `maxChunkSeconds` are
 * cut in the pauses between them. Long silences are left out entirely.
 */
import { SAMPLE_RATE } from "./pcm";

export const FRAME_SECONDS = 0.01;
const FRAME_SAMPLES = SAMPLE_RATE * FRAME_SECONDS;

/** Frames quieter than this are digital silence and never set the noise floor. */
const DIGITAL_SILENCE_DB = -80;
/** Speech is at least this much above the noise floor. */
const MIN_SNR_DB = 6;
/** Audio whose loud frames are within this of its quiet frames is steady noise, a tone or silence. */
const MIN_DYNAMIC_RANGE_DB = 6;

export interface TimeRange { start: number; end: number }

/** Per-frame levels (dBFS of 10 ms frames) of blocks of 16 kHz samples. */
export class LevelMeter {
  private levels = new Float32Array(4_096);
  private count = 0;
  private sum = 0;
  private filled = 0;
  samples = 0;

  push(block: Int16Array): void {
    this.samples += block.length;
    for (let index = 0; index < block.length; index++) {
      const value = block[index]! / 32768;
      this.sum += value * value;
      if (++this.filled === FRAME_SAMPLES) this.flush();
    }
  }

  private flush(): void {
    if (this.count === this.levels.length) {
      const grown = new Float32Array(this.levels.length * 2);
      grown.set(this.levels);
      this.levels = grown;
    }
    this.levels[this.count++] = 10 * Math.log10(this.sum / this.filled + 1e-12);
    this.sum = 0;
    this.filled = 0;
  }

  finish(): Float32Array {
    if (this.filled > 0) this.flush();
    return this.levels.slice(0, this.count);
  }
}

function percentile(sorted: Float32Array, fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))))]!;
}

export interface SpeechOptions {
  /** Pauses shorter than this don't split speech. */
  minPauseSeconds?: number;
  /** Sounds shorter than this aren't speech. */
  minSpeechSeconds?: number;
}

export interface SpeechAnalysis {
  floorDb: number;
  thresholdDb: number;
  /** Where the speech is, from its first loud frame to its last: no padding. */
  regions: TimeRange[];
}

/** The speech regions of an audio file, in seconds, from its frame levels. */
export function findSpeech(levels: Float32Array, options: SpeechOptions = {}): SpeechAnalysis {
  const minPause = Math.round((options.minPauseSeconds ?? 0.25) / FRAME_SECONDS);
  const minSpeech = Math.round((options.minSpeechSeconds ?? 0.1) / FRAME_SECONDS);

  const audible = levels.filter((level) => level > DIGITAL_SILENCE_DB).sort();
  if (audible.length < minSpeech) return { floorDb: DIGITAL_SILENCE_DB, thresholdDb: 0, regions: [] };
  const floor = percentile(audible, 0.1);
  const peak = percentile(audible, 0.95);
  if (peak - floor < MIN_DYNAMIC_RANGE_DB) return { floorDb: floor, thresholdDb: peak, regions: [] };
  const threshold = floor + Math.max(MIN_SNR_DB, (peak - floor) * 0.3);

  // Runs of loud frames, joined across pauses shorter than minPause.
  const runs: Array<[number, number]> = [];
  let start = -1;
  let lastLoud = -1;
  for (let frame = 0; frame < levels.length; frame++) {
    if (levels[frame]! < threshold) continue;
    if (start >= 0 && frame - lastLoud - 1 >= minPause) {
      runs.push([start, lastLoud + 1]);
      start = -1;
    }
    if (start < 0) start = frame;
    lastLoud = frame;
  }
  if (start >= 0) runs.push([start, lastLoud + 1]);
  const regions = runs
    .filter(([first, end]) => end - first >= minSpeech)
    .map(([first, end]) => ({ start: first * FRAME_SECONDS, end: end * FRAME_SECONDS }));
  return { floorDb: floor, thresholdDb: threshold, regions };
}

export interface AudioChunk extends TimeRange {
  /** The speech regions inside the chunk, in seconds from the start of the file. */
  regions: TimeRange[];
}

export interface ChunkOptions {
  /** The longest audio one model request gets, padding included. */
  maxChunkSeconds?: number;
  /** A pause longer than this ends a chunk; the silence isn't sent. */
  maxPauseInChunkSeconds?: number;
  /** A chunk with less speech than this (a click, a breath) isn't sent. */
  minChunkSpeechSeconds?: number;
  /** Audio sent before a chunk's first speech and after its last, for soft onsets and endings. */
  padBeforeSeconds?: number;
  padAfterSeconds?: number;
}

/**
 * Bedrock's Voxtral models pad audio to whole 30-second windows (375 input
 * tokens each), so a chunk of just under 60 seconds uses two windows fully.
 */
export const MAX_CHUNK_SECONDS = 59.5;

/** The quietest 100 ms between `from` and `to` seconds: where to cut speech that has no pause. */
function quietestPoint(levels: Float32Array, from: number, to: number): number {
  const window = 10;
  const first = Math.floor(from / FRAME_SECONDS);
  const last = Math.min(levels.length - window, Math.floor(to / FRAME_SECONDS));
  let best = first;
  let bestLevel = Number.POSITIVE_INFINITY;
  for (let frame = first; frame <= last; frame++) {
    let sum = 0;
    for (let offset = 0; offset < window; offset++) sum += levels[frame + offset]!;
    if (sum < bestLevel) { bestLevel = sum; best = frame; }
  }
  return (best + window / 2) * FRAME_SECONDS;
}

/**
 * Group speech regions into chunks: each chunk spans at most `maxChunkSeconds`
 * with its padding, and ends at a pause longer than `maxPauseInChunkSeconds`.
 * Speech that runs longer than a chunk without a pause is cut at its quietest
 * point near the end of the chunk. Chunks never overlap.
 */
export function planChunks(regions: readonly TimeRange[], levels: Float32Array, options: ChunkOptions = {}): AudioChunk[] {
  const maxChunk = options.maxChunkSeconds ?? MAX_CHUNK_SECONDS;
  const maxPause = options.maxPauseInChunkSeconds ?? 2;
  const minSpeech = options.minChunkSpeechSeconds ?? 0.3;
  const padBefore = options.padBeforeSeconds ?? 0.2;
  const padAfter = options.padAfterSeconds ?? 0.3;
  const duration = levels.length * FRAME_SECONDS;
  const maxSpeechSpan = maxChunk - padBefore - padAfter;

  const pieces: TimeRange[] = [];
  for (const region of regions) {
    let start = region.start;
    while (region.end - start > maxSpeechSpan) {
      const cut = quietestPoint(levels, start + maxSpeechSpan * 0.75, start + maxSpeechSpan - 0.1);
      pieces.push({ start, end: cut });
      start = cut;
    }
    pieces.push({ start, end: region.end });
  }

  const groups: TimeRange[][] = [];
  for (const piece of pieces) {
    const group = groups.at(-1);
    const last = group?.at(-1);
    if (group && last && piece.start - last.end <= maxPause && piece.end - group[0]!.start <= maxSpeechSpan) group.push(piece);
    else groups.push([piece]);
  }

  const chunks: AudioChunk[] = [];
  for (const group of groups) {
    const speech = group.reduce((total, region) => total + region.end - region.start, 0);
    if (speech < minSpeech) continue;
    const first = group[0]!;
    const last = group.at(-1)!;
    const previous = chunks.at(-1);
    // Padding stops halfway into the pause before, so neighboring chunks never share audio.
    const floor = previous ? (previous.regions.at(-1)!.end + first.start) / 2 : 0;
    const start = Math.max(floor, first.start - padBefore, 0);
    if (previous && previous.end > start) previous.end = start;
    chunks.push({ start, end: Math.min(duration, last.end + padAfter), regions: group.map((region) => ({ ...region })) });
  }
  return chunks;
}

/**
 * The samples of each chunk, in order, from one decoding pass. Only the chunk
 * being filled is held in memory.
 */
export async function* cutChunks(blocks: AsyncIterable<Int16Array>, chunks: readonly AudioChunk[]): AsyncGenerator<{ index: number; chunk: AudioChunk; samples: Int16Array }> {
  let index = 0;
  let position = 0;
  let buffer: Int16Array | undefined;
  let filled = 0;
  const bounds = (chunk: AudioChunk) => [Math.round(chunk.start * SAMPLE_RATE), Math.round(chunk.end * SAMPLE_RATE)] as const;
  for await (const block of blocks) {
    let offset = 0;
    while (index < chunks.length && offset < block.length) {
      const chunk = chunks[index]!;
      const [first, end] = bounds(chunk);
      const blockPosition = position + offset;
      if (blockPosition + (block.length - offset) <= first) break;
      const from = Math.max(offset, first - position);
      const to = Math.min(block.length, end - position);
      buffer ??= new Int16Array(end - first);
      if (to > from) {
        buffer.set(block.subarray(from, to), filled);
        filled += to - from;
      }
      offset = Math.max(offset, to);
      if (position + offset >= end) {
        yield { index, chunk, samples: buffer.subarray(0, filled) };
        index++;
        buffer = undefined;
        filled = 0;
      } else {
        break;
      }
    }
    position += block.length;
    if (index >= chunks.length) break;
  }
  // A file that ended inside the last chunk (its decoded length fell short of the plan).
  if (index < chunks.length && buffer && filled > 0) yield { index, chunk: chunks[index]!, samples: buffer.subarray(0, filled) };
}
