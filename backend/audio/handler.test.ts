import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ConverseCommandInput } from "@aws-sdk/client-bedrock-runtime";
import { resolveModelCatalog, type ModelCatalog } from "../model-routing";
import { encodeWav, SAMPLE_RATE } from "./pcm";

// Authentication, the catalog, billing and Bedrock are replaced; the audio pipeline is real.
let modelRow: Record<string, unknown>;
let admission: { ok: true } | { ok: false; code: string; message: string } = { ok: true };
let auth: { ok: true; principal: Record<string, unknown> } | { ok: false; status: 401 | 403; message: string; code: string };
let settlements: Array<Record<string, unknown>> = [];
let settlementFails = false;
let sent: ConverseCommandInput[] = [];
/** Answers Bedrock gives, by request; a function gets the request and its index. */
let answer: (input: ConverseCommandInput, index: number) => { text?: string; stopReason?: string; usage?: { inputTokens: number; outputTokens: number }; error?: Error };

mock.module("../model-catalog", () => ({
  listAvailableModels: async () => resolveModelCatalog({ models: [modelRow], aliases: [], apps: [] } as unknown as ModelCatalog),
  resolveModel: async (id: string) => resolveModelCatalog({ models: [modelRow], aliases: [], apps: [] } as unknown as ModelCatalog).find((entry) => entry.modelId === id),
}));
mock.module("../proxy-auth", () => ({
  authenticateApiKeyPrincipal: async () => auth,
  requireProxyScope: (result: typeof auth) => result,
}));
mock.module("../credit-service", () => ({
  checkCreditAdmission: async () => admission,
  calculateCostBreakdown: (params: { inputTokens: number; outputTokens: number; inputPricePerMTok: number; outputPricePerMTok: number }) => {
    const inputCost = (params.inputTokens * params.inputPricePerMTok) / 1e6;
    const outputCost = (params.outputTokens * params.outputPricePerMTok) / 1e6;
    return { total: inputCost + outputCost, inputCost, outputCost, cacheReadCost: 0, cacheWrite5mCost: 0, cacheWrite1hCost: 0 };
  },
  deductCredits: async (input: Record<string, unknown>) => {
    settlements.push(input);
    if (settlementFails) throw new Error("ledger unavailable");
    return { actualCost: input.amount, creditsCharged: input.amount, balanceAfter: 9.5, partiallyCharged: false };
  },
}));
mock.module("../bedrock", () => ({
  ProviderNotConfiguredError: class ProviderNotConfiguredError extends Error {},
  getBedrockClient: async () => ({
    async send(command: { input: ConverseCommandInput }) {
      const index = sent.length;
      sent.push(command.input);
      const reply = answer(command.input, index);
      if (reply.error) throw reply.error;
      return {
        output: { message: { role: "assistant", content: [{ text: reply.text ?? "" }] } },
        stopReason: reply.stopReason ?? "end_turn",
        usage: reply.usage ?? { inputTokens: 766, outputTokens: 40 },
      };
    },
  }),
}));

const { handleAudio, MAX_FILE_BYTES } = await import("./handler");

/** Seeded speech-like sound (noise rising and falling like syllables), between quiet stretches. */
function speechWav(pattern: Array<["speech" | "pause", number]>): Uint8Array<ArrayBuffer> {
  let state = 7;
  const next = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
  const samples: number[] = [];
  for (const [kind, seconds] of pattern) {
    for (let i = 0; i < Math.round(seconds * SAMPLE_RATE); i++) {
      const loudness = kind === "speech" ? 8000 * (0.55 + 0.45 * Math.sin((2 * Math.PI * 4 * i) / SAMPLE_RATE)) : 40;
      samples.push((next() * 2 - 1) * loudness);
    }
  }
  return encodeWav(Int16Array.from(samples));
}

const twoSentences = speechWav([["pause", 0.5], ["speech", 2], ["pause", 0.8], ["speech", 3], ["pause", 0.5]]);

function form(fields: Record<string, string | Blob | undefined>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (value instanceof Blob) data.set(name, value, "audio.wav");
    else data.set(name, value);
  }
  return data;
}

function call(endpoint: "transcriptions" | "subtitles", fields: Record<string, string | Blob | undefined>, headers: Record<string, string> = {}) {
  return handleAudio(new Request(`https://gateway.test/v1/audio/${endpoint}`, { method: "POST", body: form(fields), headers }), endpoint);
}

const file = new Blob([twoSentences], { type: "audio/wav" });

