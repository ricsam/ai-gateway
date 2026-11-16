import { MANAGEMENT_SCOPES } from "../../../shared/management-scopes";
import { call, type ManagementClient } from "../client";
import { CliError, UsageError } from "../errors";
import type { Command, CommandGroup } from "../framework";
import { confirm, expandScopes, listOption, parseExpiry, stringOption, YES_OPTION } from "../inputs";
import { formatTime, printJson, printList, type Column } from "../output";
import { findKey, keyStatus, type ManagementKey } from "../resources";
import { report, requiredOption, revealSecret } from "./common";

const COLUMNS: Column<ManagementKey>[] = [
  { header: "ID", value: (key) => key.id, wide: true },
  { header: "NAME", value: (key) => key.name, maxWidth: 30 },
  { header: "PREFIX", value: (key) => key.keyPrefix },
  { header: "SCOPES", value: (key) => key.scopes, maxWidth: 60 },
  { header: "STATUS", value: (key) => keyStatus(key) },
  { header: "EXPIRES", value: (key) => key.expiresAt ? formatTime(key.expiresAt) : "never" },
  { header: "LAST-USED", value: (key) => key.lastUsedAt ? formatTime(key.lastUsedAt) : "never" },
  { header: "CREATED", value: (key) => formatTime(key.createdAt) },
  { header: "CREATED-BY", value: (key) => key.createdByUserId, wide: true },
];

async function listKeys(client: ManagementClient): Promise<ManagementKey[]> {
  return (await call<{ data: ManagementKey[] }>(client, "GET", "/management-keys")).data;
}

const list: Command = {
  name: "list",
  summary: "List management keys",
  options: { all: { type: "boolean", description: "Include revoked keys" } },
  async run(context) {
    const keys = (await listKeys(await context.client())).filter((key) => context.options.all === true || keyStatus(key) !== "revoked");
    printList(context.io, context.output, keys, COLUMNS, context.options.all === true ? "No management keys." : "No unrevoked management keys.");
  },
};

const create: Command = {
  name: "create",
  summary: "Create a management key (aigm_...) for automation",
  details: `The key is printed once and is the only output on standard output, so KEY=$(aigctl management-keys create ...) captures it.
Grant only the scopes the automation needs. Patterns expand to matching scopes: users.* (read and write), *.read (read-only), * (everything).
Run 'aigctl management-keys scopes' for the list.`,
  options: {
    name: { type: "string", value: "<name>", description: "Key name (required)" },
    scope: { type: "string", multiple: true, value: "<scope>", description: "Scope or pattern to grant (comma-separated or repeated; required)" },
    expires: { type: "string", value: "<when>", description: "Expiry: a duration such as 30d, 12h or 2w, or a date such as 2027-01-31" },
  },
  examples: [
    "aigctl management-keys create --name provisioning --scope users.*,api-keys.write --expires 90d",
    "aigctl management-keys create --name reporting --scope '*.read'",
  ],
  async run(context) {
    const name = requiredOption(context, "name");
    const patterns = listOption(context.options.scope);
    if (!patterns.length) throw new UsageError("--scope is required: grant at least one scope", context.commandName);
    const scopes = expandScopes(patterns, MANAGEMENT_SCOPES);
    const expires = stringOption(context.options.expires);
    const { data } = await call<{ data: ManagementKey & { key: string } }>(await context.client(), "POST", "/management-keys", {
      json: { name, scopes, expiresAt: expires ? parseExpiry(expires) : undefined },
    });
    revealSecret(context,
      `Created management key '${data.name}' (${data.scopes.join(", ")}; expires ${data.expiresAt ? formatTime(data.expiresAt) : "never"}). The key is shown only once:`,
      data.key, data);
  },
};

const revoke: Command = {
  name: "revoke",
  summary: "Revoke a management key",
  usage: "<key>",
  details: "<key> is the key's ID, its prefix as listed (aigm_...), or its name when only one unrevoked key has it.",
  options: { ...YES_OPTION },
  async run(context) {
    const client = await context.client();
    const key = findKey(await listKeys(client), context.args[0]!, "management key");
    if (keyStatus(key) === "revoked") throw new CliError(`The management key '${key.name}' (${key.keyPrefix}) is already revoked`);
    await confirm(context, `Revoke management key '${key.name}' (${key.keyPrefix})`, "Automation using the key stops working.");
    await call(client, "DELETE", `/management-keys/${encodeURIComponent(key.id)}`);
    report(context, `Revoked management key '${key.name}' (${key.keyPrefix}).`, { success: true, id: key.id });
  },
};

const scopes: Command = {
  name: "scopes",
  summary: "List the scopes a management key can have",
  async run(context) {
    if (context.output === "json") return printJson(context.io, MANAGEMENT_SCOPES);
    context.io.out(`${MANAGEMENT_SCOPES.join("\n")}\n`);
  },
};

export const managementKeysGroup: CommandGroup = {
  name: "management-keys",
  summary: "Management API keys (aigm_...) for automation",
  commands: [list, create, revoke, scopes],
};
