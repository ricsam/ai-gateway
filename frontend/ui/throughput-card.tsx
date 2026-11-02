import { useMemo, useState } from "react";
import { IconArrowDown, IconArrowUp, IconArrowsSort } from "@tabler/icons-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatActiveHours, formatPeakMinute, formatThroughput } from "../lib/throughput-format";

// Mirrors backend/throughput-stats.ts, which documents each field.
export interface ThroughputStatsRow {
  requests: number; tokens: number; activeHours: number;
  steadyStateTpm: number; steadyStateRpm: number;
  peakTpm: number; peakTpmAt: string | null; peakRpm: number; peakRpmAt: string | null;
  avgInputTokensPerRequest: number; avgOutputTokensPerRequest: number; avgCacheReadTokensPerRequest: number;
}
export interface ModelThroughputRow extends ThroughputStatsRow { model: string | null }
export interface ThroughputData { start: string; end: string; summary: ThroughputStatsRow; models: ModelThroughputRow[] }

type SortKey = "model" | "requests" | "steadyStateTpm" | "peakTpm" | "steadyStateRpm" | "peakRpm" | "avgInputTokensPerRequest" | "avgOutputTokensPerRequest";
const columns: Array<{ key: SortKey; label: string; title?: string; format: (row: ModelThroughputRow) => string }> = [
  { key: "model", label: "Model", format: (row) => row.model ?? "Unknown model" },
  { key: "requests", label: "Requests", format: (row) => row.requests.toLocaleString() },
  { key: "steadyStateTpm", label: "Steady TPM", title: "Steady-state tokens per minute", format: (row) => formatThroughput(row.steadyStateTpm) },
  { key: "peakTpm", label: "Peak TPM", title: "Peak tokens per minute", format: (row) => formatThroughput(row.peakTpm) },
  { key: "steadyStateRpm", label: "Steady RPM", title: "Steady-state requests per minute", format: (row) => formatThroughput(row.steadyStateRpm) },
  { key: "peakRpm", label: "Peak RPM", title: "Peak requests per minute", format: (row) => formatThroughput(row.peakRpm) },
  { key: "avgInputTokensPerRequest", label: "Avg input", title: "Average input tokens per request, including cache writes", format: (row) => formatThroughput(row.avgInputTokensPerRequest) },
  { key: "avgOutputTokensPerRequest", label: "Avg output", title: "Average output tokens per request", format: (row) => formatThroughput(row.avgOutputTokensPerRequest) },
];

function Stat({ label, title, value, caption, loading }: { label: string; title: string; value: string; caption?: string | null; loading?: boolean }) {
  return <div className="border-l pl-4" title={title}>
    <p className="text-xs text-muted-foreground">{label}</p>
    {loading ? <Skeleton className="mt-2 h-7 w-24" /> : <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>}
    {!loading && caption && <p className="mt-1 text-xs text-muted-foreground">{caption}</p>}
  </div>;
}

function ModelThroughputTable({ models }: { models: ModelThroughputRow[] }) {
  // Without a selection, keep the API order: most tokens first.
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean } | null>(null);
  const rows = useMemo(() => sort ? [...models].sort((a, b) => {
    const value = sort.key === "model" ? (a.model ?? "").localeCompare(b.model ?? "") : a[sort.key] - b[sort.key];
    return sort.asc ? value : -value;
  }) : models, [models, sort]);
  return <Table>
    <TableHeader><TableRow>{columns.map((column) => <TableHead key={column.key} title={column.title} aria-sort={sort?.key === column.key ? (sort.asc ? "ascending" : "descending") : undefined} className={column.key === "model" ? "cursor-pointer" : "cursor-pointer text-right"} onClick={() => setSort(sort?.key === column.key ? { key: column.key, asc: !sort.asc } : { key: column.key, asc: column.key === "model" })}>
      {column.label}{sort?.key === column.key ? (sort.asc ? <IconArrowUp className="inline" size={14} /> : <IconArrowDown className="inline" size={14} />) : <IconArrowsSort className="inline opacity-30" size={14} />}
    </TableHead>)}</TableRow></TableHeader>
    <TableBody>{rows.map((row) => <TableRow key={row.model ?? "\u0000unknown"}>{columns.map((column) => <TableCell key={column.key} className={column.key === "model" ? "font-mono" : "text-right font-mono tabular-nums"}>{column.format(row)}</TableCell>)}</TableRow>)}</TableBody>
  </Table>;
}

export function ThroughputCard({ data, isLoading, isError, description = "Per-minute load in the selected range: the figures a Bedrock quota increase request asks for." }: { data?: ThroughputData; isLoading?: boolean; isError?: boolean; description?: string }) {
  const summary = data?.summary;
  const loading = Boolean(isLoading || (!summary && !isError));
  const value = (pick: (stats: ThroughputStatsRow) => number) => summary ? formatThroughput(pick(summary)) : "—";
  const activeHours = summary ? formatActiveHours(summary.activeHours) : null;
  const peakAt = (at: string | null) => { const minute = formatPeakMinute(at); return minute ? `Busiest minute: ${minute}` : null; };
  const cacheReads = summary?.avgCacheReadTokensPerRequest ? `; excludes ${formatThroughput(summary.avgCacheReadTokensPerRequest)} cache reads` : "";
  return <Card>
    <CardHeader>
      <CardTitle>Throughput</CardTitle>
      <CardDescription>{description}</CardDescription>
    </CardHeader>
    <CardContent className="space-y-6">
      {isError ? <p className="py-6 text-center text-sm text-destructive">Throughput statistics could not be loaded.</p> : <>
        {/* Column-major on wider screens: steady state, peak, then per-request averages. */}
        <div className="grid gap-x-6 gap-y-5 sm:grid-flow-col sm:grid-cols-3 sm:grid-rows-2">
          <Stat loading={loading} label="Steady state TPM" title="Steady-state tokens per minute" value={value((s) => s.steadyStateTpm)} caption={activeHours} />
          <Stat loading={loading} label="Steady state RPM" title="Steady-state requests per minute" value={value((s) => s.steadyStateRpm)} caption={activeHours} />
          <Stat loading={loading} label="Peak TPM" title="Peak tokens per minute" value={value((s) => s.peakTpm)} caption={summary && peakAt(summary.peakTpmAt)} />
          <Stat loading={loading} label="Peak RPM" title="Peak requests per minute" value={value((s) => s.peakRpm)} caption={summary && peakAt(summary.peakRpmAt)} />
          <Stat loading={loading} label="Avg input tokens / request" title="Average input tokens per request" value={value((s) => s.avgInputTokensPerRequest)} caption={summary?.requests ? `Uncached input plus cache writes${cacheReads}` : null} />
          <Stat loading={loading} label="Avg output tokens / request" title="Average output tokens per request" value={value((s) => s.avgOutputTokensPerRequest)} caption={summary?.requests ? "Includes reasoning tokens" : null} />
        </div>
        {loading ? <Skeleton className="h-32 w-full" /> : data?.models.length ? <ModelThroughputTable models={data.models} /> : <p className="py-6 text-center text-sm text-muted-foreground">No requests in this range</p>}
        <p className="text-xs text-muted-foreground">Steady state averages the one-hour periods of the range that had requests; peak is the busiest calendar minute. Tokens are input, cache writes and output, as Bedrock counts them toward tokens-per-minute quotas: cache reads are excluded. Bedrock also counts output tokens several times for some models (output burndown, for example 5× for many Claude models), which these figures do not include.</p>
      </>}
    </CardContent>
  </Card>;
}
