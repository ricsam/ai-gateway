import { USER_API_KEY_SCOPES } from "../../api-key-utils";
import { call, type ManagementClient } from "../client";
import { CliError, UsageError } from "../errors";
import type { Command, CommandGroup } from "../framework";
import {
  choosePassword, confirm, expandScopes, listOption, optionalAmount, optionalBoolean, parseExpiry,
  PASSWORD_OPTIONS, stringOption, YES_OPTION,
} from "../inputs";
import { formatCredits, formatTime, printJson, printList, renderDetails, type Column } from "../output";
import {
  findKey, keyStatus, listAll, resolveGroups, resolveUser, type InferenceKey, type Page, type User,
} from "../resources";
import { getUser, parseChoice, report, requiredOption, revealSecret } from "./common";

const ROLES = ["user", "admin"] as const;

export const USER_COLUMNS: Column<User>[] = [
  { header: "ID", value: (user) => user.id, wide: true },
  { header: "USERNAME", value: (user) => user.username },
  { header: "NAME", value: (user) => user.name, maxWidth: 28 },
  { header: "EMAIL", value: (user) => user.email },
  { header: "ROLE", value: (user) => user.role },
  { header: "ENABLED", value: (user) => user.enabled },
  { header: "BALANCE", value: (user) => formatCredits(user.creditBalance), align: "right" },
  { header: "MONTHLY", value: (user) => formatCredits(user.defaultMonthlyCredits), align: "right" },
  { header: "GROUPS", value: (user) => user.groups.map((group) => group.name), maxWidth: 40 },
  { header: "CHANGE-PASSWORD", value: (user) => user.mustChangePassword, wide: true },
  { header: "CREATED", value: (user) => formatTime(user.createdAt), wide: true },
];

export function userDetails(user: User): string {
  return renderDetails([
    ["ID", user.id],
    ["Username", user.username],
    ["Name", user.name],
    ["Email", user.email],
    ["Role", user.role],
    ["Enabled", user.enabled],
    ["Must change password", user.mustChangePassword],
    ["Credit balance", formatCredits(user.creditBalance)],
    ["Monthly credits", formatCredits(user.defaultMonthlyCredits)],
    ["Groups", user.groups.map((group) => `${group.name} (${group.role})`)],
    ["Created", formatTime(user.createdAt)],
  ]);
}

async function assertUnused(client: ManagementClient, username: string, email: string): Promise<void> {
  for (const [field, value] of [["username", username.toLowerCase()], ["email", email.toLowerCase()]] as const) {
    const { data } = await call<Page<User>>(client, "GET", "/users", { query: { search: value, limit: 100 } });
    const taken = data.find((user) => user[field] === value);
    if (taken) throw new CliError(`A user with the ${field} '${value}' already exists (${taken.username})`);
  }
}

/** First-boot setup creates the first administrator and closes setup for good; plain user creation would not. */
async function assertSetupClosed(client: ManagementClient): Promise<void> {
  if (client.mode !== "local") return;
  const { getSetupStatus } = await import("../../setup");
  if ((await getSetupStatus()).required) {
    throw new CliError("Setup is still open: create the first administrator with 'aigctl setup init', which also closes setup for good");
  }
}

const list: Command = {
  name: "list",
  summary: "List users",
  options: {
    search: { type: "string", value: "<text>", description: "Only users whose username, email or name contains this text" },
    role: { type: "string", value: "<role>", description: "Only users with this role: user or admin" },
  },
  examples: ["aigctl users list", "aigctl users list --role admin", "aigctl users list --search example.com -o wide"],
  async run(context) {
    const role = parseChoice(context, "role", stringOption(context.options.role), ROLES);
    const { items } = await listAll<User>(await context.client(), "/users", { search: stringOption(context.options.search)?.trim() });
    const users = role ? items.filter((user) => user.role === role) : items;
    printList(context.io, context.output, users, USER_COLUMNS, "No users found.");
  },
};

const get: Command = {
  name: "get",
  summary: "Show a user",
  usage: "<user>",
  details: "<user> is a user's ID, username or email.",
  async run(context) {
    const user = await resolveUser(await context.client(), context.args[0]!);
    if (context.output === "json") printJson(context.io, user);
    else context.io.out(userDetails(user));
  },
};

