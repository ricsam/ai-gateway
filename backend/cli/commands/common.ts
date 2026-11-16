import { call, type ManagementClient } from "../client";
import { CliError, UsageError } from "../errors";
import type { CommandContext } from "../framework";
import { stringOption } from "../inputs";
import { printJson } from "../output";
import type { User } from "../resources";

export function requiredOption(context: CommandContext, name: string): string {
  const value = stringOption(context.options[name])?.trim();
  if (!value) throw new UsageError(`--${name} is required`, context.commandName);
  return value;
}

export async function getUser(client: ManagementClient, id: string): Promise<User> {
  return (await call<{ data: User }>(client, "GET", `/users/${encodeURIComponent(id)}`)).data;
}

/** Prints a confirmation, or the resource itself with -o json. */
export function report(context: CommandContext, message: string, json: unknown): void {
  if (context.output === "json") printJson(context.io, json);
  else context.io.out(`${message}\n`);
}

/**
 * Prints a one-time secret (a created key or generated password). The secret
 * is the only thing on standard output, so KEY=$(aigctl ...) captures it; the
 * explanation goes to standard error.
 */
export function revealSecret(context: CommandContext, message: string, secret: string, json: unknown): void {
  if (context.output === "json") return printJson(context.io, json);
  context.io.err(`${message}\n`);
  context.io.out(`${secret}\n`);
}

export function parseChoice<T extends string>(context: CommandContext, flag: string, value: string | undefined, choices: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!(choices as readonly string[]).includes(normalized)) throw new UsageError(`--${flag} must be one of ${choices.join(", ")}`, context.commandName);
  return normalized as T;
}

/** Commands that need the gateway's own code, not just its management API. */
export async function requireLocal(context: CommandContext, what: string): Promise<ManagementClient> {
  const client = await context.client();
  if (client.mode !== "local") throw new CliError(`${what} runs only inside the gateway container (without --server and AI_GATEWAY_URL), where aigctl uses the gateway's database directly`);
  return client;
}
