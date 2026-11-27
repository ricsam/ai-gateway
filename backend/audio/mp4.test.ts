import { describe, expect, test } from "bun:test";
import { moveIndexToFront } from "./mp4";

function box(type: string, ...children: Uint8Array[]): Uint8Array {
  const size = 8 + children.reduce((sum, child) => sum + child.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let offset = 8;
  for (const child of children) { out.set(child, offset); offset += child.length; }
  return out;
}

/** A chunk-offset table (stco or co64) with the given offsets. */
function offsets(type: "stco" | "co64", values: number[]): Uint8Array {
  const width = type === "stco" ? 4 : 8;
  const body = new Uint8Array(8 + values.length * width);
  const view = new DataView(body.buffer);
  view.setUint32(4, values.length);
  values.forEach((value, index) => {
    if (width === 4) view.setUint32(8 + index * 4, value);
    else view.setBigUint64(8 + index * 8, BigInt(value));
  });
  return box(type, body);
}

function boxesOf(bytes: Uint8Array): Array<{ type: string; start: number; size: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  for (let offset = 0; offset + 8 <= bytes.length;) {
    const size = view.getUint32(offset);
    out.push({ type: String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)), start: offset, size });
    offset += size;
  }
  return out;
}

function readOffsets(bytes: Uint8Array, type: "stco" | "co64"): number[] {
  const marker = [...type].map((character) => character.charCodeAt(0));
  for (let i = 4; i + 4 <= bytes.length; i++) {
    if (marker.every((value, k) => bytes[i + k] === value)) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + i + 4);
      const count = view.getUint32(4);
      return Array.from({ length: count }, (_, index) => (type === "stco" ? view.getUint32(8 + index * 4) : Number(view.getBigUint64(8 + index * 8))));
    }
  }
  return [];
}

describe("moving an MP4 index in front of its media", () => {
  const ftyp = box("ftyp", new TextEncoder().encode("M4A \0\0\0\0isomM4A "));
  const media = box("mdat", new Uint8Array(64).map((_, index) => index));
  const mediaStart = ftyp.length;
  const samples = [mediaStart + 8, mediaStart + 24, mediaStart + 40];

  test("shifts the chunk offsets by the index's size, in stco and co64 tables", () => {
    for (const type of ["stco", "co64"] as const) {
      const moov = box("moov", box("mvhd", new Uint8Array(4)), box("trak", box("mdia", box("minf", box("stbl", box("stsd", new Uint8Array(4)), offsets(type, samples))))));
      const file = new Uint8Array([...ftyp, ...media, ...moov]);
      const moved = moveIndexToFront(file);
      expect(moved.length).toBe(file.length);
      expect(boxesOf(moved).map((entry) => entry.type)).toEqual(["ftyp", "moov", "mdat"]);
      expect(readOffsets(moved, type)).toEqual(samples.map((offset) => offset + moov.length));
      // Each offset still points at the same media byte.
      const shifted = readOffsets(moved, type);
      shifted.forEach((offset, index) => expect(moved[offset]).toBe(file[samples[index]!]!));
    }
  });

  test("leaves files whose index comes first, or that have none, unchanged", () => {
    const moov = box("moov", box("trak", box("mdia", box("minf", box("stbl", offsets("stco", [100]))))));
    const fast = new Uint8Array([...ftyp, ...moov, ...media]);
    expect(moveIndexToFront(fast)).toBe(fast);
    const noIndex = new Uint8Array([...ftyp, ...media]);
    expect(moveIndexToFront(noIndex)).toBe(noIndex);
    const truncated = new Uint8Array([...ftyp, ...media, ...moov.subarray(0, 12)]);
    expect(moveIndexToFront(truncated)).toBe(truncated);
  });
});