beforeEach(() => {
  modelRow = {
    id: "model-1", name: "Voxtral Mini", createdAt: new Date(0), modelId: "mistral.voxtral-mini-3b-2507", inputPricePerMTok: 0.04, outputPricePerMTok: 0.04,
    cacheReadPricePerMTok: null, cacheWrite5mPricePerMTok: null, cacheWrite1hPricePerMTok: null, managedCache: false, region: "eu-west-1",
    maxOutputTokens: 4096, thinking: false, reasoningMode: "auto", defaultReasoningEffort: null, enabled: true, provider: "bedrock",
  };
  admission = { ok: true };
  auth = { ok: true, principal: { userId: "user-1234567890", credentialType: "api_key", credentialId: "key-1", scopes: new Set(["ai.invoke"]) } };
  settlements = [];
  settlementFails = false;
  sent = [];
  answer = (input) => {
    const instruction = input.messages![0]!.content![1]!.text!;
    return instruction.includes("segment timestamps")
      ? { text: "[ 0m0s300ms - 0m2s400ms ] First sentence here.\n[ 0m3s200ms - 0m6s300ms ] And the second, longer sentence." }
      : { text: "First sentence here. And the second, longer sentence." };
  };
});

describe("transcriptions", () => {
  test("return OpenAI's JSON with the gateway's settled usage, charged once under the request ID", async () => {
    const response = await call("transcriptions", { file, model: "mistral.voxtral-mini-3b-2507" }, { "x-request-id": "audio-test-1" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      text: "First sentence here. And the second, longer sentence.",
      usage: {
        type: "tokens", input_tokens: 766, output_tokens: 40, total_tokens: 806, seconds: 6.8, cost: expect.closeTo(0.00003224, 12),
        cost_details: {
          currency: "USD", status: "settled", calculated_cost: expect.closeTo(0.00003224, 12),
          input_cost: expect.closeTo(0.00003064, 12), output_cost: expect.closeTo(0.0000016, 12), partially_charged: false,
        },
      },
    });
    expect(response.headers.get("x-request-id")).toBe("audio-test-1");
    expect(response.headers.get("x-usage-cost")).toBe("0.00003224");
    expect(response.headers.get("x-usage-cost-status")).toBe("settled");
    expect(settlements).toEqual([expect.objectContaining({
      userId: "user-1234567890", requestId: "audio-test-1", apiKeyId: "key-1", source: "api", type: "api",
      modelId: "mistral.voxtral-mini-3b-2507", inputTokens: 766, outputTokens: 40, description: "Audio transcription using mistral.voxtral-mini-3b-2507",
    })]);
    // One request with the speech as WAV and the plain instruction.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.modelId).toBe("mistral.voxtral-mini-3b-2507");
    expect(sent[0]!.messages![0]!.content![0]!.audio!.format).toBe("wav");
    expect(sent[0]!.messages![0]!.content![1]!.text).toBe("Transcribe this audio verbatim.");
    expect(sent[0]!.inferenceConfig!.temperature).toBe(0);
  });

  test("return text, timed verbose_json, SRT and WebVTT", async () => {
    const text = await call("transcriptions", { file, model: "mistral.voxtral-mini-3b-2507", response_format: "text" });
    expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await text.text()).toBe("First sentence here. And the second, longer sentence.");

    const verbose = await (await call("transcriptions", { file, model: "mistral.voxtral-mini-3b-2507", response_format: "verbose_json", language: "en", temperature: "0.2" })).json();
    expect(verbose).toMatchObject({ task: "transcribe", language: "english", duration: 6.8, text: "First sentence here. And the second, longer sentence." });
    expect(verbose.segments.map((segment: { start: number; end: number; text: string }) => [segment.text, Math.abs(segment.start - [0.5, 3.3][verbose.segments.indexOf(segment)]!) < 0.15])).toEqual([
      ["First sentence here.", true],
      ["And the second, longer sentence.", true],
    ]);
    expect(verbose.segments[0]).toMatchObject({ id: 0, seek: 0, tokens: [], temperature: 0.2, avg_logprob: 0, compression_ratio: 0, no_speech_prob: 0 });
    expect(sent.at(-1)!.messages![0]!.content![1]!.text).toBe("Transcribe this audio with segment timestamps. The speech is in English.");

    const srt = await call("transcriptions", { file, model: "mistral.voxtral-mini-3b-2507", response_format: "srt" });
    expect(srt.headers.get("content-type")).toBe("application/x-subrip; charset=utf-8");
    expect(await srt.text()).toMatch(/^1\n00:00:00,\d{3} --> 00:00:0\d,\d{3}\nFirst sentence here\.\n\n2\n00:00:0\d,\d{3} --> 00:00:0\d,\d{3}\nAnd the second, longer sentence\.\n$/);
    const vtt = await call("transcriptions", { file, model: "mistral.voxtral-mini-3b-2507", response_format: "vtt" });
    expect(vtt.headers.get("content-type")).toBe("text/vtt; charset=utf-8");
    expect(await vtt.text()).toStartWith("WEBVTT\n\n00:00:00.");
  });

  test("send nothing to the model for audio without speech, and charge nothing", async () => {
    const silence = new Blob([encodeWav(new Int16Array(SAMPLE_RATE * 3))]);
    const body = await (await call("transcriptions", { file: silence, model: "mistral.voxtral-mini-3b-2507", response_format: "verbose_json" })).json();
    expect(body).toMatchObject({ text: "", segments: [], language: "unknown", duration: 3, usage: { input_tokens: 0, cost: 0, cost_details: { status: "settled", calculated_cost: 0 } } });
    expect(sent).toHaveLength(0);
    expect(settlements).toHaveLength(0);
  });

  test("still answer when the ledger fails, with cost status failed", async () => {
    settlementFails = true;
    const response = await call("transcriptions", { file, model: "mistral.voxtral-mini-3b-2507" });
    expect(response.status).toBe(200);
    expect((await response.json()).usage).toEqual({ type: "tokens", input_tokens: 766, output_tokens: 40, total_tokens: 806, seconds: 6.8, cost_details: { currency: "USD", status: "failed" } });
    expect(response.headers.get("x-usage-cost-status")).toBe("failed");
    expect(response.headers.get("x-usage-cost")).toBeNull();
  });
});

