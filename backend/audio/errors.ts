/**
 * Client-correctable problems with an uploaded audio file. The handlers answer
 * them with HTTP 400 (413 for a file that is too large) and the error's code.
 */
export type AudioInputErrorCode =
  | "unsupported_audio_format"
  | "audio_decode_failed"
  | "audio_too_long"
  | "file_too_large";

export class AudioInputError extends Error {
  override name = "AudioInputError";
  constructor(message: string, readonly code: AudioInputErrorCode, readonly status: 400 | 413 = 400) {
    super(message);
  }
}
