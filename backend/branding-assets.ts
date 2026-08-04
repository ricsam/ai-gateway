export interface ImageInfo { mimeType: string; width: number; height: number }

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset++; continue; }
    const marker = bytes[offset + 1]!; const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: (bytes[offset + 5]! << 8) | bytes[offset + 6]!, width: (bytes[offset + 7]! << 8) | bytes[offset + 8]! };
    }
    if (length < 2) return null; offset += length + 2;
  }
  return null;
}

export function inspectImage(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length >= 24 && bytes.slice(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index])) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { mimeType: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 10 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const dimensions = jpegDimensions(bytes); return dimensions ? { mimeType: "image/jpeg", ...dimensions } : null;
  }
  if (bytes.length >= 30 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP") {
    if (new TextDecoder().decode(bytes.slice(12, 16)) === "VP8X") return { mimeType: "image/webp", width: 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16), height: 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16) };
    return { mimeType: "image/webp", width: 1, height: 1 };
  }
  if (bytes.length >= 8 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) {
    return { mimeType: "image/x-icon", width: bytes[6] || 256, height: bytes[7] || 256 };
  }
  return null;
}

export function validateBrandingImage(bytes: Uint8Array, claimedMime: string, kind: "logo" | "favicon"): ImageInfo {
  if (!bytes.byteLength || bytes.byteLength > 512 * 1024) throw new Error("Asset must not exceed 512 KiB");
  const info = inspectImage(bytes);
  if (!info || info.mimeType !== claimedMime) throw new Error("Image content does not match its declared PNG, JPEG, WebP, or icon format");
  const maxDimension = kind === "favicon" ? 512 : 2048;
  if (info.width < 1 || info.height < 1 || info.width > maxDimension || info.height > maxDimension) throw new Error(`Image dimensions must be between 1 and ${maxDimension} pixels`);
  return info;
}
