import { describe, expect, test } from "bun:test";
import type { BedrockRuntimeClient, ConverseCommandInput } from "@aws-sdk/client-bedrock-runtime";
import type { AudioChunk } from "./speech";
import {
  ChunkRequestError,
  ChunkTranscriptionError,
  cleanTranscript,
  maxTokensFor,
  parseSegments,
  readTranscript,
  timestampSeconds,
  transcribeChunk,
  transcribeChunks,
  transcriptionInstruction,
  trimRepetition,
  usableSegments,
  type ChunkTranscript,
} from "./transcribe";

describe("instructions", () => {
  test("are short, name the language, and carry the client's context", () => {
    expect(transcriptionInstruction({ timed: false })).toBe("Transcribe this audio verbatim.");
    expect(transcriptionInstruction({ timed: true })).toBe("Transcribe this audio with segment timestamps.");
    expect(transcriptionInstruction({ timed: true, language: "sv" })).toBe("Transcribe this audio with segment timestamps. The speech is in Swedish.");
    expect(transcriptionInstruction({ timed: false, language: "de", prompt: "Kubernetes, Ingress" }))
      .toBe("Transcribe this audio verbatim. The speech is in German.\nContext, and spelling of names and terms: Kubernetes, Ingress");
  });

  test("allow far more output than speech needs, within the model's limit", () => {
    expect(maxTokensFor(60, 32000, false)).toBe(784);
    expect(maxTokensFor(60, 32000, true)).toBe(1024);
    expect(maxTokensFor(60, 500, true)).toBe(500);
    expect(maxTokensFor(0.2, 32000, false)).toBe(67);
  });
});

describe("model answers", () => {
  test("Voxtral timestamps read their millisecond digits as a fraction", () => {
    expect(timestampSeconds("0m3s240ms")).toBeCloseTo(3.24);
    expect(timestampSeconds("0m2s94ms")).toBeCloseTo(2.94);
    expect(timestampSeconds("0m1s7ms")).toBeCloseTo(1.7);
    expect(timestampSeconds("1m5s0ms")).toBeCloseTo(65);
    expect(timestampSeconds("1h0m0s5ms")).toBeCloseTo(3600.5);
    expect(timestampSeconds("3.2")).toBeUndefined();
  });

  test("segments are split at the timestamps, and text without them is one segment", () => {
    const parsed = parseSegments("[ 0m0s110ms - 0m2s100ms ] Welcome to the update.\n[ 0m3s100ms - 0m5s600ms ] Today we talk.\n[ 0m6s300ms ] Then more.");
    expect(parsed.segments).toEqual([
      { start: 0.11, end: 2.1, text: "Welcome to the update." },
      { start: 3.1, end: 5.6, text: "Today we talk." },
      { start: 6.3, end: undefined, text: "Then more." },
    ]);
    expect(parsed.text).toBe("Welcome to the update. Today we talk. Then more.");
    expect(parseSegments("Just text.")).toEqual({ segments: [{ text: "Just text." }], text: "Just text." });
  });

  test("timestamps that don't fit the chunk are dropped, and too few left means none", () => {
    const segments = [
      { start: 0.1, end: 2, text: "a" },
      { start: 13.3, end: 4.3, text: "b" }, // ends before it starts
      { start: 5, end: 99, text: "c" }, // ends past the chunk
      { start: 2.5, end: 3, text: "d" }, // starts before the one before it
    ];
    expect(usableSegments(segments, 30)).toEqual([
      { start: 0.1, end: 2, text: "a" },
      { start: 13.3, end: undefined, text: "b" },
      { start: undefined, end: undefined, text: "c" },
      { start: undefined, end: undefined, text: "d" },
    ]);
    expect(usableSegments([{ text: "a" }, { text: "b" }, { start: 1, text: "c" }], 30)).toBeUndefined();
  });

  test("repetition loops are cut off, ordinary repeats kept", () => {
    const loop = `Welcome. ${"And I think it's a great opportunity for us. ".repeat(40)}And I think`;
    expect(trimRepetition(loop)).toBe("Welcome. And I think it's a great opportunity for us.");
    expect(trimRepetition("no no no, I said thank you, thank you, thank you.", 4, 4)).toBe("no no no, I said thank you, thank you, thank you.");
    expect(trimRepetition("one two three four one two three four one two three four one two three four end", 4, 4)).toBe("one two three four");
  });

  test("quotes and labels around the transcript are removed", () => {
    expect(cleanTranscript("\"Hello there, she said.\"")).toBe("Hello there, she said.");
    expect(cleanTranscript("Transcription: Hello.")).toBe("Hello.");
    expect(cleanTranscript("\"Yes,\" he said, \"no.\"")).toBe("\"Yes,\" he said, \"no.\"");
    expect(cleanTranscript("  a  \n\n  b ")).toBe("a\nb");
  });

  test("a looping timed answer keeps one copy of each segment", () => {
    const answer = `[ 0m0s100ms - 0m2s0ms ] Hello.\n${"[ 0m2s0ms - 0m3s0ms ] Thank you.\n".repeat(5)}`;
    const read = readTranscript(answer, 10, true, true);
    expect(read.text).toBe("Hello. Thank you.");
    expect(read.segments?.map((segment) => segment.text)).toEqual(["Hello.", "Thank you."]);
    // Text formats get no segments, and their markers are stripped.
    expect(readTranscript("[ 0m0s100ms - 0m2s0ms ] Hello.", 10, false, false)).toEqual({ text: "Hello.", segments: undefined });
  });
});

