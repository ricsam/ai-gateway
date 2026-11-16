import { UsageError } from "./errors";
import type { Io } from "./io";
import { terminalSafe } from "./text";

export const OUTPUT_FORMATS = ["table", "wide", "json"] as const;
export type OutputFormat = typeof OUTPUT_FORMATS[number];

export function parseOutputFormat(value: string | undefined): OutputFormat {
  if (value === undefined) return "table";
  if ((OUTPUT_FORMATS as readonly string[]).includes(value)) return value as OutputFormat;
  throw new UsageError(`--output must be one of ${OUTPUT_FORMATS.join(", ")}`);
}

export interface Column<T> {
  header: string;
  value: (row: T) => unknown;
  /** Only shown with -o wide. */
  wide?: boolean;
  align?: "left" | "right";
  /** Longer cells are cut with … in the table format; -o wide shows them whole. */
  maxWidth?: number;
}

const width = (text: string) => Bun.stringWidth(text);

export { terminalSafe };

function truncate(text: string, maxWidth: number): string {
  if (width(text) <= maxWidth) return text;
  let result = "";
  for (const character of text) {
    if (width(result + character) > maxWidth - 1) break;
    result += character;
  }
  return `${result}…`;
}

/** Renders a cell value: absent values as -, booleans as yes/no, dates as ISO 8601 UTC without milliseconds. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (value instanceof Date) return formatTime(value.toISOString());
  if (Array.isArray(value)) return value.length ? value.map(formatValue).join(", ") : "-";
  if (typeof value === "object") return terminalSafe(JSON.stringify(value));
  return terminalSafe(String(value).replace(/[\r\n\t]+/g, " "));
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().replace(/\.\d{3}Z$/, "Z") : value;
}

export function formatCredits(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `$${value.toFixed(digits)}`;
}

export function formatInteger(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return Math.round(value).toLocaleString("en-US");
}

export function formatDecimal(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function renderTable<T>(rows: readonly T[], columns: readonly Column<T>[], wide = false): string {
  const shown = columns.filter((column) => wide || !column.wide);
  const cells = rows.map((row) => shown.map((column) => {
    const text = formatValue(column.value(row));
    return column.maxWidth && !wide ? truncate(text, column.maxWidth) : text;
  }));
  const widths = shown.map((column, index) => Math.max(width(column.header), ...cells.map((line) => width(line[index]!))));
  const pad = (text: string, index: number) => {
    const fill = " ".repeat(widths[index]! - width(text));
    return shown[index]!.align === "right" ? fill + text : text + fill;
  };
  const lines = [shown.map((column, index) => pad(column.header, index)), ...cells.map((line) => line.map(pad))];
  return lines.map((line) => line.join("   ").trimEnd()).join("\n") + "\n";
}

/** Renders label: value lines, aligned. */
export function renderDetails(entries: ReadonlyArray<readonly [string, unknown]>): string {
  const labelWidth = Math.max(...entries.map(([label]) => width(label))) + 2;
  return entries.map(([label, value]) => {
    const text = typeof value === "string" && value.includes("\n") ? terminalSafe(value) : formatValue(value);
    const prefix = `${label}:`.padEnd(labelWidth);
    return `${prefix}${text.replaceAll("\n", `\n${" ".repeat(labelWidth)}`)}`.trimEnd();
  }).join("\n") + "\n";
}

export function printJson(io: Io, value: unknown): void {
  // JSON.stringify escapes C0 controls but not DEL, C1 or bidirectional overrides;
  // those can only occur inside strings, where \uXXXX means the same character.
  io.out(`${terminalSafe(JSON.stringify(value, null, 2) ?? "null")}\n`);
}

/** Prints rows as a table, or JSON with -o json; an empty list prints a note on stderr. */
export function printList<T>(io: Io, format: OutputFormat, rows: readonly T[], columns: readonly Column<T>[], empty: string, json: unknown = rows): void {
  if (format === "json") return printJson(io, json);
  if (!rows.length) { io.err(`${empty}\n`); return; }
  io.out(renderTable(rows, columns, format === "wide"));
}
