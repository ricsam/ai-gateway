import { passwordPolicyError } from "../password-policy";
import { CliError, UsageError } from "./errors";
import type { CommandContext, OptionValue } from "./framework";

export function stringOption(value: OptionValue): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function listOption(value: OptionValue): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return values.flatMap((entry) => entry.split(",")).map((entry) => entry.trim()).filter(Boolean);
}

const TRUE = new Set(["true", "yes", "on", "1", "enabled", "enable"]);
const FALSE = new Set(["false", "no", "off", "0", "disabled", "disable"]);

export function parseBoolean(flag: string, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (TRUE.has(normalized)) return true;
  if (FALSE.has(normalized)) return false;
  throw new UsageError(`--${flag} must be true or false (also yes/no, on/off)`);
}

export function optionalBoolean(flag: string, value: OptionValue): boolean | undefined {
  const text = stringOption(value);
  return text === undefined ? undefined : parseBoolean(flag, text);
}

/** A non-negative credit amount in dollars; a leading $ is accepted. */
export function parseAmount(flag: string, value: string): number {
  const text = value.trim().replace(/^\$/, "");
  const amount = Number(text);
  if (!text || !Number.isFinite(amount) || amount < 0) throw new UsageError(`--${flag} must be a non-negative amount, such as 25 or 12.50`);
  return amount;
}

export function optionalAmount(flag: string, value: OptionValue): number | undefined {
  const text = stringOption(value);
  return text === undefined ? undefined : parseAmount(flag, text);
}

export function parseInteger(flag: string, value: string, min: number, max: number): number {
  const number = Number(value.trim());
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new UsageError(`--${flag} must be a whole number from ${min} to ${max}`);
  }
  return number;
}

export function optionalInteger(flag: string, value: OptionValue, min: number, max: number): number | undefined {
  const text = stringOption(value);
  return text === undefined ? undefined : parseInteger(flag, text, min, max);
}

const DURATION_UNITS: Record<string, number> = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

/** An expiry as a duration from now (12h, 30d, 2w) or a date or time (2027-01-31, 2027-01-31T12:00:00Z), as ISO 8601. */
export function parseExpiry(value: string, now = new Date()): string {
  const text = value.trim();
  const duration = /^(\d+)\s*([hdw])$/i.exec(text);
  let date: Date;
  if (duration) date = new Date(now.getTime() + Number(duration[1]) * DURATION_UNITS[duration[2]!.toLowerCase()]!);
  else if (/^\d{4}-\d{2}-\d{2}/.test(text)) date = new Date(text);
  else throw new UsageError("--expires must be a duration such as 12h, 30d or 2w, or a date such as 2027-01-31");
  if (!Number.isFinite(date.getTime())) throw new UsageError(`--expires: '${value}' is not a valid date`);
  if (date <= now) throw new UsageError("--expires must be in the future");
  return date.toISOString();
}

/**
 * Expands scope patterns: exact scopes, comma-separated lists and * wildcards
 * (users.*, *.read, or * for every scope).
 */
export function expandScopes(patterns: readonly string[], valid: readonly string[]): string[] {
  const selected = new Set<string>();
  for (const pattern of patterns) {
    if (!pattern.includes("*")) {
      if (!valid.includes(pattern)) throw new UsageError(`Unknown scope '${pattern}'. Valid scopes: ${valid.join(", ")}`);
      selected.add(pattern);
      continue;
    }
    const expression = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    const matches = valid.filter((scope) => expression.test(scope));
    if (!matches.length) throw new UsageError(`Scope pattern '${pattern}' matches no scope. Valid scopes: ${valid.join(", ")}`);
    for (const scope of matches) selected.add(scope);
  }
  return valid.filter((scope) => selected.has(scope));
}

const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** A random 24-character password with letters and digits, which the gateway's password policy accepts. */
export function generatePassword(length = 24): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    let password = "";
    for (const byte of bytes) {
      // Rejection sampling keeps every character equally likely.
      if (byte >= 256 - (256 % PASSWORD_ALPHABET.length)) continue;
      password += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
      if (password.length === length) break;
    }
    if (password.length === length && /[a-z]/i.test(password) && /\d/.test(password)) return password;
  }
}