const chunk: AudioChunk = { start: 10, end: 20, regions: [{ start: 10.2, end: 19.7 }] };
const item = { index: 0, chunk, samples: new Int16Array(16000 * 10) };
const settings = { modelId: "mistral.voxtral-mini-3b-2507", temperature: 0, maxOutputTokens: 4096, timed: true };

function fakeClient(answers: Array<{ text?: string; stopReason?: string; inputTokens?: number; outputTokens?: number; error?: Error }>) {
  const sent: ConverseCommandInput[] = [];
  const client = {
    async send(command: { input: ConverseCommandInput }) {
      sent.push(command.input);
      const answer = answers.shift()!;
      if (answer.error) throw answer.error;
      return {
        output: { message: { role: "assistant", content: [{ text: answer.text ?? "" }] } },
        stopReason: answer.stopReason ?? "end_turn",
        usage: { inputTokens: answer.inputTokens ?? 391, outputTokens: answer.outputTokens ?? 20 },
      };
    },
  } as unknown as BedrockRuntimeClient;
  return { client, sent };
}

describe("one chunk", () => {
  test("is sent as a WAV audio block with the instruction, and its timestamps kept", async () => {
    const { client, sent } = fakeClient([{ text: "[ 0m0s200ms - 0m4s0ms ] First part.\n[ 0m4s500ms - 0m9s0ms ] Second part." }]);
    const result = await transcribeChunk(client, settings, item);
    expect(result).toMatchObject({ text: "First part. Second part.", inputTokens: 391, outputTokens: 20, truncated: false });
    expect(result.segments).toEqual([{ start: 0.2, end: 4, text: "First part." }, { start: 4.5, end: 9, text: "Second part." }]);
    const content = sent[0]!.messages![0]!.content!;
    expect(content[0]!.audio?.format).toBe("wav");
    const bytes = content[0]!.audio?.source?.bytes as Uint8Array;
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("RIFF");
    expect(bytes.length).toBe(44 + 16000 * 10 * 2);
    expect(content[1]!.text).toBe("Transcribe this audio with segment timestamps.");
    expect(sent[0]!.inferenceConfig).toEqual({ maxTokens: 224, temperature: 0 });
  });

  test("that loops is asked again at a higher temperature, and both answers are counted", async () => {
    const { client, sent } = fakeClient([
      { text: "Hello. Hello. Hello. Hello. Hello. Hello.", stopReason: "max_tokens", outputTokens: 224 },
      { text: "Hello and welcome.", outputTokens: 5 },
    ]);
    const result = await transcribeChunk(client, { ...settings, timed: false }, item);
    expect(sent.map((input) => input.inferenceConfig?.temperature)).toEqual([0, 0.5]);
    expect(result).toMatchObject({ text: "Hello and welcome.", inputTokens: 782, outputTokens: 229, truncated: false });
  });

  test("keeps the first answer, loop cut off, when the second fails", async () => {
    const { client } = fakeClient([
      { text: "Yes. I agree with you. I agree with you. I agree with you. I agree with you.", stopReason: "max_tokens" },
      { error: Object.assign(new Error("Too many requests"), { name: "ThrottlingException" }) },
    ]);
    const result = await transcribeChunk(client, { ...settings, timed: false }, item);
    expect(result).toMatchObject({ text: "Yes. I agree with you.", truncated: true, inputTokens: 391 });
  });

  test("that fails reports the error", async () => {
    const error = Object.assign(new Error("Model does not support audio"), { name: "ValidationException" });
    const { client } = fakeClient([{ error }]);
    const failure = await transcribeChunk(client, settings, item).catch((caught) => caught);
    expect(failure).toBeInstanceOf(ChunkRequestError);
    expect(failure.cause).toBe(error);
    expect(failure.inputTokens).toBe(0);
  });
});

describe("many chunks", () => {
  async function* source(count: number) {
    for (let index = 0; index < count; index++) yield { index, chunk, samples: new Int16Array(16) };
  }
  const transcript = (index: number, text = `chunk ${index}`): ChunkTranscript => ({ index, chunk, text, inputTokens: 100, outputTokens: 10, truncated: false });

  test("run a few at a time and come back in order, with their usage added up", async () => {
    let running = 0;
    let most = 0;
    const result = await transcribeChunks(source(10), async (next) => {
      running++;
      most = Math.max(most, running);
      await Bun.sleep(5 + (10 - next.index));
      running--;
      return transcript(next.index);
    }, { concurrency: 3 });
    expect(most).toBe(3);
    expect(result.transcripts.map((entry) => entry.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 100, requests: 10 });
  });

  test("stop at the first failure, cancel the rest, and report what the answered ones used", async () => {
    const signals: AbortSignal[] = [];
    const failure = await transcribeChunks(source(10), async (next, signal) => {
      signals.push(signal);
      if (next.index === 2) throw new ChunkRequestError(new Error("throttled"), 50, 0);
      await Bun.sleep(next.index < 2 ? 1 : 20);
      return transcript(next.index);
    }, { concurrency: 3 }).catch((caught) => caught);
    expect(failure).toBeInstanceOf(ChunkTranscriptionError);
    expect(failure.cause.message).toBe("throttled");
    expect(failure.usage.inputTokens).toBeGreaterThanOrEqual(250);
    expect(signals.at(-1)!.aborted).toBe(true);
  });

  test("stop when the client goes away", async () => {
    const controller = new AbortController();
    const failure = await transcribeChunks(source(10), async (next) => {
      if (next.index === 1) controller.abort(new Error("client left"));
      return transcript(next.index);
    }, { concurrency: 1, signal: controller.signal }).catch((caught) => caught);
    expect(failure).toBeInstanceOf(ChunkTranscriptionError);
    expect(failure.usage.requests).toBe(2);
  });
});
