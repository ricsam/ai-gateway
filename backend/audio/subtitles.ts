/**
 * Subtitle cues from timed sentences and clauses, and their SRT and WebVTT
 * files. Cues follow common subtitling practice: at most two lines of 42
 * characters (both configurable), at most 7 seconds, a new cue at a sentence
 * end or a pause unless the next sentence fits on the same line, and lines
 * broken where they come out about even.
 */
import type { TimedUnit } from "./timing";
import { spokenWeight } from "./timing";

export interface Cue { start: number; end: number; lines: string[] }

export interface CueOptions {
  maxLineLength: number;
  maxLines: number;
  /** The longest a cue stays on screen. */
  maxSeconds?: number;
  /** Short cues are kept on screen this long when the next cue leaves room. */
  minSeconds?: number;
}

export const DEFAULT_MAX_LINE_LENGTH = 42;
export const DEFAULT_MAX_LINES = 2;
const DEFAULT_MAX_SECONDS = 7;
const DEFAULT_MIN_SECONDS = 1;
/** A pause this long ends a cue. */
const CUE_BREAK_PAUSE = 0.8;
/** Cues end this long before the next one starts, when they would touch. */
const CUE_GAP = 0.04;

interface Piece { text: string; start: number; end: number; sentenceEnd: boolean }

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** Lines of `text` filled word by word up to `width` characters. */
function fill(parts: readonly string[], width: number): string[] {
  const lines: string[] = [];
  for (const word of parts) {
    const last = lines.at(-1);
    if (last !== undefined && last.length + 1 + word.length <= width) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines;
}

/** Whether `text` wraps into the lines a cue allows. */
function fitsCue(text: string, options: CueOptions): boolean {
  return fill(words(text), options.maxLineLength).length <= options.maxLines;
}

/** Split `parts` into `count` runs of about even length, never splitting a word. */
function evenRuns(parts: readonly string[], count: number): string[] {
  const total = parts.reduce((sum, word) => sum + word.length + 1, -1);
  const target = total / count;
  const runs: string[][] = [[]];
  let length = 0;
  for (const word of parts) {
    const run = runs.at(-1)!;
    if (run.length > 0 && length + word.length / 2 > target * runs.length && runs.length < count) runs.push([word]);
    else run.push(word);
    length += word.length + 1;
  }
  return runs.map((run) => run.join(" "));
}

/** Split a unit that doesn't fit one cue into pieces that do, timed by length. */
function splitUnit(unit: TimedUnit, options: CueOptions, maxSeconds: number): Piece[] {
  const parts = words(unit.text);
  const duration = unit.end - unit.start;
  let count = Math.max(Math.ceil(unit.text.length / (options.maxLineLength * options.maxLines)), Math.ceil(duration / maxSeconds), 1);
  let texts = evenRuns(parts, count);
  // Word lengths can make an even piece one line too long: use more pieces until each fits.
  while (count < parts.length && texts.some((text) => !fitsCue(text, options))) texts = evenRuns(parts, ++count);
  if (texts.length === 1) return [{ ...unit }];
  const weights = texts.map(spokenWeight);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let position = 0;
  return texts.map((text, index) => {
    const start = unit.start + (duration * position) / total;
    position += weights[index]!;
    const end = unit.start + (duration * position) / total;
    return { text, start, end, sentenceEnd: unit.sentenceEnd && index === texts.length - 1 };
  });
}

/** Lines of at most `maxLength` characters (longer only for a longer word), as even as possible. */
export function wrapLines(text: string, maxLength: number, maxLines: number): string[] {
  const parts = words(text);
  const joined = parts.join(" ");
  if (joined.length <= maxLength || maxLines === 1) return [joined];
  // The narrowest width that still fits the lines allowed, so the lines come out even.
  const longestWord = Math.max(...parts.map((word) => word.length));
  let low = Math.max(longestWord, Math.ceil(joined.length / maxLines));
  let high = Math.max(low, maxLength);
  if (fill(parts, high).length > maxLines) return fill(parts, maxLength);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (fill(parts, middle).length <= maxLines) high = middle;
    else low = middle + 1;
  }
  return fill(parts, low);
}

export function buildCues(units: readonly TimedUnit[], options: CueOptions): Cue[] {
  const maxSeconds = options.maxSeconds ?? DEFAULT_MAX_SECONDS;
  const minSeconds = options.minSeconds ?? DEFAULT_MIN_SECONDS;
  const pieces = units.flatMap((unit) => splitUnit(unit, options, maxSeconds));

  const groups: Piece[][] = [];
  for (const piece of pieces) {
    const group = groups.at(-1);
    const previous = group?.at(-1);
    if (group && previous) {
      const text = `${group.map((part) => part.text).join(" ")} ${piece.text}`;
      const pause = piece.start - previous.end;
      const fits = fitsCue(text, options) && piece.end - group[0]!.start <= maxSeconds && pause < CUE_BREAK_PAUSE;
      // After a sentence, start a new cue unless both fit on one line.
      const sameCue = fits && (!previous.sentenceEnd || (text.length <= options.maxLineLength && pause < 0.3));
      if (sameCue) {
        group.push(piece);
        continue;
      }
    }
    groups.push([piece]);
  }

  const cues: Cue[] = groups.map((group) => ({
    start: group[0]!.start,
    end: group.at(-1)!.end,
    lines: wrapLines(group.map((part) => part.text).join(" "), options.maxLineLength, options.maxLines),
  }));
  // Keep short cues up a little longer, and never let a cue overlap the next.
  cues.forEach((cue, index) => {
    const next = cues[index + 1];
    const limit = next ? next.start - CUE_GAP : Number.POSITIVE_INFINITY;
    if (cue.end - cue.start < minSeconds) cue.end = Math.min(cue.start + minSeconds, Math.max(cue.end, limit));
    if (cue.end > limit) cue.end = Math.max(cue.start + 0.01, limit);
  });
  return cues;
}

function timestamp(seconds: number, separator: "," | "."): string {
  const total = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const secs = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}${separator}${pad(millis, 3)}`;
}

export function formatSrt(cues: readonly Cue[]): string {
  return cues.map((cue, index) => `${index + 1}\n${timestamp(cue.start, ",")} --> ${timestamp(cue.end, ",")}\n${cue.lines.join("\n")}\n`).join("\n");
}

/** WebVTT cue text: `&`, `<` and `>` are markup there, and `-->` ends a cue's timing line. */
function vttText(line: string): string {
  return line.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function formatVtt(cues: readonly Cue[]): string {
  const body = cues.map((cue) => `${timestamp(cue.start, ".")} --> ${timestamp(cue.end, ".")}\n${cue.lines.map(vttText).join("\n")}\n`).join("\n");
  return body ? `WEBVTT\n\n${body}` : "WEBVTT\n";
}