const create: Command = {
  name: "create",
  summary: "Create a local user with a password",
  details: `Without --password-stdin or --generate-password, aigctl asks for the password (use kubectl exec -it).
Passwords are never accepted as arguments, because kubectl exec arguments end up in the Kubernetes audit log.
By default the user must change the password at the first sign-in.`,
  options: {
    username: { type: "string", value: "<username>", description: "Sign-in name: 3-40 letters, digits, dots, underscores or hyphens (required)" },
    email: { type: "string", value: "<email>", description: "Email address (required)" },
    name: { type: "string", value: "<name>", description: "Display name (default: the username)" },
    role: { type: "string", value: "<role>", description: "user (default) or admin" },
    disabled: { type: "boolean", description: "Create the account disabled: no sign-in and no API access" },
    balance: { type: "string", value: "<credits>", description: "Initial credit balance in dollars (default 0)" },
    "monthly-credits": { type: "string", value: "<credits>", description: "Balance the monthly reset restores (default 0: no reset)" },
    group: { type: "string", multiple: true, value: "<group>", description: "Add the user to this group (ID or name)" },
    "must-change-password": { type: "string", value: "<bool>", description: "Require a new password at the first sign-in (default true)" },
    ...PASSWORD_OPTIONS,
  },
  examples: [
    "aigctl users create --username alice --email alice@example.com --name 'Alice Smith' --monthly-credits 50",
    "aigctl users create --username ops --email ops@example.com --role admin --generate-password",
    "printf '%s' \"$PASSWORD\" | kubectl exec -i deploy/ai-gateway-ai-gateway -- aigctl users create --username bob --email bob@example.com --password-stdin",
  ],
  async run(context) {
    const username = requiredOption(context, "username");
    const email = requiredOption(context, "email");
    const name = stringOption(context.options.name)?.trim() || username;
    const role = parseChoice(context, "role", stringOption(context.options.role), ROLES) ?? "user";
    const creditBalance = optionalAmount("balance", context.options.balance);
    const defaultMonthlyCredits = optionalAmount("monthly-credits", context.options["monthly-credits"]);
    const mustChangePassword = optionalBoolean("must-change-password", context.options["must-change-password"]) ?? true;
    const client = await context.client();
    await assertSetupClosed(client);
    await assertUnused(client, username, email);
    const groups = await resolveGroups(client, listOption(context.options.group));
    const { password, generated } = await choosePassword(context, username);
    const { data } = await call<{ data: User }>(client, "POST", "/users", { json: {
      username, email, name, password, role, enabled: context.options.disabled !== true, mustChangePassword,
      creditBalance, defaultMonthlyCredits, groupIds: groups.map((group) => group.id),
    } });
    const user = await getUser(client, data.id);
    const message = `Created ${user.role === "admin" ? "administrator" : "user"} ${user.username} (${user.id})${user.enabled ? "" : ", disabled"}.`;
    const change = mustChangePassword ? ` ${user.username} must change the password at the first sign-in.` : "";
    if (generated) revealSecret(context, `${message}${change} The generated password is shown only once:`, password, { ...user, password });
    else report(context, `${message}${change}`, user);
  },
};

const update: Command = {
  name: "update",
  summary: "Change a user's details, role or credits",
  usage: "<user>",
  details: `Setting --balance records an administrator adjustment in the credit ledger.
Use 'users enable' and 'users disable' for account access and 'users set-password' for passwords.`,
  options: {
    username: { type: "string", value: "<username>", description: "New sign-in name" },
    email: { type: "string", value: "<email>", description: "New email address" },
    name: { type: "string", value: "<name>", description: "New display name" },
    role: { type: "string", value: "<role>", description: "user or admin" },
    balance: { type: "string", value: "<credits>", description: "Set the credit balance in dollars" },
    "monthly-credits": { type: "string", value: "<credits>", description: "Balance the monthly reset restores (0: no reset)" },
    "must-change-password": { type: "string", value: "<bool>", description: "Require a new password at the next sign-in" },
  },
  examples: ["aigctl users update alice --role admin", "aigctl users update alice --balance 25 --monthly-credits 50"],
  async run(context) {
    const patch: Record<string, unknown> = {};
    for (const field of ["username", "email", "name"] as const) {
      const value = stringOption(context.options[field]);
      if (value !== undefined) patch[field] = value;
    }
    const role = parseChoice(context, "role", stringOption(context.options.role), ROLES);
    if (role) patch.role = role;
    const balance = optionalAmount("balance", context.options.balance);
    if (balance !== undefined) patch.creditBalance = balance;
    const monthly = optionalAmount("monthly-credits", context.options["monthly-credits"]);
    if (monthly !== undefined) patch.defaultMonthlyCredits = monthly;
    const mustChangePassword = optionalBoolean("must-change-password", context.options["must-change-password"]);
    if (mustChangePassword !== undefined) patch.mustChangePassword = mustChangePassword;
    if (!Object.keys(patch).length) throw new UsageError("Nothing to change: pass at least one option", context.commandName);
    const client = await context.client();
    const target = await resolveUser(client, context.args[0]!);
    await call(client, "PATCH", `/users/${encodeURIComponent(target.id)}`, { json: patch });
    const user = await getUser(client, target.id);
    report(context, `Updated user ${user.username}.`, user);
  },
};

