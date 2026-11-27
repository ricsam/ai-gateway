/**
 * Times a chunk's transcript. The gateway knows where the chunk has speech
 * and where it pauses (from the audio), and the model usually says roughly
 * when each segment starts and ends. The transcript is split into sentences
 * and clauses, and their boundaries are aligned to the speech: each boundary
 * sits in a pause or between words, chosen so that every stretch of text gets
 * about the speaking time its length needs, pauses inside sentences are rare,
 * and boundaries are near where the model put them.
 */
import type { TimeRange } from "./speech";

export interface TextUnit {
  text: string;
  /** The unit ends a sentence. */
  sentenceEnd: boolean;
}

export interface TimedUnit extends TextUnit, TimeRange {}

/** Clauses shorter than this stay with their neighbor. */
const MIN_CLAUSE_CHARS = 16;

const SENTENCE_END = /[.!?…。！？](["'”’»)\]]*)$/u;

/** Words whose period doesn't end a sentence: list numbers, initials and common abbreviations. */
const NOT_A_SENTENCE_END = /^(?:\d{1,3}|\p{L}|mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|no|nr|ca|approx|fig|vol|z\.b|d\.h|bzw|usw|ex|t\.ex|bl\.a|osv)\.$/iu;

/** Split a line into sentences at end punctuation followed by a space, or after CJK end punctuation. */
function sentencesOf(line: string): string[] {
  const sentences: string[] = [];
  let current = "";
  for (const word of line.split(/\s+/).filter(Boolean)) {
    current = current ? `${current} ${word}` : word;
    const ends = SENTENCE_END.test(word) && !NOT_A_SENTENCE_END.test(word.replace(/["'”’»)\]]+$/u, ""));
    if (ends) {
      sentences.push(current);
      current = "";
    }
  }
  if (current) sentences.push(current);
  return sentences.flatMap((sentence) => sentence.split(/(?<=[。！？])/u)).map((part) => part.trim()).filter(Boolean);
}

/** Split a transcript into sentences, and long sentences into clauses. */
export function splitUnits(text: string): TextUnit[] {
  const units: TextUnit[] = [];
  for (const line of text.split(/\n+/)) {
    const sentences = sentencesOf(line);
    sentences.forEach((sentence, index) => {
      const clauses = sentence.trim().split(/(?<=[,;:，；：])\s+|\s+(?=[–—]\s)/u).map((part) => part.trim()).filter(Boolean);
      // Join clauses too short to time on their own to the clause before them.
      const merged: string[] = [];
      for (const clause of clauses) {
        const last = merged.at(-1);
        if (last !== undefined && (last.length < MIN_CLAUSE_CHARS || clause.length < MIN_CLAUSE_CHARS)) merged[merged.length - 1] = `${last} ${clause}`;
        else merged.push(clause);
      }
      merged.forEach((clause, clauseIndex) => {
        const last = clauseIndex === merged.length - 1;
        units.push({ text: clause, sentenceEnd: last && (SENTENCE_END.test(clause) || index === sentences.length - 1) });
      });
    });
  }
  return units;
}

/** How long a piece of text takes to say, relative to others: letters, and more for digits. */
export function spokenWeight(text: string): number {
  let weight = 0;
  for (const character of text) {
    if (/\p{N}/u.test(character)) weight += 2.5;
    else if (/\p{L}/u.test(character)) weight += 1;
  }
  return Math.max(weight, 1);
}

/** Speaking time over the regions: converts between seconds of speech and seconds in the file. */
class SpeechClock {
  constructor(private readonly regions: readonly TimeRange[]) {}

  /** The time at which `speech` seconds of speech have passed. */
  timeAt(speech: number): number {
    let remaining = speech;
    for (const region of this.regions) {
      const length = region.end - region.start;
      if (remaining <= length) return region.start + remaining;
      remaining -= length;
    }
    return this.regions.at(-1)?.end ?? 0;
  }

  /** The seconds of speech before `time`. */
  speechAt(time: number): number {
    let speech = 0;
    for (const region of this.regions) {
      if (time <= region.start) break;
      speech += Math.min(time, region.end) - region.start;
    }
    return speech;
  }
}

// Alignment costs. A stretch of text spoken at 1.4 times or 0.7 times the
// chunk's average pace costs about as much as one boundary between words.
const PACE_COST = 2;
const SENTENCE_BETWEEN_WORDS_COST = 1;
const CLAUSE_BETWEEN_WORDS_COST = 0.25;
/** Per second of pause (counted up to one) inside a sentence or clause. */
const PAUSE_INSIDE_COST = 1.2;
/**
 * Per second between a boundary and where the model put it, counted up to one:
 * the models' timestamps are usually within a few tenths of a second, but now
 * and then a few in a row are seconds off, and then pace and pauses decide.
 */
const MODEL_DISTANCE_COST = 0.6;

interface Node { start: number; end: number; speech: number }

/**
 * Time the units of one chunk's transcript over its speech regions (seconds
 * from the start of the file). `hints[j]` is where the model put the boundary
 * after unit j, if it did. `start` and `end` bound the speech the units cover.
 */
export function alignUnits(
  units: readonly TextUnit[],
  regions: readonly TimeRange[],
  options: { hints?: ReadonlyArray<number | undefined>; start?: number; end?: number } = {},
): TimedUnit[] {
  if (units.length === 0 || regions.length === 0) return [];
  const clock = new SpeechClock(regions);
  const first = options.start ?? regions[0]!.start;
  const last = Math.max(options.end ?? regions.at(-1)!.end, first);
  const hint = (boundary: number) => options.hints?.[boundary];

  // Nodes a boundary can sit at: the start, every pause between the start and the end, the end.
  const nodes: Node[] = [{ start: first, end: first, speech: clock.speechAt(first) }];
  for (let index = 1; index < regions.length; index++) {
    const start = regions[index - 1]!.end;
    const end = regions[index]!.start;
    if (start > first && end < last) nodes.push({ start, end, speech: clock.speechAt(start) });
  }
  nodes.push({ start: last, end: last, speech: clock.speechAt(last) });

  const n = units.length;
  const lastNode = nodes.length - 1;
  const weights = units.map((unit) => spokenWeight(unit.text));
  const weightBefore = [0];
  for (const weight of weights) weightBefore.push(weightBefore.at(-1)! + weight);
  const freeBefore = [0];
  for (let unit = 0; unit < n; unit++) {
    freeBefore.push(freeBefore.at(-1)! + (units[unit]!.sentenceEnd ? SENTENCE_BETWEEN_WORDS_COST : CLAUSE_BETWEEN_WORDS_COST));
  }
  const pauseBefore = [0];
  for (const node of nodes) pauseBefore.push(pauseBefore.at(-1)! + PAUSE_INSIDE_COST * Math.min(node.end - node.start, 1));
  const totalSpeech = nodes[lastNode]!.speech - nodes[0]!.speech;
  const secondsPerWeight = totalSpeech / weightBefore[n]!;

  // cost[j][k]: units 0..j-1 timed, the boundary after unit j-1 at node k.
  const maxUnits = Math.max(8, Math.ceil((3 * n) / nodes.length));
  const maxNodes = Math.max(12, Math.ceil((3 * nodes.length) / n));
  const cost = Array.from({ length: n + 1 }, () => new Float64Array(nodes.length).fill(Number.POSITIVE_INFINITY));
  const from = Array.from({ length: n + 1 }, () => new Int32Array(nodes.length * 2).fill(-1));
  cost[0]![0] = 0;
  for (let j = 0; j < n; j++) {
    for (let k = 0; k < lastNode; k++) {
      const base = cost[j]![k]!;
      if (!Number.isFinite(base)) continue;
      for (let nextUnit = j + 1; nextUnit <= Math.min(n, j + maxUnits); nextUnit++) {
        const end = nextUnit === n;
        for (let nextNode = k + 1; nextNode <= (end ? lastNode : Math.min(lastNode - 1, k + maxNodes)); nextNode++) {
          if (end && nextNode !== lastNode) continue;
          const actual = Math.max(nodes[nextNode]!.speech - nodes[k]!.speech, 0.05);
          const expected = Math.max((weightBefore[nextUnit]! - weightBefore[j]!) * secondsPerWeight, 0.05);
          let step = PACE_COST * Math.abs(Math.log(actual / expected));
          step += freeBefore[nextUnit - 1]! - freeBefore[j]!; // boundaries between words inside the group
          step += pauseBefore[nextNode]! - pauseBefore[k + 1]!; // pauses inside the group
          const modelTime = end ? undefined : hint(nextUnit - 1);
          if (modelTime !== undefined) {
            const node = nodes[nextNode]!;
            step += MODEL_DISTANCE_COST * Math.min(Math.abs(modelTime - (node.start + node.end) / 2), 1);
          }
          if (base + step < cost[nextUnit]![nextNode]!) {
            cost[nextUnit]![nextNode] = base + step;
            from[nextUnit]![nextNode * 2] = j;
            from[nextUnit]![nextNode * 2 + 1] = k;
          }
        }
      }
    }
  }

  // Walk back: the boundaries that sit in pauses, and the groups between them.
  const ends = new Array<number>(n);
  const starts = new Array<number>(n);
  let j = n;
  let k = lastNode;
  if (!Number.isFinite(cost[n]![lastNode]!)) {
    // No consistent path (it can't happen with the limits above): time by length alone.
    j = 0;
    k = 0;
  }
  const groups: Array<{ firstUnit: number; lastUnit: number; from: Node; to: Node }> = [];
  while (j > 0) {
    const previousUnit = from[j]![k * 2]!;
    const previousNode = from[j]![k * 2 + 1]!;
    groups.unshift({ firstUnit: previousUnit, lastUnit: j - 1, from: nodes[previousNode]!, to: nodes[k]! });
    j = previousUnit;
    k = previousNode;
  }
  if (groups.length === 0) groups.push({ firstUnit: 0, lastUnit: n - 1, from: nodes[0]!, to: nodes[lastNode]! });

  for (const group of groups) {
    starts[group.firstUnit] = group.from.end;
    ends[group.lastUnit] = group.to.start;
    // Boundaries between words: where the model put them if that is inside the group, else by length.
    const speechFrom = group.from.speech;
    const speechTo = group.to.speech;
    const groupWeight = weightBefore[group.lastUnit + 1]! - weightBefore[group.firstUnit]!;
    let previous = group.from.end;
    for (let unit = group.firstUnit; unit < group.lastUnit; unit++) {
      const share = (weightBefore[unit + 1]! - weightBefore[group.firstUnit]!) / groupWeight;
      let time = clock.timeAt(speechFrom + (speechTo - speechFrom) * share);
      const modelTime = hint(unit);
      // A model time near the even-pace estimate is the better guess between words.
      if (modelTime !== undefined && Math.abs(modelTime - time) <= 1 && modelTime > previous && modelTime < group.to.start) time = modelTime;
      time = Math.min(Math.max(time, previous), group.to.start);
      ends[unit] = time;
      starts[unit + 1] = time;
      previous = time;
    }
  }
  return units.map((unit, index) => ({ ...unit, start: starts[index]!, end: Math.max(ends[index]!, starts[index]!) }));
}

/** The region edge nearest to `time` within `reach` seconds, else `time`; `fallback` without a time. */
function nearestEdge(edges: readonly number[], time: number | undefined, fallback: number, reach = 1): number {
  if (time === undefined) return fallback;
  let best: number | undefined;
  let distance = reach;
  for (const edge of edges) {
    if (Math.abs(edge - time) <= distance) { best = edge; distance = Math.abs(edge - time); }
  }
  return best ?? time;
}

/**
 * Time a chunk's transcript. The model's segments (timestamps in seconds from
 * the start of the chunk's audio, which starts at `chunk.start`) give hints:
 * between two segments, where one ends and the next starts.
 */
export function timeTranscript(
  transcript: { text: string; segments?: ReadonlyArray<{ start?: number; end?: number; text: string }> },
  chunk: TimeRange & { regions: readonly TimeRange[] },
): TimedUnit[] {
  const regions = chunk.regions;
  if (regions.length === 0) return [];
  if (!transcript.segments?.length) return alignUnits(splitUnits(transcript.text), regions);

  const absolute = (time: number | undefined) => (time === undefined ? undefined : chunk.start + time);
  const segments = transcript.segments.map((segment, index, all) => ({
    units: splitUnits(segment.text),
    start: absolute(segment.start),
    end: absolute(segment.end ?? all[index + 1]?.start),
  })).filter((segment) => segment.units.length > 0);
  const units = segments.flatMap((segment) => segment.units);
  const hints: Array<number | undefined> = [];
  segments.forEach((segment, index) => {
    for (let unit = 0; unit < segment.units.length - 1; unit++) hints.push(undefined);
    const next = segments[index + 1];
    if (!next) return;
    const times = [segment.end, next.start].filter((time): time is number => time !== undefined);
    hints.push(times.length ? times.reduce((sum, time) => sum + time, 0) / times.length : undefined);
  });
  const start = Math.max(chunk.start, nearestEdge(regions.map((region) => region.start), segments[0]?.start, regions[0]!.start));
  const end = Math.min(chunk.end, nearestEdge(regions.map((region) => region.end), segments.at(-1)?.end, regions.at(-1)!.end));
  return alignUnits(units, regions, { hints, start, end: Math.max(end, start) });
}

export interface Segment extends TimeRange { text: string }

/** Join timed units into sentences, at most `maxSeconds` long. */
export function segmentsOf(units: readonly TimedUnit[], maxSeconds = 30): Segment[] {
  const segments: Segment[] = [];
  let current: Segment | undefined;
  for (const unit of units) {
    if (current && unit.end - current.start > maxSeconds) {
      segments.push(current);
      current = undefined;
    }
    if (!current) current = { start: unit.start, end: unit.end, text: unit.text };
    else {
      current.end = unit.end;
      current.text = `${current.text} ${unit.text}`;
    }
    if (unit.sentenceEnd) {
      segments.push(current);
      current = undefined;
    }
  }
  if (current) segments.push(current);
  return segments;
}
