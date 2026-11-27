import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBucketTime, type TimeScale } from "../lib/analytics-time";
export const formatCurrency = (value: number) => `$${value.toFixed(2)}`;
export const formatTokenCount = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}K` : String(value);

// Last 30 days at a 1-day interval, the default preferences.
const DEFAULT_SCALE: TimeScale = { durationMs: 30 * 24 * 60 * 60 * 1000, bucketSize: "1d" };
// --chart-1 to --chart-7 in styles.css: a palette of distinct hues, not shades of one.
const PALETTE_SIZE = 7;
export const OTHER_SERIES_COLOR = "var(--chart-other)";

/** Colour of the index-th series: the theme's palette, then hues a golden angle apart. */
export function seriesColor(index: number): string {
  if (index < PALETTE_SIZE) return `var(--chart-${index + 1})`;
  return `oklch(0.68 0.13 ${Math.round((index * 137.508) % 360)})`;
}

function Empty({ loading }: { loading?: boolean }) {
  return loading ? <Skeleton className="h-[250px] w-full" /> : <div className="grid h-[250px] place-items-center text-sm text-muted-foreground">No data available</div>;
}

function timeAxis(scale: TimeScale) {
  const format = (value: unknown) => formatBucketTime(String(value), scale);
  return { tick: format, label: format };
}

const money: ChartConfig = { value: { label: "Credits", color: seriesColor(0) } };

/** Balance after each bucket. currentBalance, when given, is drawn as a dashed line: only for windows ending now. */
export function BalanceBurndownChart({ data, currentBalance, scale = DEFAULT_SCALE, isLoading }: { data: { time: string; balance: number }[]; currentBalance?: number; scale?: TimeScale; isLoading?: boolean }) {
  if (isLoading || !data.length) return <Empty loading={isLoading} />;
  const axis = timeAxis(scale);
  return <ChartContainer config={{ balance: money.value! }} className="h-[250px] w-full"><LineChart data={data}><CartesianGrid vertical={false} /><XAxis dataKey="time" tickFormatter={axis.tick} /><YAxis tickFormatter={(v) => `$${v}`} width={55} /><ChartTooltip content={<ChartTooltipContent formatter={(v: unknown) => formatCurrency(Number(v))} labelFormatter={axis.label} />} />{currentBalance !== undefined && <ReferenceLine y={currentBalance} stroke="currentColor" strokeDasharray="4 4" />}<Line dataKey="balance" stroke="var(--color-balance)" dot={false} strokeWidth={2} /></LineChart></ChartContainer>;
}

export function CreditsConsumedChart({ data, scale = DEFAULT_SCALE, isLoading }: { data: { time: string; consumed: number }[]; scale?: TimeScale; isLoading?: boolean }) {
  if (isLoading || !data.length) return <Empty loading={isLoading} />;
  const axis = timeAxis(scale);
  return <ChartContainer config={{ consumed: { label: "Consumed", color: seriesColor(0) } }} className="h-[250px] w-full"><BarChart data={data}><CartesianGrid vertical={false} /><XAxis dataKey="time" tickFormatter={axis.tick} /><YAxis tickFormatter={(v) => `$${v}`} width={55} /><ChartTooltip content={<ChartTooltipContent formatter={(v: unknown) => formatCurrency(Number(v))} labelFormatter={axis.label} />} /><Bar dataKey="consumed" fill="var(--color-consumed)" /></BarChart></ChartContainer>;
}

// Each token kind has its own hue, so small segments of the stacked bars stay recognisable.
const tokenConfig: ChartConfig = {
  inputTokens: { label: "Input", color: seriesColor(0) },
  outputTokens: { label: "Output", color: seriesColor(1) },
  cacheReadTokens: { label: "Cache read", color: seriesColor(2) },
  cacheWrite5mTokens: { label: "Cache write 5m", color: seriesColor(3) },
  cacheWrite1hTokens: { label: "Cache write 1h", color: seriesColor(4) },
};

export function TokensConsumedChart({ data, scale = DEFAULT_SCALE, isLoading }: { data: Array<{ time: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWrite5mTokens: number; cacheWrite1hTokens: number }>; scale?: TimeScale; isLoading?: boolean }) {
  if (isLoading || !data.length) return <Empty loading={isLoading} />;
  const axis = timeAxis(scale);
  return <ChartContainer config={tokenConfig} className="h-[250px] w-full"><BarChart data={data}><CartesianGrid vertical={false} /><XAxis dataKey="time" tickFormatter={axis.tick} /><YAxis tickFormatter={formatTokenCount} width={55} /><ChartTooltip content={<ChartTooltipContent formatter={(v: unknown) => formatTokenCount(Number(v))} labelFormatter={axis.label} />} /><ChartLegend content={<ChartLegendContent />} />{Object.keys(tokenConfig).map((key) => <Bar key={key} dataKey={key} stackId="tokens" fill={`var(--color-${key})`} />)}</BarChart></ChartContainer>;
}

const cacheTokenConfig: ChartConfig = { cacheReadTokens: tokenConfig.cacheReadTokens!, cacheWrite5mTokens: tokenConfig.cacheWrite5mTokens!, cacheWrite1hTokens: tokenConfig.cacheWrite1hTokens! };

export function CacheTokensChart({ data, scale = DEFAULT_SCALE, isLoading }: { data: Array<{ time: string; cacheReadTokens: number; cacheWrite5mTokens: number; cacheWrite1hTokens: number }>; scale?: TimeScale; isLoading?: boolean }) {
  if (isLoading || !data.length) return <Empty loading={isLoading} />;
  const axis = timeAxis(scale);
  return <ChartContainer config={cacheTokenConfig} className="h-[250px] w-full"><BarChart data={data}><CartesianGrid vertical={false} /><XAxis dataKey="time" tickFormatter={axis.tick} /><YAxis tickFormatter={formatTokenCount} width={55} /><ChartTooltip content={<ChartTooltipContent formatter={(v: unknown) => formatTokenCount(Number(v))} labelFormatter={axis.label} />} /><ChartLegend content={<ChartLegendContent />} />{Object.keys(cacheTokenConfig).map((key) => <Bar key={key} dataKey={key} stackId="cacheTokens" fill={`var(--color-${key})`} />)}</BarChart></ChartContainer>;
}

/** One line per series; a series named "Other" (the rest of a top-N) is grey. */
function MultiLine({ series, rows, scale, loading }: { series: string[]; rows: Array<{ time: string; name: string; value: number }>; scale: TimeScale; loading?: boolean }) {
  const colors = useMemo(() => {
    let next = 0;
    return series.map((name) => (name === "Other" ? OTHER_SERIES_COLOR : seriesColor(next++)));
  }, [series]);
  const config = useMemo(() => Object.fromEntries(series.map((name, i) => [name, { label: name, color: colors[i] }])), [series, colors]);
  const data = useMemo(() => { const map = new Map<string, Record<string, string | number>>(); for (const row of rows) { const item = map.get(row.time) ?? { time: row.time }; item[row.name] = row.value; map.set(row.time, item); } return [...map.values()].map((item) => { for (const name of series) item[name] ??= 0; return item; }); }, [rows, series]);
  if (loading || !data.length) return <Empty loading={loading} />;
  const axis = timeAxis(scale);
  return <ChartContainer config={config} className="h-[250px] w-full"><LineChart data={data}><CartesianGrid vertical={false} /><XAxis dataKey="time" tickFormatter={axis.tick} /><YAxis tickFormatter={(v) => `$${v}`} width={55} /><ChartTooltip content={<ChartTooltipContent formatter={(v: unknown) => formatCurrency(Number(v))} labelFormatter={axis.label} />} /><ChartLegend content={<ChartLegendContent />} />{series.map((name, i) => <Line key={name} dataKey={name} stroke={colors[i]} dot={false} strokeWidth={2} />)}</LineChart></ChartContainer>;
}

export function UsageByModelChart({ data, models, scale = DEFAULT_SCALE, isLoading }: { data: { time: string; model: string; consumed: number }[]; models: string[]; scale?: TimeScale; isLoading?: boolean }) {
  return <MultiLine rows={data.map((row) => ({ time: row.time, name: row.model, value: row.consumed }))} series={models} scale={scale} loading={isLoading} />;
}

export function GroupUserBurndownChart({ users, scale = DEFAULT_SCALE, isLoading }: { users: Array<{ userId: string; username: string; data: { time: string; balance: number }[] }>; scale?: TimeScale; isLoading?: boolean }) {
  return <MultiLine rows={users.flatMap((user) => user.data.map((row) => ({ time: row.time, name: user.username, value: row.balance })))} series={users.map((user) => user.username)} scale={scale} loading={isLoading} />;
}
