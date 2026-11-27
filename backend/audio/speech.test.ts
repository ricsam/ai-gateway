import { describe, expect, test } from "bun:test";
import { SAMPLE_RATE } from "./pcm";
import { cutChunks, findSpeech, LevelMeter, MAX_CHUNK_SECONDS, planChunks, type AudioChunk } from "./speech";

/** Seeded noise, so the tests are repeatable. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

/** Speech-like sound: noise whose loudness rises and falls four times a second, like syllables. */
function speech(seconds: number, next: () => number, amplitude = 8000): number[] {
  return Array.from({ length: Math.round(seconds * SAMPLE_RATE) }, (_, i) => {
    const syllables = 0.55 + 0.45 * Math.sin((2 * Math.PI * 4 * i) / SAMPLE_RATE);
    return (next() * 2 - 1) * amplitude * syllables;
  });
}

function quiet(seconds: number, next: () => number, amplitude = 60): number[] {
  return Array.from({ length: Math.round(seconds * SAMPLE_RATE) }, () => (next() * 2 - 1) * amplitude);
}

function levelsOf(samples: Int16Array): Float32Array {
  const meter = new LevelMeter();
  meter.push(samples);
  return meter.finish();
}

describe("speech detection", () => {
  test("finds speech between pauses, without padding", () => {
    const next = random(1);
    const samples = Int16Array.from([...quiet(0.5, next), ...speech(2, next), ...quiet(0.6, next), ...speech(3, next), ...quiet(3, next), ...speech(1.5, next), ...quiet(0.5, next)]);
    const { regions } = findSpeech(levelsOf(samples));
    expect(regions).toHaveLength(3);
    const expected = [[0.5, 2.5], [3.1, 6.1], [9.1, 10.6]];
    regions.forEach((region, index) => {
      expect(region.start).toBeCloseTo(expected[index]![0]!, 0);
      expect(Math.abs(region.start - expected[index]![0]!)).toBeLessThan(0.15);
      expect(Math.abs(region.end - expected[index]![1]!)).toBeLessThan(0.15);
    });
  });

  test("finds none in digital silence, steady noise or a steady tone", () => {
    const next = random(2);
    expect(findSpeech(levelsOf(new Int16Array(SAMPLE_RATE * 5))).regions).toEqual([]);
    expect(findSpeech(levelsOf(Int16Array.from(quiet(5, next, 2000)))).regions).toEqual([]);
    const tone = Int16Array.from({ length: SAMPLE_RATE * 5 }, (_, i) => 8000 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE));
    expect(findSpeech(levelsOf(tone)).regions).toEqual([]);
  });

  test("measures 10 ms frames, the last one partial", () => {
    const meter = new LevelMeter();
    meter.push(new Int16Array(100).fill(16384));
    meter.push(new Int16Array(150).fill(16384));
    const levels = meter.finish();
    expect(levels).toHaveLength(2);
    expect(meter.samples).toBe(250);
    expect(levels[0]).toBeCloseTo(-6.02, 1);
    expect(levels[1]).toBeCloseTo(-6.02, 1);
  });
});

describe("chunk planning", () => {
  const levels = new Float32Array(2 * 60 * 60 * 100).fill(-40);

  test("groups speech into chunks of at most 59.5 seconds with padding, cut in pauses", () => {
    const regions = Array.from({ length: 40 }, (_, index) => ({ start: index * 4 + 1, end: index * 4 + 3.5 }));
    const chunks = planChunks(regions, levels);
    for (const chunk of chunks) {
      expect(chunk.end - chunk.start).toBeLessThanOrEqual(MAX_CHUNK_SECONDS + 1e-9);
      expect(chunk.start).toBeLessThanOrEqual(chunk.regions[0]!.start);
      expect(chunk.end).toBeGreaterThanOrEqual(chunk.regions.at(-1)!.end);
    }
    expect(chunks.flatMap((chunk) => chunk.regions)).toEqual(regions);
    // Padding stays out of the neighbor's audio.
    chunks.slice(1).forEach((chunk, index) => expect(chunk.start).toBeGreaterThanOrEqual(chunks[index]!.end));
    expect(chunks[0]).toMatchObject({ start: 0.8 });
  });

  test("ends a chunk at a long pause, and leaves out chunks with too little speech", () => {
    const chunks = planChunks([{ start: 1, end: 5 }, { start: 6, end: 9 }, { start: 12, end: 15 }, { start: 30, end: 30.1 }], levels);
    expect(chunks.map((chunk) => chunk.regions.length)).toEqual([2, 1]);
    expect(chunks[1]).toMatchObject({ start: 11.8, end: 15.3 });
  });

  test("cuts speech without pauses at its quietest point near the end of a chunk", () => {
    const quietLevels = new Float32Array(levels);
    quietLevels.fill(-70, 5000, 5010); // a quiet moment at 50 s
    const chunks = planChunks([{ start: 0, end: 130 }], quietLevels);
    expect(chunks.length).toBe(3);
    expect(chunks[0]!.regions[0]!.end).toBeCloseTo(50.05, 1);
    expect(chunks[1]!.regions[0]!.start).toBeCloseTo(50.05, 1);
    for (const chunk of chunks) expect(chunk.end - chunk.start).toBeLessThanOrEqual(MAX_CHUNK_SECONDS + 1e-9);
  });
});

test("cuts each chunk's samples from one decoding pass, across block boundaries", async () => {
  const samples = Int16Array.from({ length: SAMPLE_RATE * 10 }, (_, i) => i % 30000);
  const chunks: AudioChunk[] = [
    { start: 0.5, end: 2, regions: [] },
    { start: 2, end: 2.25, regions: [] },
    { start: 7.123, end: 10, regions: [] },
  ];
  async function* blocks() {
    for (let offset = 0; offset < samples.length; offset += 7777) yield samples.subarray(offset, offset + 7777);
  }
  const cut = [];
  for await (const item of cutChunks(blocks(), chunks)) cut.push(item);
  expect(cut.map((item) => item.index)).toEqual([0, 1, 2]);
  cut.forEach(({ chunk, samples: piece }) => {
    const first = Math.round(chunk.start * SAMPLE_RATE);
    expect(Array.from(piece)).toEqual(Array.from(samples.subarray(first, Math.round(chunk.end * SAMPLE_RATE))));
  });
});
