import { parseArgs } from "node:util";
import type { ClientOptions, ManagementClient } from "./client";
import { ApiError, CliError, UsageError } from "./errors";
import type { Io } from "./io";
import { parseOutputFormat, type OutputFormat } from "./output";

export type OptionValue = string | boolean | string[] | undefined;

export interface OptionSpec {
  type: "string" | "boolean";
  short?: string;
  multiple?: boolean;
  /** Placeholder shown in help, such as <name>. */
  value?: string;
  description: string;
}

export interface CommandContext {
  /** Positional arguments after the command name. */
  args: string[];
  options: Record<string, OptionValue>;
  output: OutputFormat;
  io: Io;
  /** The full command name, such as "users create", for messages. */
  commandName: string;
  /** The management API client, created on first use. */
  client(): Promise<ManagementClient>;
}

export interface Command {
  name: string;
  summary: string;
  /** Positional arguments in usage notation: <required>, [optional], <variadic>... or [variadic...]. */
  usage?: string;
  /** Paragraphs shown in the command's help. */
  details?: string;
  options?: Record<string, OptionSpec>;
  examples?: string[];
  /** Returns the exit code; defaults to 0. */
  run(context: CommandContext): Promise<number | void>;
}

export interface CommandGroup {
  name: string;
  summary: string;
  details?: string;
  commands: Command[];
}

export type Entry = Command | CommandGroup;

export function isGroup(entry: Entry): entry is CommandGroup {
  return "commands" in entry;
}

export const GLOBAL_OPTIONS: Record<string, OptionSpec> = {
  output: { type: "string", short: "o", value: "<format>", description: "Output format: table (default), wide or json" },
  server: { type: "string", value: "<url>", description: "Use this gateway's management API over HTTP(S) with AI_GATEWAY_MANAGEMENT_KEY instead of the local database" },
  actor: { type: "string", value: "<name>", description: "Your name in the audit log for changes made inside the container (self-reported; default AIGCTL_ACTOR)" },
  help: { type: "boolean", short: "h", description: "Show help" },
};
const GLOBAL_VALUE_FLAGS = new Set(["-o", "--output", "--server", "--actor"]);

export function argumentBounds(usage: string | undefined): { min: number; max: number } {
  const tokens = usage?.trim() ? usage.trim().split(/\s+/) : [];
  let min = 0;
  let max = 0;
  for (const token of tokens) {
    const variadic = token.includes("...");
    if (token.startsWith("<")) min++;
    max = variadic || max === Infinity ? Infinity : max + 1;
  }
  return { min, max };
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

export function suggest(input: string, names: string[]): string {
  const close = names.filter((name) => name.startsWith(input) || editDistance(input, name) <= 2);
  return close.length ? ` Did you mean ${close.map((name) => `'${name}'`).join(" or ")}?` : "";
}

export interface Invocation {
  /** The command path, such as ["users", "list"]. */
  path: string[];
  entry?: Entry;
  command?: Command;
  /** Arguments that are not part of the command path. */
  rest: string[];
}

/** Finds the command path in argv; global options may come before it. */
export function locate(argv: readonly string[], entries: readonly Entry[]): Invocation {
  const pathIndexes: number[] = [];
  let entry: Entry | undefined;
  let command: Command | undefined;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (token === "--") break;
    if (token.startsWith("-") && token !== "-") {
      if (GLOBAL_VALUE_FLAGS.has(token)) index++;
      continue;
    }
    if (!entry) {
      if (token === "help" && !pathIndexes.length) { pathIndexes.push(index); break; }
      entry = entries.find((candidate) => candidate.name === token);
      pathIndexes.push(index);
      if (!entry) break;
      if (!isGroup(entry)) { command = entry; break; }
      continue;
    }
    if (isGroup(entry)) {
      command = entry.commands.find((candidate) => candidate.name === token);
      pathIndexes.push(index);
      break;
    }
  }
  const path = pathIndexes.map((index) => argv[index]!);
  return { path, entry, command, rest: argv.filter((_, index) => !pathIndexes.includes(index)) };
}

