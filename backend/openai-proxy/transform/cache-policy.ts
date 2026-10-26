/** Cache checkpoints are evaluated in tools -> system -> messages order. */
export type CacheTtl = "5m" | "1h";

interface CacheSection {
  /** TTLs of caller-supplied checkpoints, in prompt order. Omission means 5m. */
  existing: Array<CacheTtl | undefined>;
  /** Whether this section needs a checkpoint at its end. */
  needsCheckpoint: boolean;
  preferredTtl: CacheTtl;
}

/**
 * Fill missing section boundaries without exceeding the four-checkpoint limit
 * or putting a longer TTL after a shorter one. Never rewrite caller markers.
 * Requests already over the limit or with invalid TTL ordering remain the
 * provider's responsibility; managed caching must not compound the problem.
 */
export function planCachePoints(sections: CacheSection[]): Array<CacheTtl | undefined> {
  let available = 4 - sections.reduce((count, section) => count + section.existing.length, 0);
  let remainingLongSections = sections.filter((section) => section.existing.includes("1h")).length;
  let seenShortTtl = false;
  return sections.map((section) => {
    if (section.existing.includes("1h")) remainingLongSections--;
    seenShortTtl ||= section.existing.some((ttl) => ttl !== "1h");
    const laterLongTtl = remainingLongSections > 0;
    if (!section.needsCheckpoint || available <= 0 || (seenShortTtl && laterLongTtl)) return undefined;

    const ttl = seenShortTtl ? "5m" : laterLongTtl ? "1h" : section.preferredTtl;
    available--;
    seenShortTtl ||= ttl === "5m";
    return ttl;
  });
}
