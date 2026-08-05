import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { IconRefresh } from "@tabler/icons-react";
export type TimeRange = "hour" | "day" | "week" | "month" | "quarter" | "year";
export type BucketSize = "15s" | "1m" | "5m" | "30m" | "1h" | "1d" | "1w" | "1mo";
export const ALLOWED_BUCKETS: Record<TimeRange, { allowed: BucketSize[]; default: BucketSize }> = {
  hour: { allowed: ["15s", "1m", "5m"], default: "5m" }, day: { allowed: ["5m", "30m", "1h"], default: "1h" },
  week: { allowed: ["1d"], default: "1d" }, month: { allowed: ["1d", "1w"], default: "1d" }, quarter: { allowed: ["1w"], default: "1w" }, year: { allowed: ["1mo"], default: "1mo" },
};
const rangeLabels: Record<TimeRange, string> = { hour: "Hour", day: "Day", week: "Week", month: "Month", quarter: "Quarter", year: "Year" };
const bucketLabels: Record<BucketSize, string> = { "15s": "15 seconds", "1m": "1 minute", "5m": "5 minutes", "30m": "30 minutes", "1h": "1 hour", "1d": "1 day", "1w": "1 week", "1mo": "1 month" };
export function AnalyticsControls({ timeRange, onTimeRangeChange, bucketSize, onBucketSizeChange, showBucketSize = true, onRefresh }: { timeRange: TimeRange; onTimeRangeChange: (value: TimeRange) => void; bucketSize?: BucketSize; onBucketSizeChange?: (value: BucketSize) => void; showBucketSize?: boolean; onRefresh?: () => void }) {
  return <div className="flex flex-wrap items-end gap-3"><div className="space-y-1"><label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Range</label><Select value={timeRange} onValueChange={(value) => onTimeRangeChange(value as TimeRange)}><SelectTrigger className="min-w-28"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(rangeLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></div>{showBucketSize && bucketSize && onBucketSizeChange && <div className="space-y-1"><label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Interval</label><Select value={bucketSize} onValueChange={(value) => onBucketSizeChange(value as BucketSize)}><SelectTrigger className="min-w-32"><SelectValue /></SelectTrigger><SelectContent>{ALLOWED_BUCKETS[timeRange].allowed.map((value) => <SelectItem key={value} value={value}>{bucketLabels[value]}</SelectItem>)}</SelectContent></Select></div>}{onRefresh && <Button variant="outline" size="icon" onClick={onRefresh} title="Refresh analytics data"><IconRefresh /></Button>}</div>;
}