describe("subtitles", () => {
  test("default to SRT with the lines asked for, and return JSON cues", async () => {
    answer = () => ({ text: "[ 0m0s300ms - 0m2s400ms ] A first sentence that is long enough to wrap.\n[ 0m3s200ms - 0m6s300ms ] The second one." });
    const srt = await call("subtitles", { file, model: "mistral.voxtral-mini-3b-2507", max_line_length: "24" });
    expect(srt.headers.get("content-type")).toBe("application/x-subrip; charset=utf-8");
    const cues = (await srt.text()).split("\n\n").filter(Boolean);
    expect(cues[0]!.split("\n").slice(2)).toEqual(["A first sentence that", "is long enough to wrap."]);
    expect(settlements[0]!.description).toBe("Subtitles using mistral.voxtral-mini-3b-2507");

    const json = await (await call("subtitles", { file, model: "mistral.voxtral-mini-3b-2507", response_format: "json", max_lines: "1", max_line_length: "60" })).json();
    expect(json.cues.map((cue: { lines: string[] }) => cue.lines)).toEqual([["A first sentence that is long enough to wrap."], ["The second one."]]);
    expect(json.cues[0].text).toBe("A first sentence that is long enough to wrap.");
    expect(json).toMatchObject({ language: "english", duration: 6.8, usage: { type: "tokens", cost_details: { status: "settled" } } });
  });

  test("check their line options", async () => {
    for (const [name, value] of [["max_line_length", "8"], ["max_line_length", "abc"], ["max_lines", "5"], ["max_lines", "1.5"]] as const) {
      const response = await call("subtitles", { file, model: "mistral.voxtral-mini-3b-2507", [name]: value });
      expect(response.status).toBe(400);
      expect((await response.json()).error.param).toBe(name);
    }
    const format = await call("subtitles", { file, model: "mistral.voxtral-mini-3b-2507", response_format: "verbose_json" });
    expect((await format.json()).error).toMatchObject({ code: "invalid_request", param: "response_format", message: "response_format must be one of srt, vtt, json" });
  });
});

