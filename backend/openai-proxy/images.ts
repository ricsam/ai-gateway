/**
 * Image input handling for the OpenAI-compatible endpoint.
 *
 * Bedrock Converse accepts PNG, JPEG, GIF, and WebP bytes. The format sent to
 * Bedrock is detected from the image bytes rather than trusted from a declared
 * MIME type, because clients frequently mislabel images (for example a PNG
 * screenshot sent as `data:image/jpeg`).
 */
import type { ImageFormat } from "@aws-sdk/client-bedrock-runtime";

export const SUPPORTED_IMAGE_FORMATS_TEXT = "PNG, JPEG, GIF, or WebP";

/** A client-correctable problem with an image in the request (HTTP 400). */
export class ImageInputError extends Error {
  override name = "ImageInputError";
  constructor(message: string, readonly code: "invalid_image" | "invalid_image_url" | "remote_image_urls_disabled" = "invalid_image", public param?: string) {
    super(message);
  }
}

export interface ResolvedImage {
  format: ImageFormat;
  bytes: Uint8Array;
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

/** Detect a Bedrock-supported image format from magic bytes. */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "gif";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  return null;
}

/** Decode a `data:image/...;base64,...` URL into Bedrock image bytes. */
export function decodeImageDataUrl(url: string): ResolvedImage {
  const comma = url.indexOf(",");
  if (!/^data:/i.test(url) || comma < 0) throw new ImageInputError("Image data URL is malformed");
  const [mediaType = "", ...parameters] = url.slice(5, comma).split(";").map((part) => part.trim().toLowerCase());
  if (!mediaType.startsWith("image/")) throw new ImageInputError("Image data URL must declare an image media type");
  if (!parameters.includes("base64")) throw new ImageInputError("Image data URL must be base64 encoded");

  let payload = url.slice(comma + 1);
  if (/\s/.test(payload)) payload = payload.replace(/\s+/g, "");
  if (payload.includes("%")) {
    try { payload = decodeURIComponent(payload); } catch { throw new ImageInputError("Image data URL contains invalid base64 data"); }
  }
  if (!payload || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(payload)) throw new ImageInputError("Image data URL contains invalid base64 data");

  const decoded = Buffer.from(payload, "base64");
  const bytes = new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  const format = sniffImageFormat(bytes);
  if (!format) throw new ImageInputError(`Unsupported image content (declared ${mediaType}); images must be ${SUPPORTED_IMAGE_FORMATS_TEXT}`);
  return { format, bytes };
}

/** Classify an image URL; `null` means the scheme is unsupported. */
export function imageUrlKind(url: string): "data" | "remote" | null {
  if (/^data:/i.test(url)) return "data";
  if (/^https?:\/\//i.test(url)) return "remote";
  return null;
}
