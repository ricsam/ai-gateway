/**
 * Opens an uploaded file as 16 kHz mono audio. WAV files with integer or float
 * PCM are decoded by the gateway; every other format goes through ffmpeg. The
 * audio can be decoded more than once, so long files never have to be held in
 * memory as samples: one pass measures the audio, another cuts it into chunks.
 */
import { AudioInputError } from "./errors";
import { ffmpegDecode, ffmpegPath, formatLimit } from "./ffmpeg";
import { sniffAudioFormat, SUPPORTED_FORMATS_TEXT, type AudioContainer } from "./formats";
import { moveIndexToFront } from "./mp4";
import { decodeWavBlocks, isNativeWav, parseWav, wavSeconds } from "./pcm";

export interface AudioSource {
  container: AudioContainer;
  /** "wav" when the gateway decodes the file itself, else "ffmpeg". */
  decoder: "wav" | "ffmpeg";
  /** Decode the file from its start, in blocks of samples. */
  blocks(signal?: AbortSignal): AsyncIterable<Int16Array>;
}

export interface OpenAudioOptions {
  maxSeconds: number;
}

export function openAudio(bytes: Uint8Array, options: OpenAudioOptions): AudioSource {
  const format = sniffAudioFormat(bytes);
  if (!format) {
    throw new AudioInputError(`The file is not a supported audio or video format. Send ${SUPPORTED_FORMATS_TEXT}`, "unsupported_audio_format");
  }
  if (format.container === "wav") {
    const info = parseWav(bytes);
    if (info && isNativeWav(info)) {
      return {
        container: "wav",
        decoder: "wav",
        async *blocks() {
          if (wavSeconds(info) > options.maxSeconds) {
            throw new AudioInputError(`The audio is longer than ${formatLimit(options.maxSeconds)}`, "audio_too_long");
          }
          yield* decodeWavBlocks(info);
        },
      };
    }
  }
  if (!ffmpegPath()) {
    throw new AudioInputError("This gateway reads only WAV files with PCM audio: ffmpeg is not installed", "unsupported_audio_format");
  }
  const input = format.container === "mp4" ? moveIndexToFront(bytes) : bytes;
  return {
    container: format.container,
    decoder: "ffmpeg",
    blocks: (signal) => ffmpegDecode(input, format.demuxer, { maxSeconds: options.maxSeconds, signal }),
  };
}