function accessCommand(enabled: boolean): Command {
  return {
    name: enabled ? "enable" : "disable",
    summary: enabled ? "Allow a user to sign in and use their inference keys again" : "Block a user's sign-in and API access and sign them out",
    usage: "<user>",
    async run(context) {
      const client = await context.client();
      const target = await resolveUser(client, context.args[0]!);
      await call(client, "POST", `/users/${encodeURIComponent(target.id)}/${enabled ? "enable" : "disable"}`);
      const user = await getUser(client, target.id);
      report(context, enabled
        ? `Enabled ${user.username}: sign-in and inference keys work again.`
        : `Disabled ${user.username}: signed out, and sign-in and inference keys are refused until the account is enabled.`, user);
    },
  };
}

const remove: Command = {
  name: "delete",
  summary: "Delete a user with their sessions, memberships and inference keys",
  usage: "<user>",
  details: "Usage history stays in the ledger. The last enabled administrator cannot be deleted.",
  options: { ...YES_OPTION },
  async run(context) {
    const client = await context.client();
    const user = await resolveUser(client, context.args[0]!);
    await confirm(context, `Delete user ${user.username} (${user.email})`, "This permanently removes the user with their sessions, group memberships and inference keys.");
    await call(client, "DELETE", `/users/${encodeURIComponent(user.id)}`);
    report(context, `Deleted user ${user.username}.`, { success: true, id: user.id, username: user.username });
  },
};

const setPassword: Command = {
  name: "set-password",
  summary: "Set a user's password and sign them out",
  usage: "<user>",
  details: `Without --password-stdin or --generate-password, aigctl asks for the password (use kubectl exec -it).
Also gives users of external login providers a local password. To recover an administrator account:
  aigctl users set-password <user> && aigctl users update <user> --role admin && aigctl users enable <user>`,
  options: {
    ...PASSWORD_OPTIONS,
    "must-change-password": { type: "string", value: "<bool>", description: "Require a new password at the next sign-in (default true)" },
  },
  examples: ["aigctl users set-password alice", "aigctl users set-password alice --generate-password"],
  async run(context) {
    const mustChangePassword = optionalBoolean("must-change-password", context.options["must-change-password"]) ?? true;
    const client = await context.client();
    const user = await resolveUser(client, context.args[0]!);
    const { password, generated } = await choosePassword(context, user.username);
    await call(client, "POST", `/users/${encodeURIComponent(user.id)}/password`, { json: { password, mustChangePassword } });
    const message = `Set a new password for ${user.username} and signed out their sessions.${mustChangePassword ? " They must change it at the next sign-in." : ""}`;
    const result = { success: true, id: user.id, username: user.username, mustChangePassword };
    if (generated) revealSecret(context, `${message} The generated password is shown only once:`, password, { ...result, password });
    else report(context, message, result);
  },
};

const setGroups: Command = {
  name: "set-groups",
  summary: "Replace a user's manual group memberships",
  usage: "<user> [group...]",
  details: "Groups are IDs or names. Without groups, removes every manual membership. Memberships from other sources are kept.",
  examples: ["aigctl users set-groups alice engineering research", "aigctl users set-groups alice"],
  async run(context) {
    const client = await context.client();
    const target = await resolveUser(client, context.args[0]!);
    const groups = await resolveGroups(client, context.args.slice(1));
    await call(client, "PUT", `/users/${encodeURIComponent(target.id)}/groups`, { json: { groupIds: groups.map((group) => group.id) } });
    const user = await getUser(client, target.id);
    report(context, `${user.username} is now in: ${user.groups.map((group) => group.name).join(", ") || "no groups"}.`, user);
  },
};

export const usersGroup: CommandGroup = {
  name: "users",
  summary: "Local users, passwords, roles, account access and credits",
  details: "Commands that take <user> accept a user's ID, username or email.",
  commands: [list, get, create, update, accessCommand(true), accessCommand(false), remove, setPassword, setGroups],
};

