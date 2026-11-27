import { describe, expect, test } from "bun:test";
import { alignUnits, segmentsOf, splitUnits, timeTranscript } from "./timing";

describe("sentences and clauses", () => {
  test("split at sentence ends and long clauses, not at list numbers, initials or abbreviations", () => {
    expect(splitUnits("5. Which army is stronger? 6. On which side are officers and men more highly trained? Mr. Smith went to St. Louis, e.g. by train. Version 2.4 shipped.")).toEqual([
      { text: "5. Which army is stronger?", sentenceEnd: true },
      { text: "6. On which side are officers and men more highly trained?", sentenceEnd: true },
      { text: "Mr. Smith went to St. Louis, e.g. by train.", sentenceEnd: true },
      { text: "Version 2.4 shipped.", sentenceEnd: true },
    ]);
    expect(splitUnits("The dashboard now shows every invoice, every payment, and every refund in one place.")).toEqual([
      { text: "The dashboard now shows every invoice, every payment,", sentenceEnd: false },
      { text: "and every refund in one place.", sentenceEnd: true },
    ]);
  });

  test("treat a line end as a sentence end, and keep CJK sentences apart", () => {
    expect(splitUnits("first line without a stop\nsecond line")).toEqual([
      { text: "first line without a stop", sentenceEnd: true },
      { text: "second line", sentenceEnd: true },
    ]);
    expect(splitUnits("你好。我们开始吧！").map((unit) => unit.text)).toEqual(["你好。", "我们开始吧！"]);
  });
});

describe("alignment", () => {
  // Speech at an even 0.075 s per letter, with a pause between each sentence and clause.
  const regions = [
    { start: 1.0, end: 2.2 }, // "This is a recording." (16 letters)
    { start: 3.0, end: 5.5 }, // "All recordings are in the public domain." (33)
    { start: 6.3, end: 9.9 }, // "For more information and to find out how you can volunteer," (48)
    { start: 10.4, end: 11.75 }, // "please visit the site." (18)
    { start: 12.6, end: 13.7 }, // "Recorded by Moira." (15)
  ];
  const expected = regions.map((region) => [region.start, region.end]);
  const text = "This is a recording. All recordings are in the public domain. For more information and to find out how you can volunteer, please visit the site. Recorded by Moira.";

  test("puts sentence and clause boundaries in the pauses that match the speaking pace", () => {
    expect(alignUnits(splitUnits(text), regions).map((unit) => [unit.start, unit.end])).toEqual(expected);
  });

  test("follows the model's timestamps where the pace alone is ambiguous", () => {
    // The pace slightly favors the second pause for the boundary; a model timestamp at the first decides.
    const close = [{ start: 0, end: 1.2 }, { start: 1.5, end: 2.2 }, { start: 2.5, end: 3.9 }];
    const units = [{ text: "One two three", sentenceEnd: true }, { text: "four five six", sentenceEnd: true }];
    expect(alignUnits(units, close).map((unit) => unit.end)).toEqual([2.2, 3.9]);
    expect(alignUnits(units, close, { hints: [1.35] }).map((unit) => unit.end)).toEqual([1.2, 3.9]);
    expect(alignUnits(units, close, { hints: [2.35] }).map((unit) => unit.end)).toEqual([2.2, 3.9]);
  });

  test("isn't led astray by model timestamps that are seconds off, and times text without pauses by length", () => {
    const units = alignUnits(splitUnits(text), regions, { hints: [5.9, 12.1, 13.0, undefined] });
    expect(units.map((unit) => [unit.start, unit.end])).toEqual(expected);
    const flat = alignUnits([{ text: "aaaa", sentenceEnd: false }, { text: "bbbbbbbbbbbb", sentenceEnd: true }], [{ start: 0, end: 8 }]);
    expect(flat.map((unit) => [unit.start, unit.end])).toEqual([[0, 2], [2, 8]]);
  });

  test("times a chunk from the model's segments", () => {
    // The chunk's audio starts 0.8 s into the file; the model's times count from there.
    const chunk = { start: 0.8, end: 13.9, regions };
    const units = timeTranscript({
      text: "unused",
      segments: [
        { start: 0.3, end: 1.4, text: "This is a recording." },
        { start: 2.2, end: 4.6, text: "All recordings are in the public domain." },
        { start: 5.5, end: 10.9, text: "For more information and to find out how you can volunteer, please visit the site." },
        { start: 11.8, end: 12.9, text: "Recorded by Moira." },
      ],
    }, chunk);
    expect(units.map((unit) => [unit.start, unit.end])).toEqual(expected);
    expect(timeTranscript({ text: "This is a recording." }, { ...chunk, regions: [] })).toEqual([]);
  });

  test("joins units into sentences for verbose_json, at most 30 seconds long", () => {
    const units = alignUnits(splitUnits(text), regions);
    expect(segmentsOf(units).map((segment) => [segment.start, segment.end, segment.text])).toEqual([
      [1, 2.2, "This is a recording."],
      [3, 5.5, "All recordings are in the public domain."],
      [6.3, 11.75, "For more information and to find out how you can volunteer, please visit the site."],
      [12.6, 13.7, "Recorded by Moira."],
    ]);
    const long = Array.from({ length: 4 }, (_, index) => ({ text: `part ${index},`, sentenceEnd: false, start: index * 12, end: index * 12 + 11 }));
    expect(segmentsOf(long).map((segment) => [segment.start, segment.end])).toEqual([[0, 23], [24, 47]]);
  });
});