/** Removes one trailing line break, as `echo` and editors add it. */
export function stripTrailingNewline(text: string): string {
  return text.replace(/\r?\n$/, "");
}

export async function readStdinText(context: CommandContext): Promise<string> {
  return new TextDecoder().decode(await context.io.readStdin());
}

/**
 * Reads secrets piped to standard input. On a terminal that would echo them, so
 * aigctl asks with a hidden prompt instead (leave out the stdin option).
 */
export async function readPipedSecret(context: CommandContext, flag: string): Promise<string> {
  if (context.io.interactive) {
    throw new UsageError(`--${flag} reads a pipe, but standard input is a terminal: leave out --${flag} to be asked without echo, or pipe the value in`, context.commandName);
  }
  return readStdinText(context);
}

export interface PasswordChoice {
  password: string;
  /** Set when aigctl generated the password and must show it. */
  generated: boolean;
}

/**
 * Reads a new password from --password-stdin or --generate-password, or asks
 * twice on a terminal. Passwords are never accepted as arguments: kubectl exec
 * arguments are recorded in the Kubernetes API server's audit log.
 */
export async function choosePassword(context: CommandContext, subject: string): Promise<PasswordChoice> {
  const fromStdin = context.options["password-stdin"] === true;
  const generate = context.options["generate-password"] === true;
  if (fromStdin && generate) throw new UsageError("Choose either --password-stdin or --generate-password", context.commandName);
  if (generate) return { password: generatePassword(), generated: true };
  if (fromStdin) {
    const password = stripTrailingNewline(await readPipedSecret(context, "password-stdin"));
    if (!password) throw new CliError("Standard input did not contain a password");
    if (/[\r\n]/.test(password)) throw new CliError("Standard input must contain the password on a single line");
    const policyError = passwordPolicyError(password);
    if (policyError) throw new CliError(policyError);
    return { password, generated: false };
  }
  if (!context.io.interactive) {
    throw new UsageError("Standard input is not a terminal, so aigctl cannot ask for the password: pass --password-stdin (and pipe it in) or --generate-password", context.commandName);
  }
  const password = await context.io.prompt(`New password for ${subject}: `, { hidden: true });
  if (!password) throw new CliError("No password entered");
  const policyError = passwordPolicyError(password);
  if (policyError) throw new CliError(policyError);
  const confirmation = await context.io.prompt("Repeat the password: ", { hidden: true });
  if (confirmation !== password) throw new CliError("The passwords do not match");
  return { password, generated: false };
}

/**
 * Asks before a destructive change unless --yes is set; without a terminal it
 * refuses. `action` is imperative, such as "Delete user bob".
 */
export async function confirm(context: CommandContext, action: string, consequence?: string): Promise<void> {
  if (context.options.yes === true) return;
  const lowered = action.charAt(0).toLowerCase() + action.slice(1);
  if (!context.io.interactive) throw new UsageError(`Refusing to ${lowered} without confirmation: pass --yes (standard input is not a terminal)`, context.commandName);
  if (consequence) context.io.err(`${consequence}\n`);
  const answer = (await context.io.prompt(`${action}? [y/N] `)).trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") throw new CliError("Cancelled", 1);
}

export const YES_OPTION = { yes: { type: "boolean", short: "y", description: "Do not ask for confirmation" } } as const;

export const PASSWORD_OPTIONS = {
  "password-stdin": { type: "boolean", description: "Read the password from standard input (one line)" },
  "generate-password": { type: "boolean", description: "Generate a random password and print it" },
} as const;

/** Reads a JSON document from a file, or from standard input with -. */
export async function readJsonDocument(context: CommandContext, source: string): Promise<unknown> {
  let text: string;
  try {
    text = source === "-" ? await readStdinText(context) : new TextDecoder().decode(await context.io.readFile(source));
  } catch (error) {
    throw new CliError(`Could not read ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try { return JSON.parse(text); } catch (error) {
    throw new CliError(`${source === "-" ? "Standard input" : source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliError(`${what} must be a JSON object`);
  return value as Record<string, unknown>;
}
