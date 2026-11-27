import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAudio } from "./decode";
import { ffmpegDecode, ffmpegPath, setFfmpegPathForTests } from "./ffmpeg";
import { encodeWav, SAMPLE_RATE } from "./pcm";

// ffmpeg from PATH, or FFMPEG for a binary elsewhere; its tests are skipped without one.
const ffmpeg = process.env.FFMPEG ?? Bun.which("ffmpeg");
setFfmpegPathForTests(ffmpeg ?? null);
afterAll(() => setFfmpegPathForTests(undefined));

function tone(seconds: number): Int16Array {
  return Int16Array.from({ length: Math.round(seconds * SAMPLE_RATE) }, (_, i) => Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE)));
}

async function decodeAll(source: ReturnType<typeof openAudio>, signal?: AbortSignal): Promise<Int16Array> {
  const blocks: Int16Array[] = [];
  for await (const block of source.blocks(signal)) blocks.push(block);
  const out = new Int16Array(blocks.reduce((sum, block) => sum + block.length, 0));
  let offset = 0;
  for (const block of blocks) { out.set(block, offset); offset += block.length; }
  return out;
}

/** Encode WAV bytes into another format with ffmpeg. */
async function encode(wav: Uint8Array, args: string[]): Promise<Uint8Array> {
  const child = Bun.spawn([ffmpeg!, "-hide_banner", "-loglevel", "error", "-f", "wav", "-i", "pipe:0", ...args, "pipe:1"], { stdin: wav, stdout: "pipe", stderr: "pipe" });
  const bytes = new Uint8Array(await new Response(child.stdout).arrayBuffer());
  expect(await child.exited).toBe(0);
  return bytes;
}

describe("opening audio", () => {
  test("decodes PCM WAV itself, in blocks, and can decode it again", async () => {
    const source = openAudio(encodeWav(tone(2.5)), { maxSeconds: 60 });
    expect(source).toMatchObject({ container: "wav", decoder: "wav" });
    const first = await decodeAll(source);
    expect(first.length).toBe(40000);
    expect(Array.from((await decodeAll(source)).subarray(0, 50))).toEqual(Array.from(first.subarray(0, 50)));
  });

  test("refuses files that aren't audio, and audio that is too long", async () => {
    expect(() => openAudio(new TextEncoder().encode("%PDF-1.7 not audio"), { maxSeconds: 60 })).toThrow("not a supported audio or video format");
    await expect(decodeAll(openAudio(encodeWav(tone(3)), { maxSeconds: 2 }))).rejects.toMatchObject({ code: "audio_too_long", message: "The audio is longer than 2 seconds" });
  });

  test("without ffmpeg, reads only PCM WAV", () => {
    setFfmpegPathForTests(null);
    try {
      expect(() => openAudio(new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]), { maxSeconds: 60 })).toThrow("ffmpeg is not installed");
      expect(openAudio(encodeWav(tone(0.1)), { maxSeconds: 60 }).decoder).toBe("wav");
    } finally {
      setFfmpegPathForTests(ffmpeg ?? null);
    }
  });
});

describe.skipIf(!ffmpeg)("decoding with ffmpeg", () => {
  test("reads FLAC, and MP4 with its index at the end, from a pipe", async () => {
    const wav = encodeWav(tone(3));
    const flac = await encode(wav, ["-f", "flac"]);
    const flacSource = openAudio(flac, { maxSeconds: 60 });
    expect(flacSource).toMatchObject({ container: "flac", decoder: "ffmpeg" });
    expect(await decodeAll(flacSource)).toHaveLength(48000);

    // Phones write the index after the media; ffmpeg does too when it can seek its output file.
    const directory = await mkdtemp(join(tmpdir(), "aigw-audio-test-"));
    try {
      await Bun.write(join(directory, "in.wav"), wav);
      const child = Bun.spawn([ffmpeg!, "-hide_banner", "-loglevel", "error", "-i", join(directory, "in.wav"), "-c:a", "aac", join(directory, "out.m4a")], { stdout: "ignore", stderr: "pipe" });
      expect(await child.exited).toBe(0);
      const m4a = new Uint8Array(await Bun.file(join(directory, "out.m4a")).arrayBuffer());
      const text = new TextDecoder("latin1").decode(m4a);
      expect(text.indexOf("moov")).toBeGreaterThan(text.indexOf("mdat"));
      const mp4Source = openAudio(m4a, { maxSeconds: 60 });
      expect(mp4Source.container).toBe("mp4");
      expect(Math.abs((await decodeAll(mp4Source)).length - 48000)).toBeLessThan(2048);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    expect(ffmpegPath()).toBe(ffmpeg!);
  });

  test("reports files it can't decode, audio that is too long, and stops when asked", async () => {
    const broken = new Uint8Array(2048).fill(0x55);
    broken.set([0xff, 0xfb, 0x90, 0x64]);
    await expect(decodeAll(openAudio(broken, { maxSeconds: 60 }))).rejects.toMatchObject({ code: "audio_decode_failed" });
    const flac = await encode(encodeWav(tone(4)), ["-f", "flac"]);
    await expect(decodeAll(openAudio(flac, { maxSeconds: 2 }))).rejects.toMatchObject({ code: "audio_too_long" });
    const controller = new AbortController();
    controller.abort(new Error("client left"));
    await expect(decodeAll(openAudio(flac, { maxSeconds: 60 }), controller.signal)).rejects.toThrow("client left");
  });

  test("leaves no ffmpeg running when the reader stops early", async () => {
    // 30 seconds of output is more than a pipe holds, so ffmpeg is still writing when the reader stops.
    const flac = await encode(encodeWav(tone(30)), ["-f", "flac"]);
    // A limit no other ffmpeg has, to find this one by its arguments ("-t <limit + 1>").
    const limit = 5000 + Math.floor(Math.random() * 4000);
    for await (const block of ffmpegDecode(flac, "flac", { maxSeconds: limit })) {
      expect(block.length).toBeGreaterThan(0);
      break;
    }
    await Bun.sleep(300);
    const running = Bun.spawnSync(["pgrep", "-f", `${limit + 1} -f s16le -c:a pcm_s16le`]).stdout.toString().trim();
    expect(running).toBe("");
  });
});