describe("requests the gateway refuses", () => {
  test.each([
    ["no file", { model: "mistral.voxtral-mini-3b-2507" }, 400, "missing_required_parameter", "file"],
    ["no model", { file }, 400, "missing_required_parameter", "model"],
    ["an empty file", { file: new Blob([]), model: "x" }, 400, "invalid_request", "file"],
    ["an unknown format", { file, model: "mistral.voxtral-mini-3b-2507", response_format: "xml" }, 400, "invalid_request", "response_format"],
    ["a bad language", { file, model: "mistral.voxtral-mini-3b-2507", language: "klingon" }, 400, "invalid_language", "language"],
    ["a temperature over 1", { file, model: "mistral.voxtral-mini-3b-2507", temperature: "1.5" }, 400, "invalid_request", "temperature"],
    ["word timestamps", { file, model: "mistral.voxtral-mini-3b-2507", "timestamp_granularities[]": "word" }, 400, "unsupported_value", "timestamp_granularities[]"],
    ["streaming", { file, model: "mistral.voxtral-mini-3b-2507", stream: "true" }, 400, "unsupported_parameter", "stream"],
    ["a model not in the catalog", { file, model: "whisper-1" }, 400, "model_not_available", "model"],
    ["a file that isn't audio", { file: new Blob(["%PDF-1.7"]), model: "mistral.voxtral-mini-3b-2507" }, 400, "unsupported_audio_format", "file"],
  ] as const)("%s", async (_, fields, status, code, param) => {
    const response = await call("transcriptions", fields as Record<string, string | Blob>);
    expect(response.status).toBe(status);
    expect((await response.json()).error).toMatchObject({ type: "invalid_request_error", code, param });
    expect(sent).toHaveLength(0);
    expect(settlements).toHaveLength(0);
  });

  test("a body that isn't multipart, and a file over 25 MB", async () => {
    const json = await handleAudio(new Request("https://gateway.test/v1/audio/transcriptions", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), "transcriptions");
    expect((await json.json()).error).toMatchObject({ code: "invalid_content_type" });
    const large = await call("transcriptions", { file: new Blob([new Uint8Array(MAX_FILE_BYTES + 1)]), model: "mistral.voxtral-mini-3b-2507" });
    expect(large.status).toBe(413);
    expect((await large.json()).error).toMatchObject({ code: "file_too_large", param: "file" });
  });

  test("without credits, a key, or its scope", async () => {
    admission = { ok: false, code: "insufficient_credits", message: "Insufficient credit balance" };
    const broke = await call("transcriptions", { file, model: "mistral.voxtral-mini-3b-2507" });
    expect(broke.status).toBe(402);
    expect((await broke.json()).error).toEqual({ message: "Insufficient credit balance", type: "invalid_request_error", code: "insufficient_credits" });
    auth = { ok: false, status: 403, message: "Missing required scope: ai.invoke", code: "insufficient_scope" };
    const scope = await call("transcriptions", { file, model: "mistral.voxtral-mini-3b-2507" });
    expect(scope.status).toBe(403);
    expect((await scope.json()).error).toMatchObject({ type: "permission_error", code: "insufficient_scope" });
    expect(sent).toHaveLength(0);
  });
});

describe("Bedrock failures", () => {
  test("keep Bedrock's message, as chat completions do", async () => {
    answer = () => ({ error: Object.assign(new Error("This model doesn't support the audio format that you provided"), { name: "ValidationException", $fault: "client", $metadata: { httpStatusCode: 400 } }) });
    const response = await call("transcriptions", { file, model: "mistral.voxtral-mini-3b-2507" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toEqual({ message: "This model doesn't support the audio format that you provided", type: "invalid_request_error", code: "invalid_request" });
    expect(settlements).toHaveLength(0);
  });

  test("charge the chunks the model answered before one failed", async () => {
    // Two chunks: a pause longer than two seconds ends the first.
    const twoChunks = new Blob([speechWav([["speech", 2], ["pause", 3], ["speech", 2], ["pause", 0.2]])]);
    answer = (_, index) => (index === 0
      ? { text: "Answered.", usage: { inputTokens: 391, outputTokens: 4 } }
      : { error: Object.assign(new Error("Too many requests"), { name: "ThrottlingException", $fault: "client", $metadata: { httpStatusCode: 429 } }) });
    const response = await call("transcriptions", { file: twoChunks, model: "mistral.voxtral-mini-3b-2507" }, { "x-request-id": "partial-1" });
    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe("rate_limit_exceeded");
    expect(sent).toHaveLength(2);
    expect(settlements).toEqual([expect.objectContaining({ requestId: "partial-1", inputTokens: 391, outputTokens: 4 })]);
    // The failed request tells the client what it was charged, under which ID.
    expect(response.headers.get("x-request-id")).toBe("partial-1");
    expect(response.headers.get("x-usage-input-tokens")).toBe("391");
    expect(response.headers.get("x-usage-cost")).toBe("0.00001580".replace(/0+$/, ""));
  });

  test("name the generated request ID on failures that cost nothing", async () => {
    answer = () => ({ error: Object.assign(new Error("Access denied"), { name: "AccessDeniedException", $fault: "client", $metadata: { httpStatusCode: 403 } }) });
    const response = await call("transcriptions", { file, model: "mistral.voxtral-mini-3b-2507" });
    expect(response.status).toBe(403);
    expect(response.headers.get("x-request-id")).toMatch(/^audio-[0-9a-f-]{36}$/);
    expect(response.headers.get("x-usage-cost")).toBeNull();
  });
});
