/**
 * ffmpeg reads uploads from a pipe, which it cannot seek. An MP4, M4A or MOV
 * file whose index (the `moov` box) follows its media data (`mdat`) can't be
 * read that way, so the index is moved in front of the media first, as
 * qt-faststart does, and its chunk offsets are shifted to match.
 */

interface Box { type: string; start: number; size: number }

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

/** The boxes of `bytes[from, to)`, or null when a box's size doesn't fit. */
function readBoxes(bytes: Uint8Array, from: number, to: number): Box[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes: Box[] = [];
  let offset = from;
  while (offset + 8 <= to) {
    let size = view.getUint32(offset);
    const type = fourcc(bytes, offset + 4);
    if (size === 1) {
      if (offset + 16 > to) return null;
      size = Number(view.getBigUint64(offset + 8));
    } else if (size === 0) {
      size = to - offset;
    }
    if (size < 8 || offset + size > to) return null;
    boxes.push({ type, start: offset, size });
    offset += size;
  }
  return boxes;
}

/** Boxes that contain the sample tables, on the path moov/trak/mdia/minf/stbl. */
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "mvex"]);

/** Shift every chunk offset in [`from`, `to`) by `delta`; false if one no longer fits. */
function shiftChunkOffsets(moov: Uint8Array, start: number, end: number, from: number, to: number, delta: number): boolean {
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const boxes = readBoxes(moov, start, end);
  if (!boxes) return false;
  for (const box of boxes) {
    const headerSize = view.getUint32(box.start) === 1 ? 16 : 8;
    const body = box.start + headerSize;
    if (CONTAINERS.has(box.type)) {
      if (!shiftChunkOffsets(moov, body, box.start + box.size, from, to, delta)) return false;
    } else if (box.type === "stco" || box.type === "co64") {
      // Full box: version and flags, then the entry count and the offsets.
      if (body + 8 > box.start + box.size) return false;
      const count = view.getUint32(body + 4);
      const width = box.type === "stco" ? 4 : 8;
      if (body + 8 + count * width > box.start + box.size) return false;
      for (let index = 0; index < count; index++) {
        const position = body + 8 + index * width;
        const offset = width === 4 ? view.getUint32(position) : Number(view.getBigUint64(position));
        if (offset < from || offset >= to) continue;
        const moved = offset + delta;
        if (width === 4) {
          if (moved > 0xffffffff) return false;
          view.setUint32(position, moved);
        } else {
          view.setBigUint64(position, BigInt(moved));
        }
      }
    }
  }
  return true;
}

/**
 * The file with its `moov` box in front of its first `mdat` box. Files that
 * already have it there, fragmented files and files that can't be parsed are
 * returned unchanged; ffmpeg reports what it cannot read.
 */
export function moveIndexToFront(bytes: Uint8Array): Uint8Array {
  const boxes = readBoxes(bytes, 0, bytes.length);
  if (!boxes) return bytes;
  const moovIndex = boxes.findIndex((box) => box.type === "moov");
  const mdatIndex = boxes.findIndex((box) => box.type === "mdat");
  if (moovIndex < 0 || mdatIndex < 0 || moovIndex < mdatIndex) return bytes;

  const moovBox = boxes[moovIndex]!;
  const mdatStart = boxes[mdatIndex]!.start;
  const moov = bytes.slice(moovBox.start, moovBox.start + moovBox.size);
  // Everything from the first mdat up to the moov moves back by the moov's size.
  if (!shiftChunkOffsets(moov, 0, moov.length, mdatStart, moovBox.start, moovBox.size)) return bytes;

  const out = new Uint8Array(bytes.length);
  out.set(bytes.subarray(0, mdatStart), 0);
  out.set(moov, mdatStart);
  out.set(bytes.subarray(mdatStart, moovBox.start), mdatStart + moov.length);
  out.set(bytes.subarray(moovBox.start + moovBox.size), moovBox.start + moovBox.size);
  return out;
}