export function parseOptions(rest: readonly string[], specs: Record<string, OptionSpec>) {
  const options = Object.fromEntries(Object.entries(specs).map(([name, spec]) => [name, {
    type: spec.type, ...(spec.short ? { short: spec.short } : {}), ...(spec.multiple ? { multiple: true } : {}),
  }]));
  return parseArgs({ args: [...rest], options: options as never, allowPositionals: true, strict: true });
}

function optionLines(specs: Record<string, OptionSpec>): string[] {
  const rows = Object.entries(specs).map(([name, spec]) => [
    `${spec.short ? `-${spec.short}, ` : "    "}--${name}${spec.value ? ` ${spec.value}` : ""}`,
    `${spec.description}${spec.multiple ? " (repeatable)" : ""}`,
  ] as const);
  const width = Math.max(...rows.map(([flag]) => flag.length)) + 3;
  return rows.map(([flag, description]) => `  ${flag.padEnd(width)}${description}`);
}

function wrap(text: string, indent = ""): string {
  return text.split("\n").map((line) => (line ? indent + line : line)).join("\n");
}

export function commandHelp(program: string, path: string[], command: Command): string {
  const lines = [command.summary, "", "Usage:", `  ${program} ${path.join(" ")}${command.usage ? ` ${command.usage}` : ""}${command.options && Object.keys(command.options).length ? " [options]" : ""}`];
  if (command.details) lines.push("", wrap(command.details.trim()));
  if (command.options && Object.keys(command.options).length) lines.push("", "Options:", ...optionLines(command.options));
  if (command.examples?.length) lines.push("", "Examples:", ...command.examples.map((example) => `  ${example}`));
  lines.push("", "Global options:", ...optionLines(GLOBAL_OPTIONS));
  return `${lines.join("\n")}\n`;
}

export function groupHelp(program: string, group: CommandGroup): string {
  const width = Math.max(...group.commands.map((command) => command.name.length)) + 3;
  const lines = [group.summary, "", "Usage:", `  ${program} ${group.name} <command> [options]`];
  if (group.details) lines.push("", wrap(group.details.trim()));
  lines.push("", "Commands:", ...group.commands.map((command) => `  ${command.name.padEnd(width)}${command.summary}`));
  lines.push("", `Run '${program} ${group.name} <command> --help' for a command's arguments and options.`);
  return `${lines.join("\n")}\n`;
}

export interface Program {
  name: string;
  overview: string;
  entries: Entry[];
}

export function programHelp(program: Program): string {
  const width = Math.max(...program.entries.map((entry) => entry.name.length)) + 3;
  return `${program.overview.trim()}

Commands:
${program.entries.map((entry) => `  ${entry.name.padEnd(width)}${entry.summary}`).join("\n")}

Global options:
${optionLines(GLOBAL_OPTIONS).join("\n")}

Run '${program.name} <command> --help' for a command's subcommands and options.
`;
}

export interface RunDependencies {
  io: Io;
  createClient(io: Io, options: ClientOptions): Promise<ManagementClient>;
}

