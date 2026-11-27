import { describe, expect, test } from "bun:test";
import { sniffAudioFormat } from "./formats";

const ascii = (text: string) => [...text].map((character) => character.charCodeAt(0));
const bytes = (...parts: Array<number[] | string>) => new Uint8Array(parts.flatMap((part) => (typeof part === "string" ? ascii(part) : part)));

describe("audio format detection", () => {
  test.each([
    ["wav", bytes("RIFF", [0, 0, 0, 0], "WAVE", "fmt ")],
    ["wav", bytes("RF64", [0, 0, 0, 0], "WAVE")],
    ["avi", bytes("RIFF", [0, 0, 0, 0], "AVI LIST")],
    ["aiff", bytes("FORM", [0, 0, 0, 0], "AIFF")],
    ["aiff", bytes("FORM", [0, 0, 0, 0], "AIFC")],
    ["flac", bytes("fLaC", [0, 0, 0, 34])],
    ["ogg", bytes("OggS", [0, 2])],
    ["caf", bytes("caff", [0, 1])],
    ["amr", bytes("#!AMR\n")],
    ["matroska", bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f])],
    ["mp4", bytes([0, 0, 0, 0x20], "ftypM4A ")],
    ["mp4", bytes([0, 0, 0, 0x20], "ftypisom")],
    ["mp4", bytes([0, 0, 0x10, 0], "moov")],
    // MPEG-1 Layer III, 128 kbit/s, 44.1 kHz
    ["mp3", bytes([0xff, 0xfb, 0x90, 0x64])],
    // AAC ADTS
    ["aac", bytes([0xff, 0xf1, 0x50, 0x80, 0, 0x1f, 0xfc])],
  ])("recognizes %s from its first bytes", (container, input) => {
    expect(sniffAudioFormat(input)?.container).toBe(container as never);
  });

  test("looks past an ID3 tag to the first MP3, AAC or FLAC frame", () => {
    const tag = (size: number) => bytes("ID3", [4, 0, 0, 0, 0, 0, size], new Array(size).fill(0));
    expect(sniffAudioFormat(new Uint8Array([...tag(5), 0xff, 0xfb, 0x90, 0x64]))?.container).toBe("mp3");
    expect(sniffAudioFormat(new Uint8Array([...tag(5), 0xff, 0xf1, 0x50, 0x80, 0, 0x1f, 0xfc]))?.container).toBe("aac");
    expect(sniffAudioFormat(new Uint8Array([...tag(3), ...ascii("fLaC")]))?.container).toBe("flac");
    // Padding after the tag: ffmpeg's MP3 demuxer finds the frames.
    expect(sniffAudioFormat(new Uint8Array([...tag(3), 0, 0, 0, 0]))?.container).toBe("mp3");
  });

  test("names the ffmpeg demuxer, and rejects what isn't audio", () => {
    expect(sniffAudioFormat(bytes([0, 0, 0, 0x20], "ftypqt  "))?.demuxer).toBe("mov");
    expect(sniffAudioFormat(bytes([0x1a, 0x45, 0xdf, 0xa3]))?.demuxer).toBe("matroska");
    expect(sniffAudioFormat(bytes([0x89], "PNG\r\n\x1a\n"))).toBeNull();
    expect(sniffAudioFormat(bytes("#EXTM3U\nhttp://example.com/a.ts"))).toBeNull();
    expect(sniffAudioFormat(bytes("ffconcat version 1.0"))).toBeNull();
    // Reserved MPEG version and layer bits are no MP3 frame.
    expect(sniffAudioFormat(bytes([0xff, 0xe9, 0x90, 0x64]))).toBeNull();
    expect(sniffAudioFormat(new Uint8Array())).toBeNull();
  });
});
