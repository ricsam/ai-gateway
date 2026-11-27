import { describe, expect, test } from "bun:test";
import { decodeWav, decodeWavBlocks, encodeWav, floatToInt16, isNativeWav, parseWav, resample, SAMPLE_RATE, wavSeconds } from "./pcm";

/** A WAV file with the given format chunk fields and raw sample bytes. */
function wav(options: { formatTag?: number; channels?: number; rate?: number; bits?: number; data: Uint8Array; extensible?: number; dataSize?: number; extraChunk?: boolean }): Uint8Array {
  const channels = options.channels ?? 1;
  const bits = options.bits ?? 16;
  const blockAlign = channels * Math.ceil(bits / 8);
  const fmtSize = options.extensible !== undefined ? 40 : 16;
  const extra = options.extraChunk ? 8 + 3 + 1 : 0;
  const out = new Uint8Array(12 + 8 + fmtSize + extra + 8 + options.data.length);
  const view = new DataView(out.buffer);
  const write = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i); };
  write(0, "RIFF"); view.setUint32(4, out.length - 8, true); write(8, "WAVE");
  write(12, "fmt "); view.setUint32(16, fmtSize, true);
  view.setUint16(20, options.extensible !== undefined ? 0xfffe : options.formatTag ?? 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, options.rate ?? SAMPLE_RATE, true);
  view.setUint32(28, (options.rate ?? SAMPLE_RATE) * blockAlign, true); view.setUint16(32, blockAlign, true); view.setUint16(34, bits, true);
  if (options.extensible !== undefined) { view.setUint16(36, 22, true); view.setUint16(38, bits, true); view.setUint16(44, options.extensible, true); }
  let offset = 20 + fmtSize;
  if (options.extraChunk) { write(offset, "LIST"); view.setUint32(offset + 4, 3, true); offset += 8 + 3 + 1; }
  write(offset, "data"); view.setUint32(offset + 4, options.dataSize ?? options.data.length, true);
  out.set(options.data, offset + 8);
  return out;
}

function int16Bytes(samples: number[]): Uint8Array {
  return new Uint8Array(new Int16Array(samples).buffer);
}

function sine(frequency: number, rate: number, seconds: number, amplitude = 0.5): Float32Array {
  return Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amplitude * Math.sin((2 * Math.PI * frequency * i) / rate));
}

/** Amplitude of `frequency` in `samples`, by correlation with a sine and a cosine. */
function amplitudeAt(samples: ArrayLike<number>, frequency: number, rate: number): number {
  let sin = 0; let cos = 0;
  for (let i = 0; i < samples.length; i++) {
    sin += samples[i]! * Math.sin((2 * Math.PI * frequency * i) / rate);
    cos += samples[i]! * Math.cos((2 * Math.PI * frequency * i) / rate);
  }
  return (2 * Math.hypot(sin, cos)) / samples.length;
}

