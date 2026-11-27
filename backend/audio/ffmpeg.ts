/**
 * Decodes uploads the gateway can't read itself with ffmpeg, to 16 kHz mono
 * 16-bit PCM. ffmpeg runs as a child process that reads the file from its
 * standard input and writes raw samples to its standard output:
 *
 * - The demuxer is named (`-f`) from the file's own bytes, so ffmpeg never
 *   probes for playlist or concatenation formats that open other files, and
 *   `-protocol_whitelist pipe` leaves it no protocol to open anything else.
 * - Only the first audio stream is decoded; video, subtitles and data are dropped.
 * - The process is killed when the request ends, when it produces no audio for
 *   too long while the gateway waits for it, or when the audio is longer than the
 *   gateway accepts.
 */
import { AudioInputError } from "./errors";
import { SAMPLE_RATE } from "./pcm";

let cachedPath: string | null | undefined;

/** The ffmpeg on PATH, or null when there is none. */
export function ffmpegPath(): string | null {
  if (cachedPath === undefined) cachedPath = Bun.which("ffmpeg") ?? null;
  return cachedPath;
}

/** Test seam: use another ffmpeg, or none (null). */
export function setFfmpegPathForTests(path: string | null | undefined): void {
  cachedPath = path;
}

export interface FfmpegDecodeOptions {
  /** Stop with audio_too_long once the audio passes this many seconds. */
  maxSeconds: number;
  signal?: AbortSignal;
  /** Kill ffmpeg when it produces no output for this long while its output is awaited. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const STDERR_LIMIT = 4_096;

/** Raised when ffmpeg can't read the upload; `detail` (ffmpeg's own words) is for the log only. */
export class FfmpegDecodeError extends AudioInputError {
  constructor(readonly detail: string) {
    super("The file could not be decoded as audio", "audio_decode_failed");
  }
}

/** Decode `input` with the named demuxer, yielding blocks of 16 kHz mono samples. */
export async function* ffmpegDecode(input: Uint8Array, demuxer: string, options: FfmpegDecodeOptions): AsyncGenerator<Int16Array> {
  const path = ffmpegPath();
  if (!path) throw new AudioInputError("This gateway reads only WAV audio: ffmpeg is not installed", "unsupported_audio_format");
  const maxSamples = Math.ceil(options.maxSeconds * SAMPLE_RATE);
  const child = Bun.spawn([
    path, "-hide_banner", "-nostats", "-loglevel", "error",
    "-protocol_whitelist", "pipe",
    "-f", demuxer, "-i", "pipe:0",
    "-map", "0:a:0", "-vn", "-sn", "-dn",
    "-ac", "1", "-ar", String(SAMPLE_RATE),
    // One second past the limit, so a file just over it is reported as too long.
    "-t", String(Math.ceil(options.maxSeconds) + 1),
    "-f", "s16le", "-c:a", "pcm_s16le", "pipe:1",
  ], { stdin: input, stdout: "pipe", stderr: "pipe" });

  let stopped: "timeout" | "aborted" | "too_long" | undefined;
  // SIGKILL: ffmpeg handles SIGTERM by finishing its output, and a consumer that
  // stopped reading leaves it blocked on a full pipe forever.
  const kill = () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); };
  const stop = (reason: NonNullable<typeof stopped>) => {
    stopped ??= reason;
    kill();
  };
  const onAbort = () => stop("aborted");
  if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener("abort", onAbort, { once: true });

  // Keep ffmpeg's messages for the log, bounded.
  let stderr = "";
  const stderrDone = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) {
      if (stderr.length < STDERR_LIMIT) stderr += decoder.decode(chunk, { stream: true });
    }
  })().catch(() => {});

  // The timeout counts only the time spent waiting for ffmpeg: between blocks the
  // consumer may take minutes (the second pass is cut as chunks are transcribed),
  // and ffmpeg waits for it then, its output pipe full.
  const reader = child.stdout.getReader();
  const read = async () => {
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try { return await reader.read(); } finally { clearTimeout(timer); }
  };
  let produced = 0;
  let carry: number | undefined;
  try {
    while (true) {
      const { done, value: chunk } = await read();
      if (done) break;
      let bytes: Uint8Array = chunk;
      if (carry !== undefined) {
        const joined = new Uint8Array(bytes.length + 1);
        joined[0] = carry;
        joined.set(bytes, 1);
        bytes = joined;
        carry = undefined;
      }
      if (bytes.length % 2 === 1) {
        carry = bytes[bytes.length - 1];
        bytes = bytes.subarray(0, bytes.length - 1);
      }
      if (bytes.length === 0) continue;
      // Copy into an aligned buffer: the pipe's chunks can start at odd offsets.
      const samples = new Int16Array(new Uint8Array(bytes).buffer);
      produced += samples.length;
      if (produced > maxSamples) {
        stop("too_long");
        break;
      }
      yield samples;
    }
    const exitCode = await child.exited;
    await stderrDone;
    if (stopped === "too_long") {
      throw new AudioInputError(`The audio is longer than ${formatLimit(options.maxSeconds)}`, "audio_too_long");
    }
    if (stopped === "aborted") throw options.signal?.reason ?? new Error("Request aborted");
    if (stopped === "timeout") throw new FfmpegDecodeError("ffmpeg produced no audio for too long");
    if (exitCode !== 0) throw new FfmpegDecodeError(stderr.trim() || `ffmpeg exited with ${exitCode}`);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    // A consumer that stops early (the last chunk was cut) ends ffmpeg here.
    kill();
    void reader.cancel().catch(() => {});
  }
}

export function formatLimit(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`;
  if (seconds % 60 === 0) return `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}