/** Runs one invocation and returns its exit code; errors are reported on stderr. */
export async function runProgram(program: Program, argv: readonly string[], dependencies: RunDependencies): Promise<number> {
  const { io } = dependencies;
  let client: ManagementClient | undefined;
  let clientPromise: Promise<ManagementClient> | undefined;
  let currentCommand: string | undefined;
  try {
    const invocation = locate(argv, program.entries);
    const wantsHelp = invocation.rest.includes("--help") || invocation.rest.includes("-h");
    if (invocation.path[0] === "help") return showHelpFor(program, invocation.rest.filter((token) => !token.startsWith("-")), io);
    if (!invocation.entry) {
      if (invocation.path.length) {
        throw new UsageError(`Unknown command '${invocation.path[0]}'.${suggest(invocation.path[0]!, program.entries.map((entry) => entry.name))}`, "");
      }
      if (wantsHelp || !invocation.rest.length) { io.out(programHelp(program)); return 0; }
      try {
        parseOptions(invocation.rest, GLOBAL_OPTIONS);
      } catch (error) {
        throw new UsageError(error instanceof Error ? error.message.replace(/\. To specify a positional argument.*$/s, "") : String(error), "");
      }
      throw new UsageError("Missing command", "");
    }
    if (!invocation.command) {
      const group = invocation.entry as CommandGroup;
      if (invocation.path.length > 1) {
        throw new UsageError(`Unknown command '${program.name} ${invocation.path.join(" ")}'.${suggest(invocation.path[1]!, group.commands.map((command) => command.name))}`, group.name);
      }
      io.out(groupHelp(program.name, group));
      return 0;
    }
    const command = invocation.command;
    const path = isGroup(invocation.entry) ? [invocation.entry.name, command.name] : [command.name];
    const commandName = path.join(" ");
    currentCommand = commandName;
    if (wantsHelp) { io.out(commandHelp(program.name, path, command)); return 0; }
    let parsed: ReturnType<typeof parseOptions>;
    try {
      parsed = parseOptions(invocation.rest, { ...GLOBAL_OPTIONS, ...command.options });
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message.replace(/\. To specify a positional argument.*$/s, "") : String(error), commandName);
    }
    const bounds = argumentBounds(command.usage);
    const args = parsed.positionals;
    if (args.length < bounds.min) throw new UsageError(`Missing arguments: ${program.name} ${commandName} ${command.usage ?? ""}`.trimEnd(), commandName);
    if (args.length > bounds.max) throw new UsageError(`Unexpected argument '${args[bounds.max]}'`, commandName);
    const values = parsed.values as Record<string, OptionValue>;
    const output = parseOutputFormat(values.output as string | undefined);
    const server = values.server as string | undefined;
    const actor = values.actor as string | undefined;
    const context: CommandContext = {
      args, options: values, output, io, commandName,
      client: () => {
        clientPromise ??= dependencies.createClient(io, { server, actor }).then((created) => (client = created));
        return clientPromise;
      },
    };
    return (await command.run(context)) ?? 0;
  } catch (error) {
    // Usage errors from option values point at the command's help.
    if (error instanceof UsageError && error.helpCommand === undefined && currentCommand) return reportError(program.name, new UsageError(error.message, currentCommand), io);
    return reportError(program.name, error, io);
  } finally {
    if (client) await client.close().catch(() => undefined);
    else if (clientPromise) await clientPromise.then((created) => created.close()).catch(() => undefined);
  }
}

function showHelpFor(program: Program, path: string[], io: Io): number {
  const entry = program.entries.find((candidate) => candidate.name === path[0]);
  if (!path.length) { io.out(programHelp(program)); return 0; }
  if (!entry) throw new UsageError(`Unknown command '${path[0]}'.${suggest(path[0]!, program.entries.map((candidate) => candidate.name))}`, "");
  if (!isGroup(entry)) { io.out(commandHelp(program.name, [entry.name], entry)); return 0; }
  if (path.length === 1) { io.out(groupHelp(program.name, entry)); return 0; }
  const command = entry.commands.find((candidate) => candidate.name === path[1]);
  if (!command) throw new UsageError(`Unknown command '${program.name} ${path.slice(0, 2).join(" ")}'.${suggest(path[1]!, entry.commands.map((candidate) => candidate.name))}`, entry.name);
  io.out(commandHelp(program.name, [entry.name, command.name], command));
  return 0;
}

export function reportError(programName: string, error: unknown, io: Io): number {
  if (error instanceof UsageError) {
    const help = error.helpCommand === undefined ? "" : `\nRun '${programName}${error.helpCommand ? ` ${error.helpCommand}` : ""} --help' for usage.`;
    io.err(`${programName}: ${error.message}${help}\n`);
    return error.exitCode;
  }
  if (error instanceof ApiError) {
    const reference = error.status >= 500 && error.requestId ? ` (request ${error.requestId})` : "";
    io.err(`${programName}: ${error.message}${reference}\n`);
    return error.exitCode;
  }
  if (error instanceof CliError) {
    io.err(`${programName}: ${error.message}\n`);
    return error.exitCode;
  }
  // Unexpected failures, such as a database error in a setup command. Drizzle puts
  // the query and its parameters in the message, which may include secrets.
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined;
  const message = cause ?? (error instanceof Error ? error.message : String(error)).replace(/\nparams:[\s\S]*$/, "");
  if (io.env.AIGCTL_DEBUG && error instanceof Error) io.err(`${error.stack ?? ""}\n`);
  io.err(`${programName}: ${message}${io.env.AIGCTL_DEBUG ? "" : " (set AIGCTL_DEBUG=1 for details)"}\n`);
  return 1;
}
