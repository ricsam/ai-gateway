import { describe, expect, test } from "bun:test";
import { buildCues, formatSrt, formatVtt, wrapLines } from "./subtitles";

const options = { maxLineLength: 42, maxLines: 2 };
const unit = (text: string, start: number, end: number, sentenceEnd = true) => ({ text, start, end, sentenceEnd });

describe("line breaks", () => {
  test("keep short text on one line and balance two lines", () => {
    expect(wrapLines("Welcome to the weekly product update.", 42, 2)).toEqual(["Welcome to the weekly product update."]);
    expect(wrapLines("The dashboard now shows every invoice, every payment, and every refund.", 42, 2))
      .toEqual(["The dashboard now shows every invoice,", "every payment, and every refund."]);
    expect(wrapLines("one two three four five six seven", 10, 1)).toEqual(["one two three four five six seven"]);
  });

  test("never break inside a word, even one longer than a line", () => {
    expect(wrapLines("Supercalifragilisticexpialidocious is long", 16, 2)).toEqual(["Supercalifragilisticexpialidocious", "is long"]);
  });
});

describe("cues", () => {
  test("start at a sentence end, unless the next short sentence fits on the same line", () => {
    const cues = buildCues([
      unit("Two, heaven.", 1, 1.8),
      unit("Three, earth.", 2, 2.9),
      unit("The art of war is of vital importance to the state.", 3.5, 6.5),
    ], options);
    expect(cues.map((cue) => cue.lines)).toEqual([["Two, heaven. Three, earth."], ["The art of war is of vital", "importance to the state."]]);
    expect(cues.map((cue) => [cue.start, cue.end])).toEqual([[1, 2.9], [3.5, 6.5]]);
  });

  test("join clauses into cues of at most two lines and 7 seconds, and split longer ones by length", () => {
    const cues = buildCues([
      unit("The art of war, then, is governed by five constant factors,", 41.8, 45.4, false),
      unit("to be taken into account in one's deliberations,", 45.6, 48.3, false),
      unit("when seeking to determine the conditions obtaining in the field.", 48.8, 51.7),
    ], options);
    for (const cue of cues) {
      expect(cue.lines.length).toBeLessThanOrEqual(2);
      for (const line of cue.lines) expect(line.length).toBeLessThanOrEqual(42);
      expect(cue.end - cue.start).toBeLessThanOrEqual(7);
    }
    expect(cues.map((cue) => cue.lines.join(" ")).join(" ")).toBe(
      "The art of war, then, is governed by five constant factors, to be taken into account in one's deliberations, when seeking to determine the conditions obtaining in the field.",
    );
    const long = buildCues([unit("word ".repeat(60).trim(), 0, 30)], options);
    expect(long.length).toBeGreaterThan(4);
    long.slice(1).forEach((cue, index) => expect(cue.start).toBeGreaterThanOrEqual(long[index]!.end));
  });

  test("stay up at least a second when there is room, and never overlap", () => {
    const cues = buildCues([unit("Yes.", 1, 1.3), unit("No.", 2, 2.2), unit("Maybe.", 2.25, 2.6)], { ...options, maxLineLength: 4 });
    expect(cues.map((cue) => [cue.start, Number(cue.end.toFixed(2))])).toEqual([[1, 1.96], [2, 2.21], [2.25, 3.25]]);
  });
});

describe("files", () => {
  const cues = [
    { start: 0.01, end: 1.95, lines: ["Welcome to the weekly update."] },
    { start: 3661.5, end: 3663.25, lines: ["Compare <b> & a --> b", "second line"] },
  ];

  test("SRT numbers its cues and uses comma milliseconds", () => {
    expect(formatSrt(cues)).toBe(
      "1\n00:00:00,010 --> 00:00:01,950\nWelcome to the weekly update.\n\n2\n01:01:01,500 --> 01:01:03,250\nCompare <b> & a --> b\nsecond line\n",
    );
  });

  test("WebVTT starts with its header, uses dot milliseconds and escapes markup", () => {
    expect(formatVtt(cues)).toBe(
      "WEBVTT\n\n00:00:00.010 --> 00:00:01.950\nWelcome to the weekly update.\n\n01:01:01.500 --> 01:01:03.250\nCompare &lt;b&gt; &amp; a --&gt; b\nsecond line\n",
    );
    expect(formatVtt([])).toBe("WEBVTT\n");
    expect(formatSrt([])).toBe("");
  });
});
