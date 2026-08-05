import * as React from "react"
import * as RechartsPrimitive from "recharts"
import { cn } from "@/lib/utils"

const THEMES = { light: "", dark: ".dark" } as const
export type ChartConfig = { [key: string]: { label?: React.ReactNode; icon?: React.ComponentType } & ({ color?: string; theme?: never } | { color?: never; theme: Record<keyof typeof THEMES, string> }) }
const ChartContext = React.createContext<{ config: ChartConfig } | null>(null)
function useChart() { const context = React.useContext(ChartContext); if (!context) throw new Error("useChart must be used within ChartContainer"); return context }

function ChartContainer({ id, className, children, config, ...props }: React.ComponentProps<"div"> & { config: ChartConfig; children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"] }) {
  const uniqueId = React.useId(); const chartId = `chart-${id || uniqueId.replace(/:/g, "")}`
  return <ChartContext.Provider value={{ config }}><div data-chart={chartId} className={cn("[&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line]:stroke-border/50 flex aspect-video justify-center text-xs [&_.recharts-layer]:outline-hidden [&_.recharts-surface]:outline-hidden", className)} {...props}><ChartStyle id={chartId} config={config} /><RechartsPrimitive.ResponsiveContainer>{children}</RechartsPrimitive.ResponsiveContainer></div></ChartContext.Provider>
}
function ChartStyle({ id, config }: { id: string; config: ChartConfig }) {
  const colors = Object.entries(config).filter(([, value]) => value.theme || value.color)
  if (!colors.length) return null
  const css = Object.entries(THEMES).map(([theme, prefix]) => `${prefix} [data-chart=${id}] {\n${colors.map(([key, item]) => { const color = item.theme?.[theme as keyof typeof item.theme] || item.color; return color ? `--color-${key}: ${color};` : "" }).join("\n")}\n}`).join("\n")
  return <style dangerouslySetInnerHTML={{ __html: css }} />
}
const ChartTooltip = RechartsPrimitive.Tooltip
function payloadConfig(config: ChartConfig, item: any, key: string) { const value = item?.payload?.[key] ?? item?.[key]; return typeof value === "string" && config[value] ? config[value] : config[key] }
function ChartTooltipContent({ active, payload, className, label, labelFormatter, formatter, hideLabel = false }: any) {
  const { config } = useChart(); if (!active || !payload?.length) return null
  return <div className={cn("border-border/50 bg-background grid min-w-32 gap-2 rounded-lg border px-3 py-2 text-xs shadow-xl", className)}>
    {!hideLabel && <div className="font-medium">{labelFormatter ? labelFormatter(label, payload) : label}</div>}
    {payload.filter((item: any) => item.type !== "none").map((item: any, index: number) => { const key = String(item.name || item.dataKey || "value"); const itemConfig = payloadConfig(config, item, key); return <div key={`${key}-${index}`} className="flex items-center justify-between gap-4"><span className="flex items-center gap-2 text-muted-foreground"><span className="size-2 rounded-sm" style={{ backgroundColor: item.color }} />{itemConfig?.label ?? item.name}</span><span className="font-mono font-medium">{formatter ? formatter(item.value, item.name, item, index, item.payload) : item.value?.toLocaleString()}</span></div> })}
  </div>
}
const ChartLegend = RechartsPrimitive.Legend
function ChartLegendContent({ payload, className }: any) { const { config } = useChart(); if (!payload?.length) return null; return <div className={cn("flex flex-wrap items-center justify-center gap-4 pt-3", className)}>{payload.filter((item: any) => item.type !== "none").map((item: any) => <div key={item.value} className="flex items-center gap-1.5"><span className="size-2 rounded-sm" style={{ backgroundColor: item.color }} />{config[item.dataKey]?.label ?? item.value}</div>)}</div> }
export { ChartContainer, ChartTooltip, ChartTooltipContent, ChartLegend, ChartLegendContent, ChartStyle }