const KEY_COLUMNS: Column<InferenceKey>[] = [
  { header: "ID", value: (key) => key.id, wide: true },
  { header: "NAME", value: (key) => key.name, maxWidth: 30 },
  { header: "PREFIX", value: (key) => key.keyPrefix },
  { header: "SCOPES", value: (key) => key.scopes },
  { header: "STATUS", value: (key) => keyStatus(key) },
  { header: "EXPIRES", value: (key) => key.expiresAt ? formatTime(key.expiresAt) : "never" },
  { header: "LAST-USED", value: (key) => key.lastUsedAt ? formatTime(key.lastUsedAt) : "never" },
  { header: "CREATED", value: (key) => formatTime(key.createdAt) },
];

async function userKeys(client: ManagementClient, user: User): Promise<InferenceKey[]> {
  return (await call<{ data: InferenceKey[] }>(client, "GET", `/users/${encodeURIComponent(user.id)}/api-keys`)).data;
}

const listKeys: Command = {
  name: "list",
  summary: "List a user's inference keys",
  usage: "<user>",
  options: { all: { type: "boolean", description: "Include revoked keys" } },
  async run(context) {
    const client = await context.client();
    const user = await resolveUser(client, context.args[0]!);
    const keys = (await userKeys(client, user)).filter((key) => context.options.all === true || keyStatus(key) !== "revoked");
    printList(context.io, context.output, keys, KEY_COLUMNS, `${user.username} has no ${context.options.all === true ? "" : "unrevoked "}inference keys.`);
  },
};

const createKey: Command = {
  name: "create",
  summary: "Create an inference key (aig_...) for a user",
  usage: "<user>",
  details: `The key is printed once and is the only output on standard output, so KEY=$(aigctl api-keys create ...) captures it.
Scopes: ${USER_API_KEY_SCOPES.join(", ")} (default: all of them).`,
  options: {
    name: { type: "string", value: "<name>", description: "Key name, 1-100 characters (required)" },
    scope: { type: "string", multiple: true, value: "<scope>", description: "Grant only these scopes (comma-separated or repeated; * patterns allowed)" },
    expires: { type: "string", value: "<when>", description: "Expiry: a duration such as 30d, 12h or 2w, or a date such as 2027-01-31" },
    replace: { type: "boolean", description: "Revoke the user's other keys with the same name first (rotation)" },
  },
  examples: ["aigctl api-keys create alice --name laptop", "aigctl api-keys create alice --name ci --scope ai.invoke,models.read --expires 90d --replace"],
  async run(context) {
    const name = requiredOption(context, "name");
    const patterns = listOption(context.options.scope);
    const scopes = patterns.length ? expandScopes(patterns, USER_API_KEY_SCOPES) : [...USER_API_KEY_SCOPES];
    const expires = stringOption(context.options.expires);
    const expiresAt = expires ? parseExpiry(expires) : undefined;
    const client = await context.client();
    const user = await resolveUser(client, context.args[0]!);
    const { data } = await call<{ data: InferenceKey & { key: string } }>(client, "POST", `/users/${encodeURIComponent(user.id)}/api-keys`, {
      json: { name, scopes, expiresAt, replaceExisting: context.options.replace === true },
    });
    const replaced = context.options.replace === true ? " Revoked the user's earlier keys with this name." : "";
    revealSecret(context,
      `Created inference key '${data.name}' for ${user.username} (${data.scopes.join(", ")}; expires ${data.expiresAt ? formatTime(data.expiresAt) : "never"}).${replaced}${user.enabled ? "" : ` ${user.username} is disabled: the key works once the account is enabled.`} The key is shown only once:`,
      data.key, data);
  },
};

const revokeKey: Command = {
  name: "revoke",
  summary: "Revoke one of a user's inference keys",
  usage: "<user> <key>",
  details: "<key> is the key's ID, its prefix as listed (aig_...), or its name when only one unrevoked key has it.",
  options: { ...YES_OPTION },
  async run(context) {
    const client = await context.client();
    const user = await resolveUser(client, context.args[0]!);
    const key = findKey(await userKeys(client, user), context.args[1]!, "inference key");
    if (keyStatus(key) === "revoked") throw new CliError(`The key '${key.name}' (${key.keyPrefix}) is already revoked`);
    await confirm(context, `Revoke ${user.username}'s inference key '${key.name}' (${key.keyPrefix})`, "Clients using the key stop working.");
    await call(client, "DELETE", `/users/${encodeURIComponent(user.id)}/api-keys/${encodeURIComponent(key.id)}`);
    report(context, `Revoked ${user.username}'s inference key '${key.name}' (${key.keyPrefix}).`, { success: true, id: key.id });
  },
};

export const apiKeysGroup: CommandGroup = {
  name: "api-keys",
  summary: "Users' inference keys (aig_...)",
  details: "Commands take <user> as a user's ID, username or email.",
  commands: [listKeys, createKey, revokeKey],
};
