import { useCallback, useMemo, useState } from "react";
import {
  getBucketOptions,
  getWindowBounds,
  isTimeRange,
  validateCustomTimeRange,
  type AnalyticsWindow,
  type BucketSize,
  type TimeRange,
} from "../../shared/analytics-time-ranges";
import type { TimeScale } from "../lib/analytics-time";

const KEY = "analytics-preferences";

/** A custom window as the API takes it: ISO 8601 instants, the end excluded. */
export interface CustomRange {
  start: string;
  end: string;
}

/** The analytics window and interval, saved for every analytics page. */
export interface AnalyticsPreferences {
  timeRange: TimeRange | "custom";
  /** Set when timeRange is "custom". */
  custom?: CustomRange;
  bucketSize: BucketSize;
}

export function preferenceWindow(preferences: Pick<AnalyticsPreferences, "timeRange" | "custom">): AnalyticsWindow {
  if (preferences.timeRange === "custom" && preferences.custom)
    return { start: new Date(preferences.custom.start), end: new Date(preferences.custom.end) };
  return isTimeRange(preferences.timeRange) ? preferences.timeRange : "month";
}

/** Keeps the interval when the window allows it, else the window's default. */
function withBucket(preferences: Pick<AnalyticsPreferences, "timeRange" | "custom">, bucketSize: unknown): AnalyticsPreferences {
  const options = getBucketOptions(preferenceWindow(preferences));
  const allowed = options.allowed.includes(bucketSize as BucketSize);
  return { ...preferences, bucketSize: allowed ? (bucketSize as BucketSize) : options.default };
}

function customRange(value: unknown): CustomRange | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { start, end } = value as Record<string, unknown>;
  if (typeof start !== "string" || typeof end !== "string") return undefined;
  try {
    validateCustomTimeRange({ start: new Date(start), end: new Date(end) });
    return { start, end };
  } catch {
    return undefined;
  }
}

/** Saved preferences, with defaults for anything missing or no longer valid. */
export function parsePreferences(value: unknown): AnalyticsPreferences {
  const saved = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const custom = saved.timeRange === "custom" ? customRange(saved.custom) : undefined;
  if (custom) return withBucket({ timeRange: "custom", custom }, saved.bucketSize);
  return withBucket({ timeRange: isTimeRange(saved.timeRange) ? saved.timeRange : "month" }, saved.bucketSize);
}

function readSaved(): unknown {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "null");
  } catch {
    return null;
  }
}

export function useAnalyticsPreferences() {
  const [preferences, setPreferences] = useState(() => parsePreferences(readSaved()));
  const update = useCallback((change: (current: AnalyticsPreferences) => AnalyticsPreferences) => {
    setPreferences((current) => {
      const next = change(current);
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);
  const setTimeRange = useCallback((timeRange: TimeRange) => update((current) => withBucket({ timeRange }, current.bucketSize)), [update]);
  const setCustomRange = useCallback(
    (custom: CustomRange) => update((current) => withBucket({ timeRange: "custom", custom }, current.bucketSize)),
    [update],
  );
  const setBucketSize = useCallback((bucketSize: BucketSize) => update((current) => withBucket(current, bucketSize)), [update]);
  return useMemo(() => {
    const window = preferenceWindow(preferences);
    const { start, end } = getWindowBounds(window);
    // Query parameters of the analytics endpoints: the window, and the window with its interval.
    const windowQuery = preferences.custom
      ? { timeRange: "custom" as const, start: preferences.custom.start, end: preferences.custom.end }
      : { timeRange: window as TimeRange };
    const scale: TimeScale = { durationMs: end.getTime() - start.getTime(), bucketSize: preferences.bucketSize };
    return {
      ...preferences,
      window,
      windowQuery,
      query: { ...windowQuery, bucketSize: preferences.bucketSize },
      scale,
      bucketOptions: getBucketOptions(window),
      setTimeRange,
      setCustomRange,
      setBucketSize,
    };
  }, [preferences, setTimeRange, setCustomRange, setBucketSize]);
}

export type AnalyticsPreferencesState = ReturnType<typeof useAnalyticsPreferences>;
