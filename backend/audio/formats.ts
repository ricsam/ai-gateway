/**
 * Detects the container of an uploaded audio or video file from its bytes,
 * never from its name or declared type, and names the ffmpeg demuxer that
 * reads it. Naming the demuxer explicitly keeps ffmpeg from probing for
 * playlist and concatenation formats, which can open other files.
 */

export type AudioContainer =
  | "wav" | "mp3" | "flac" | "ogg" | "matroska" | "mp4" | "aac" | "aiff" | "caf" | "amr" | "avi";

export interface SniffedFormat {
  container: AudioContainer;
  /** The ffmpeg demuxer (`-f`) for the container. */
  demuxer: string;
}

/** What the API documentation lists as accepted files. */
export const SUPPORTED_FORMATS_TEXT = "WAV, MP3, M4A, MP4, MOV, WebM, MKV, OGG, Opus, FLAC, AAC, AIFF, CAF, AMR or AVI";

const DEMUXERS: Record<AudioContainer, string> = {
  wav: "wav", mp3: "mp3", flac: "flac", ogg: "ogg", matroska: "matroska", mp4: "mov",
  aac: "aac", aiff: "aiff", caf: "caf", amr: "amr", avi: "avi",
};

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return "";
  let text = "";
  for (let index = offset; index < offset + length; index++) text += String.fromCharCode(bytes[index]!);
  return text;
}

/** Top-level box types that can open an ISO base media (MP4, M4A, MOV, 3GP) file. */
const ISO_BMFF_FIRST_BOXES = new Set(["ftyp", "moov", "mdat", "free", "skip", "wide", "pnot"]);

/** An MPEG audio (MP1/MP2/MP3) frame header at `offset`. */
function isMpegAudioFrame(bytes: Uint8Array, offset: number): boolean {
  if (bytes.length < offset + 4) return false;
  const [b0, b1, b2] = [bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!];
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return false;
  const version = (b1 >> 3) & 0x03;
  const layer = (b1 >> 1) & 0x03;
  const bitrate = b2 >> 4;
  const sampleRate = (b2 >> 2) & 0x03;
  return version !== 0x01 && layer !== 0x00 && bitrate !== 0x0f && sampleRate !== 0x03;
}

/** An AAC ADTS frame header at `offset`: a 12-bit sync word and layer 0. */
function isAdtsFrame(bytes: Uint8Array, offset: number): boolean {
  return bytes.length >= offset + 7 && bytes[offset] === 0xff && (bytes[offset + 1]! & 0xf6) === 0xf0;
}

/** The size of an ID3v2 tag at the start of the file, or 0. */
function id3TagLength(bytes: Uint8Array): number {
  if (ascii(bytes, 0, 3) !== "ID3" || bytes.length < 10) return 0;
  const size = ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f);
  const footer = (bytes[5]! & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

function result(container: AudioContainer): SniffedFormat {
  return { container, demuxer: DEMUXERS[container] };
}

export function sniffAudioFormat(bytes: Uint8Array): SniffedFormat | null {
  const head4 = ascii(bytes, 0, 4);
  if ((head4 === "RIFF" || head4 === "RF64") && ascii(bytes, 8, 4) === "WAVE") return result("wav");
  if (head4 === "RIFF" && ascii(bytes, 8, 4) === "AVI ") return result("avi");
  if (head4 === "FORM" && (ascii(bytes, 8, 4) === "AIFF" || ascii(bytes, 8, 4) === "AIFC")) return result("aiff");
  if (head4 === "fLaC") return result("flac");
  if (head4 === "OggS") return result("ogg");
  if (head4 === "caff") return result("caf");
  if (ascii(bytes, 0, 5) === "#!AMR") return result("amr");
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return result("matroska");
  if (ISO_BMFF_FIRST_BOXES.has(ascii(bytes, 4, 4))) return result("mp4");

  // MPEG audio and ADTS AAC streams may start with an ID3v2 tag.
  const start = id3TagLength(bytes);
  if (start > 0 && ascii(bytes, start, 4) === "fLaC") return result("flac");
  if (isAdtsFrame(bytes, start)) return result("aac");
  if (isMpegAudioFrame(bytes, start)) return result("mp3");
  // A tag followed by padding or junk before the first frame: ffmpeg's MP3 demuxer resynchronizes.
  if (start > 0 && start < bytes.length) return result("mp3");
  return null;
}
