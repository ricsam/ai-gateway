/**
 * The gateway works on 16 kHz mono 16-bit PCM, the input Bedrock speech
 * models expect. This module reads WAV files without ffmpeg (integer and
 * float PCM of any rate and channel count), resamples, and writes WAV.
 */
import { AudioInputError } from "./errors";

export const SAMPLE_RATE = 16_000;

export interface WavInfo {
  /** 1 integer PCM, 3 IEEE float; anything else needs ffmpeg. */
  formatTag: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  blockAlign: number;
  data: Uint8Array;
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

/** Read a RIFF/WAVE file's format and sample data. Returns null for files ffmpeg must read (RF64, compressed codecs). */
export function parseWav(bytes: Uint8Array): WavInfo | null {
  if (bytes.length < 12 || fourcc(bytes, 0) !== "RIFF" || fourcc(bytes, 8) !== "WAVE") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let format: Omit<WavInfo, "data"> | undefined;
  while (offset + 8 <= bytes.length) {
    const id = fourcc(bytes, offset);
    const declared = view.getUint32(offset + 4, true);
    const bodyStart = offset + 8;
    if (id === "fmt " && declared >= 16 && bodyStart + 16 <= bytes.length) {
      let formatTag = view.getUint16(bodyStart, true);
      if (formatTag === WAVE_FORMAT_EXTENSIBLE && declared >= 40 && bodyStart + 26 <= bytes.length) {
        // The first two bytes of the sub-format GUID are the actual format tag.
        formatTag = view.getUint16(bodyStart + 24, true);
      }
      format = {
        formatTag,
        channels: view.getUint16(bodyStart + 2, true),
        sampleRate: view.getUint32(bodyStart + 4, true),
        blockAlign: view.getUint16(bodyStart + 12, true),
        bitsPerSample: view.getUint16(bodyStart + 14, true),
      };
    } else if (id === "data") {
      if (!format) return null;
      // Streamed recordings leave the size 0 or 0xFFFFFFFF: the data runs to the end of the file.
      const available = bytes.length - bodyStart;
      const length = declared === 0 || declared > available ? available : declared;
      const whole = format.blockAlign > 0 ? length - (length % format.blockAlign) : length;
      return { ...format, data: bytes.subarray(bodyStart, bodyStart + whole) };
    }
    offset = bodyStart + declared + (declared & 1);
  }
  return null;
}

/** Whether the gateway decodes this WAV itself, or ffmpeg has to. */
export function isNativeWav(info: WavInfo): boolean {
  if (info.channels < 1 || info.channels > 32 || info.sampleRate < 1_000 || info.sampleRate > 768_000) return false;
  if (info.blockAlign !== info.channels * Math.ceil(info.bitsPerSample / 8)) return false;
  if (info.formatTag === WAVE_FORMAT_PCM) return [8, 16, 24, 32].includes(info.bitsPerSample);
  if (info.formatTag === WAVE_FORMAT_IEEE_FLOAT) return info.bitsPerSample === 32 || info.bitsPerSample === 64;
  return false;
}

/** Mix frames [`from`, `to`) of a WAV's channels down to mono samples in [-1, 1]. */
function monoFloat(info: WavInfo, from: number, to: number): Float32Array {
  const { channels, bitsPerSample, formatTag, data } = info;
  const bytesPerSample = bitsPerSample / 8;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out = new Float32Array(to - from);
  const read = (position: number): number => {
    if (formatTag === WAVE_FORMAT_IEEE_FLOAT) {
      return bitsPerSample === 32 ? view.getFloat32(position, true) : view.getFloat64(position, true);
    }
    switch (bitsPerSample) {
      case 8: return (view.getUint8(position) - 128) / 128;
      case 16: return view.getInt16(position, true) / 32768;
      case 24: {
        const value = view.getUint8(position) | (view.getUint8(position + 1) << 8) | (view.getInt8(position + 2) << 16);
        return value / 8388608;
      }
      default: return view.getInt32(position, true) / 2147483648;
    }
  };
  for (let frame = from; frame < to; frame++) {
    let sum = 0;
    const base = frame * bytesPerSample * channels;
    for (let channel = 0; channel < channels; channel++) sum += read(base + channel * bytesPerSample);
    out[frame - from] = sum / channels;
  }
  return out;
}

/** Kernel samples per input sample in the resampling filter's lookup table. */
const KERNEL_RESOLUTION = 256;

/**
 * Windowed-sinc resampling to `outRate`, a range of output samples at a time.
 * Downsampling low-passes at the output's Nyquist frequency, so speech above
 * 8 kHz doesn't fold back into the band.
 */
class Resampler {
  readonly ratio: number;
  private readonly halfWidth: number;
  private readonly table: Float32Array;

  constructor(inRate: number, outRate: number) {
    this.ratio = inRate / outRate;
    const cutoff = Math.min(1, 1 / this.ratio) * 0.94;
    this.halfWidth = Math.ceil(12 * Math.max(1, this.ratio));
    // A Blackman-windowed sinc low-pass sampled from distance 0 to halfWidth input samples.
    this.table = new Float32Array(this.halfWidth * KERNEL_RESOLUTION + 2);
    for (let index = 0; index < this.table.length; index++) {
      const distance = index / KERNEL_RESOLUTION;
      const position = distance / this.halfWidth;
      if (position >= 1) continue;
      const x = Math.PI * cutoff * distance;
      const sinc = x === 0 ? 1 : Math.sin(x) / x;
      this.table[index] = sinc * (0.42 + 0.5 * Math.cos(Math.PI * position) + 0.08 * Math.cos(2 * Math.PI * position));
    }
  }