describe("WAV reading", () => {
  test("16 kHz mono 16-bit PCM is used as it is", () => {
    const info = parseWav(wav({ data: int16Bytes([0, 1000, -1000, 32767, -32768]) }))!;
    expect(info).toMatchObject({ formatTag: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16 });
    expect(Array.from(decodeWav(info))).toEqual([0, 1000, -1000, 32767, -32768]);
  });

  test("mixes channels down, and reads 8, 24 and 32-bit integers and 32/64-bit floats", () => {
    const stereo = parseWav(wav({ channels: 2, data: int16Bytes([1000, 3000, -2000, -4000]) }))!;
    expect(Array.from(decodeWav(stereo))).toEqual([2000, -3000]);
    const eight = parseWav(wav({ bits: 8, data: new Uint8Array([128, 192, 64]) }))!;
    expect(Array.from(decodeWav(eight))).toEqual([0, 16384, -16384]);
    const twentyFour = parseWav(wav({ bits: 24, data: new Uint8Array([0, 0, 0x40, 0, 0, 0xc0]) }))!;
    expect(Array.from(decodeWav(twentyFour))).toEqual([16384, -16384]);
    const thirtyTwo = parseWav(wav({ bits: 32, data: new Uint8Array(new Int32Array([1 << 30, -(1 << 30)]).buffer) }))!;
    expect(Array.from(decodeWav(thirtyTwo))).toEqual([16384, -16384]);
    const float = parseWav(wav({ formatTag: 3, bits: 32, data: new Uint8Array(new Float32Array([0.5, -0.5, 2]).buffer) }))!;
    expect(Array.from(decodeWav(float))).toEqual([16384, -16384, 32767]);
    const double = parseWav(wav({ formatTag: 3, bits: 64, data: new Uint8Array(new Float64Array([0.25]).buffer) }))!;
    expect(Array.from(decodeWav(double))).toEqual([8192]);
  });

  test("reads WAVE_FORMAT_EXTENSIBLE, skips other chunks, and takes a streamed file's data to its end", () => {
    const extensible = parseWav(wav({ extensible: 1, data: int16Bytes([7, 8]) }))!;
    expect(extensible.formatTag).toBe(1);
    expect(Array.from(decodeWav(extensible))).toEqual([7, 8]);
    expect(Array.from(decodeWav(parseWav(wav({ extraChunk: true, data: int16Bytes([5]) }))!))).toEqual([5]);
    // Recorders that stream leave the data size 0 or 0xFFFFFFFF.
    expect(Array.from(decodeWav(parseWav(wav({ dataSize: 0, data: int16Bytes([1, 2, 3]) }))!))).toEqual([1, 2, 3]);
    expect(Array.from(decodeWav(parseWav(wav({ dataSize: 0xffffffff, data: int16Bytes([4, 5]) }))!))).toEqual([4, 5]);
  });

  test("leaves compressed WAV codecs and RF64 to ffmpeg", () => {
    const mulaw = parseWav(wav({ formatTag: 7, bits: 8, data: new Uint8Array([1, 2]) }))!;
    expect(isNativeWav(mulaw)).toBe(false);
    expect(() => decodeWav(mulaw)).toThrow("encoding is not supported");
    const rf64 = wav({ data: int16Bytes([1]) });
    rf64.set([0x52, 0x46, 0x36, 0x34], 0);
    expect(parseWav(rf64)).toBeNull();
    expect(parseWav(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe("resampling", () => {
  test("keeps speech frequencies and removes what 16 kHz can't hold", () => {
    for (const rate of [8000, 22050, 44100, 48000]) {
      const input = new Float32Array(sine(1000, rate, 0.5).map((value, i) => value + (rate > 16000 ? 0.5 * Math.sin((2 * Math.PI * 11000 * i) / rate) : 0)));
      const output = resample(input, rate, SAMPLE_RATE);
      expect(output.length).toBe(Math.floor(input.length / (rate / SAMPLE_RATE)));
      const middle = output.subarray(200, output.length - 200);
      expect(amplitudeAt(middle, 1000, SAMPLE_RATE)).toBeCloseTo(0.5, 1);
      // 11 kHz would fold back to 5 kHz without the low-pass filter.
      if (rate > 16000) expect(amplitudeAt(middle, 5000, SAMPLE_RATE)).toBeLessThan(0.01);
    }
  });

  test("decodes 44.1 kHz stereo to 16 kHz mono", () => {
    const left = sine(440, 44100, 1);
    const data = new Int16Array(left.length * 2);
    left.forEach((value, i) => { data[i * 2] = Math.round(value * 32767); data[i * 2 + 1] = Math.round(value * 32767); });
    const samples = decodeWav(parseWav(wav({ channels: 2, rate: 44100, data: new Uint8Array(data.buffer) }))!);
    expect(samples.length).toBe(16000);
    expect(amplitudeAt(Float32Array.from(samples.subarray(500, 15500), (value) => value / 32768), 440, SAMPLE_RATE)).toBeCloseTo(0.5, 1);
  });

  test("decodes long files ten seconds at a time, exactly as in one piece", () => {
    for (const rate of [8000, 44100]) {
      const input = sine(300, rate, 25.3, 0.4);
      const info = parseWav(wav({ formatTag: 3, bits: 32, rate, data: new Uint8Array(input.buffer) }))!;
      const blocks = [...decodeWavBlocks(info)];
      expect(blocks.map((block) => block.length).slice(0, 2)).toEqual([160000, 160000]);
      expect(Array.from(decodeWav(info))).toEqual(Array.from(floatToInt16(resample(input, rate, SAMPLE_RATE))));
    }
    expect(wavSeconds(parseWav(wav({ rate: 8000, data: new Uint8Array(16000 * 2) }))!)).toBe(2);
  });
});

test("writes 16 kHz mono 16-bit WAV that reads back unchanged", () => {
  const samples = new Int16Array([0, 1, -1, 12345, -32768, 32767]);
  const bytes = encodeWav(samples);
  expect(bytes.length).toBe(44 + samples.length * 2);
  expect(String.fromCharCode(...bytes.subarray(0, 4), ...bytes.subarray(8, 16))).toBe("RIFFWAVEfmt ");
  const info = parseWav(bytes)!;
  expect(info).toMatchObject({ formatTag: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16, blockAlign: 2 });
  expect(Array.from(decodeWav(info))).toEqual(Array.from(samples));
});
