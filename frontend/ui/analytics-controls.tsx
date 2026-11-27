import { useEffect, useId, useState, type ReactNode } from "react";
import { IconRefresh } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  BUCKET_SIZES,
  getWindowBounds,
  TIME_RANGES,
  validateCustomTimeRange,
  type BucketSize,
  type TimeRange,
} from "../../shared/analytics-time-ranges";
import { fromDateTimeLocal, toDateTimeLocal } from "../lib/analytics-time";
import type { AnalyticsPreferencesState, CustomRange } from "./use-analytics-preferences";

const CUSTOM = "custom";
const MINUTE_MS = 60 * 1000;

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

export function AnalyticsControls({
  analytics,
  showBucketSize = true,
  onRefresh,
}: {
  analytics: AnalyticsPreferencesState;
  showBucketSize?: boolean;
  onRefresh?: () => void;
}) {
  const { timeRange, custom, window, bucketSize, bucketOptions, setTimeRange, setCustomRange, setBucketSize } = analytics;
  const chooseRange = (value: string) => {
    if (value !== CUSTOM) return setTimeRange(value as TimeRange);
    if (custom) return;
    // Start from the window on screen, in whole minutes as the inputs show them.
    const { start, end } = getWindowBounds(window);
    setCustomRange({
      start: new Date(Math.floor(start.getTime() / MINUTE_MS) * MINUTE_MS).toISOString(),
      end: new Date(Math.ceil(end.getTime() / MINUTE_MS) * MINUTE_MS).toISOString(),
    });
  };
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field label="Range">
        <Select value={timeRange} onValueChange={chooseRange}>
          <SelectTrigger className="min-w-40" aria-label="Time range">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(TIME_RANGES).map(([value, { label }]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
            <SelectItem value={CUSTOM}>Custom range</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {custom && <CustomRangeFields value={custom} onApply={setCustomRange} />}
      {showBucketSize && (
        <Field label="Interval">
          <Select value={bucketSize} onValueChange={(value) => setBucketSize(value as BucketSize)}>
            <SelectTrigger className="min-w-32" aria-label="Interval">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {bucketOptions.allowed.map((value) => (
                <SelectItem key={value} value={value}>
                  {BUCKET_SIZES[value].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      {onRefresh && (
        <Button variant="outline" size="icon" onClick={onRefresh} title="Refresh analytics data" aria-label="Refresh analytics data">
          <IconRefresh />
        </Button>
      )}
    </div>
  );
}

/** Start and end of a custom window in the browser's time zone; the end is excluded. */
function CustomRangeFields({ value, onApply }: { value: CustomRange; onApply: (range: CustomRange) => void }) {
  const id = useId();
  const [from, setFrom] = useState(() => toDateTimeLocal(new Date(value.start)));
  const [to, setTo] = useState(() => toDateTimeLocal(new Date(value.end)));
  useEffect(() => {
    setFrom(toDateTimeLocal(new Date(value.start)));
    setTo(toDateTimeLocal(new Date(value.end)));
  }, [value.start, value.end]);
  const start = fromDateTimeLocal(from);
  const end = fromDateTimeLocal(to);
  let error: string | null = null;
  if (!start || !end) error = "Enter a start and an end.";
  else {
    try {
      validateCustomTimeRange({ start, end });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "This range is not valid";
      error = `${message.charAt(0).toUpperCase()}${message.slice(1)}.`;
    }
  }
  const changed = !error && (start?.toISOString() !== value.start || end?.toISOString() !== value.end);
  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        if (changed && start && end) onApply({ start: start.toISOString(), end: end.toISOString() });
      }}
    >
      <Field label="From" htmlFor={`${id}-from`}>
        <Input id={`${id}-from`} type="datetime-local" className="w-60 md:w-[13.5rem] dark:scheme-dark" value={from} max={to} onChange={(event) => setFrom(event.target.value)} />
      </Field>
      <Field label="To" htmlFor={`${id}-to`}>
        <Input id={`${id}-to`} type="datetime-local" className="w-60 md:w-[13.5rem] dark:scheme-dark" value={to} min={from} onChange={(event) => setTo(event.target.value)} />
      </Field>
      <Button type="submit" variant="secondary" disabled={!changed}>
        Apply
      </Button>
      {error && (
        <p className="basis-full text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