  outputLength(inputLength: number): number {
    return Math.floor(inputLength / this.ratio);
  }

  /** The input samples [first, end) that outputs [outStart, outEnd) are made from. */
  inputRange(outStart: number, outEnd: number, inputLength: number): [number, number] {
    const first = Math.max(0, Math.floor(outStart * this.ratio) - this.halfWidth + 1);
    const end = Math.min(inputLength, Math.floor((outEnd - 1) * this.ratio) + this.halfWidth + 1);
    return [first, end];
  }

  /** Outputs [outStart, outEnd) from `input`, which holds input samples from `inputStart` on. */
  render(input: Float32Array, inputStart: number, inputLength: number, outStart: number, outEnd: number): Float32Array {
    const output = new Float32Array(outEnd - outStart);
    const limit = this.halfWidth * KERNEL_RESOLUTION;
    for (let index = outStart; index < outEnd; index++) {
      const center = index * this.ratio;
      const first = Math.max(0, Math.floor(center) - this.halfWidth + 1);
      const last = Math.min(inputLength - 1, Math.floor(center) + this.halfWidth);
      let sum = 0;
      let weights = 0;
      for (let k = first; k <= last; k++) {
        const position = Math.abs(center - k) * KERNEL_RESOLUTION;
        if (position >= limit) continue;
        const cell = Math.floor(position);
        const weight = this.table[cell]! + (this.table[cell + 1]! - this.table[cell]!) * (position - cell);
        sum += input[k - inputStart]! * weight;
        weights += weight;
      }
      output[index - outStart] = weights === 0 ? 0 : sum / weights;
    }
    return output;
  }
}

export function resample(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate) return input;
  const resampler = new Resampler(inRate, outRate);
  return resampler.render(input, 0, input.length, 0, resampler.outputLength(input.length));
}

export function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index++) {
    const value = Math.max(-1, Math.min(1, samples[index]!));
    out[index] = Math.round(value < 0 ? value * 32768 : value * 32767);
  }
  return out;
}

/** Output samples per block when decoding a WAV: ten seconds. */
const BLOCK_SAMPLES = SAMPLE_RATE * 10;

/** Seconds of audio in a WAV. */
export function wavSeconds(info: WavInfo): number {
  return Math.floor(info.data.length / info.blockAlign) / info.sampleRate;
}

/**
 * Decode a WAV the gateway reads itself to 16 kHz mono 16-bit samples, ten
 * seconds at a time, so a long file is never held as samples all at once.
 */
export function* decodeWavBlocks(info: WavInfo): Generator<Int16Array> {
  if (!isNativeWav(info)) throw new AudioInputError("The WAV file's encoding is not supported", "unsupported_audio_format");
  const frames = Math.floor(info.data.length / info.blockAlign);
  if (info.formatTag === WAVE_FORMAT_PCM && info.bitsPerSample === 16 && info.channels === 1 && info.sampleRate === SAMPLE_RATE) {
    for (let start = 0; start < frames; start += BLOCK_SAMPLES) {
      const end = Math.min(frames, start + BLOCK_SAMPLES);
      yield new Int16Array(new Uint8Array(info.data.subarray(start * 2, end * 2)).buffer);
    }
    return;
  }
  if (info.sampleRate === SAMPLE_RATE) {
    for (let start = 0; start < frames; start += BLOCK_SAMPLES) yield floatToInt16(monoFloat(info, start, Math.min(frames, start + BLOCK_SAMPLES)));
    return;
  }
  const resampler = new Resampler(info.sampleRate, SAMPLE_RATE);
  const total = resampler.outputLength(frames);
  for (let start = 0; start < total; start += BLOCK_SAMPLES) {
    const end = Math.min(total, start + BLOCK_SAMPLES);
    const [first, last] = resampler.inputRange(start, end, frames);
    yield floatToInt16(resampler.render(monoFloat(info, first, last), first, frames, start, end));
  }
}

/** Decode a whole WAV the gateway reads itself to 16 kHz mono 16-bit samples. */
export function decodeWav(info: WavInfo): Int16Array {
  const blocks = [...decodeWavBlocks(info)];
  const out = new Int16Array(blocks.reduce((sum, block) => sum + block.length, 0));
  let offset = 0;
  for (const block of blocks) { out.set(block, offset); offset += block.length; }
  return out;
}

/** A 16-bit mono PCM WAV file of `samples`. */
export function encodeWav(samples: Int16Array, sampleRate = SAMPLE_RATE): Uint8Array<ArrayBuffer> {
  const dataLength = samples.length * 2;
  const out = new Uint8Array(44 + dataLength);
  const view = new DataView(out.buffer);
  const write = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i); };
  write(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, WAVE_FORMAT_PCM, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, dataLength, true);
  for (let index = 0; index < samples.length; index++) view.setInt16(44 + index * 2, samples[index]!, true);
  return out;
}
