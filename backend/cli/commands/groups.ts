import { call } from "../client";
import { CliError, UsageError } from "../errors";
import type { Command, CommandGroup } from "../framework";
import { confirm, optionalAmount, stringOption, YES_OPTION } from "../inputs";
import { formatCredits, formatTime, printJson, printList, renderDetails, renderTable, type Column } from "../output";
import {
  getGroupDetails, listAll, resolveGroup, resolveGroups, resolveUser, resolveUsers,
  type Group, type GroupDetails, type GroupMember,
} from "../resources";
import { parseChoice, report } from "./common";

const MEMBER_ROLES = ["member", "admin", "owner"] as const;

const GROUP_COLUMNS: Column<Group>[] = [
  { header: "ID", value: (group) => group.id, wide: true },
  { header: "NAME", value: (group) => group.name },
  { header: "MEMBERS", value: (group) => group.memberCount ?? 0, align: "right" },
  { header: "DESCRIPTION", value: (group) => group.description, maxWidth: 50 },
  { header: "CREATED", value: (group) => formatTime(group.createdAt) },
];

const MEMBER_COLUMNS: Column<GroupMember>[] = [
  { header: "USER-ID", value: (member) => member.userId, wide: true },
  { header: "USERNAME", value: (member) => member.username },
  { header: "NAME", value: (member) => member.name, maxWidth: 28 },
  { header: "EMAIL", value: (member) => member.email },
  { header: "ROLE", value: (member) => member.role },
  { header: "SOURCE", value: (member) => member.source },
  { header: "ENABLED", value: (member) => member.enabled },
  { header: "BALANCE", value: (member) => formatCredits(member.creditBalance), align: "right" },
  { header: "MONTHLY", value: (member) => formatCredits(member.defaultMonthlyCredits), align: "right", wide: true },
  { header: "JOINED", value: (member) => formatTime(member.joinedAt), wide: true },
];

const list: Command = {
  name: "list",
  summary: "List groups",
  async run(context) {
    const { items } = await listAll<Group>(await context.client(), "/groups");
    printList(context.io, context.output, items, GROUP_COLUMNS, "No groups found.");
  },
};

const get: Command = {
  name: "get",
  summary: "Show a group and its members",
  usage: "<group>",
  async run(context) {
    const client = await context.client();
    const group = await getGroupDetails(client, (await resolveGroup(client, context.args[0]!)).id);
    if (context.output === "json") return printJson(context.io, group);
    const members = [...group.members].sort((a, b) => a.username.localeCompare(b.username));
    context.io.out(renderDetails([
      ["ID", group.id], ["Name", group.name], ["Description", group.description], ["Created", formatTime(group.createdAt)], ["Members", members.length],
    ]));
    if (members.length) context.io.out(`\n${renderTable(members, MEMBER_COLUMNS, context.output === "wide")}`);
  },
};

const create: Command = {
  name: "create",
  summary: "Create a group",
  usage: "<name>",
  options: { description: { type: "string", value: "<text>", description: "Description" } },
  examples: ["aigctl groups create engineering --description 'Product engineering'"],
  async run(context) {
    const { data } = await call<{ data: Group }>(await context.client(), "POST", "/groups", {
      json: { name: context.args[0], description: stringOption(context.options.description) },
    });
    report(context, `Created group ${data.name} (${data.id}).`, data);
  },
};

const update: Command = {
  name: "update",
  summary: "Rename a group or change its description",
  usage: "<group>",
  options: {
    name: { type: "string", value: "<name>", description: "New name" },
    description: { type: "string", value: "<text>", description: "New description ('' clears it)" },
  },
  async run(context) {
    const name = stringOption(context.options.name);
    const description = stringOption(context.options.description);
    if (name === undefined && description === undefined) throw new UsageError("Nothing to change: pass --name or --description", context.commandName);
    const client = await context.client();
    const group = await resolveGroup(client, context.args[0]!);
    const { data } = await call<{ data: Group }>(client, "PATCH", `/groups/${encodeURIComponent(group.id)}`, {
      json: { ...(name !== undefined && { name }), ...(description !== undefined && { description: description.trim() || null }) },
    });
    report(context, `Updated group ${data.name}.`, data);
  },
};

const remove: Command = {
  name: "delete",
  summary: "Delete a group; its members keep their accounts",
  usage: "<group>",
  options: { ...YES_OPTION },
  async run(context) {
    const client = await context.client();
    const group = await resolveGroup(client, context.args[0]!);
    await confirm(context, `Delete group ${group.name}`, "Its memberships are removed; the users are kept.");
    await call(client, "DELETE", `/groups/${encodeURIComponent(group.id)}`);
    report(context, `Deleted group ${group.name}.`, { success: true, id: group.id, name: group.name });
  },
};

const addMember: Command = {
  name: "add-member",
  summary: "Add users to a group",
  usage: "<group> <user>...",
  options: { role: { type: "string", value: "<role>", description: "Membership role: member (default), admin or owner" } },
  examples: ["aigctl groups add-member engineering alice bob@example.com"],
  async run(context) {
    const role = parseChoice(context, "role", stringOption(context.options.role), MEMBER_ROLES) ?? "member";
    const client = await context.client();
    const group = await getGroupDetails(client, (await resolveGroup(client, context.args[0]!)).id);
    const users = await resolveUsers(client, context.args.slice(1));
    const added: string[] = [];
    const existing: string[] = [];
    for (const user of users) {
      if (group.members.some((member) => member.userId === user.id)) { existing.push(user.username); continue; }
      await call(client, "POST", `/groups/${encodeURIComponent(group.id)}/members`, { json: { userId: user.id, role } });
      added.push(user.username);
    }
    const parts = [
      added.length ? `Added ${added.join(", ")} to ${group.name} as ${role}.` : "",
      existing.length ? `Already in ${group.name}: ${existing.join(", ")}.` : "",
    ].filter(Boolean);
    report(context, parts.join(" "), { group: { id: group.id, name: group.name }, role, added, alreadyMembers: existing });
  },
};

const removeMember: Command = {
  name: "remove-member",
  summary: "Remove users from a group",
  usage: "<group> <user>...",
  async run(context) {
    const client = await context.client();
    const group = await getGroupDetails(client, (await resolveGroup(client, context.args[0]!)).id);
    const users = await resolveUsers(client, context.args.slice(1));
    const missing = users.filter((user) => !group.members.some((member) => member.userId === user.id));
    if (missing.length) throw new CliError(`Not in ${group.name}: ${missing.map((user) => user.username).join(", ")}`);
    for (const user of users) await call(client, "DELETE", `/groups/${encodeURIComponent(group.id)}/members/${encodeURIComponent(user.id)}`);
    report(context, `Removed ${users.map((user) => user.username).join(", ")} from ${group.name}.`, { group: { id: group.id, name: group.name }, removed: users.map((user) => user.username) });
  },
};

const setRole: Command = {
  name: "set-role",
  summary: "Change a member's role in a group",
  usage: "<group> <user> <role>",
  details: `Roles: ${MEMBER_ROLES.join(", ")}.`,
  async run(context) {
    const role = parseChoice(context, "role", context.args[2], MEMBER_ROLES)!;
    const client = await context.client();
    const group = await resolveGroup(client, context.args[0]!);
    const user = await resolveUser(client, context.args[1]!);
    await call(client, "PATCH", `/groups/${encodeURIComponent(group.id)}/members/${encodeURIComponent(user.id)}`, { json: { role } });
    report(context, `${user.username} is now ${role} of ${group.name}.`, { success: true, group: group.name, username: user.username, role });
  },
};

const bulkUpdate: Command = {
  name: "bulk-update",
  summary: "Enable, disable or set the monthly credits of every member of the groups",
  usage: "<group>...",
  details: "Applies once to each distinct user in the groups. The last enabled administrator cannot be disabled.",
  options: {
    enable: { type: "boolean", description: "Enable the accounts" },
    disable: { type: "boolean", description: "Disable the accounts (signs the users out)" },
    "monthly-credits": { type: "string", value: "<credits>", description: "Balance the monthly reset restores (0: no reset)" },
    ...YES_OPTION,
  },
  examples: ["aigctl groups bulk-update contractors --disable", "aigctl groups bulk-update engineering research --monthly-credits 100"],
  async run(context) {
    if (context.options.enable === true && context.options.disable === true) throw new UsageError("Choose either --enable or --disable", context.commandName);
    const enabled = context.options.enable === true ? true : context.options.disable === true ? false : undefined;
    const defaultMonthlyCredits = optionalAmount("monthly-credits", context.options["monthly-credits"]);
    if (enabled === undefined && defaultMonthlyCredits === undefined) throw new UsageError("Nothing to change: pass --enable, --disable or --monthly-credits", context.commandName);
    const client = await context.client();
    const groups = await resolveGroups(client, context.args);
    if (enabled === false) {
      const details: GroupDetails[] = [];
      for (const group of groups) details.push(await getGroupDetails(client, group.id));
      const members = new Set(details.flatMap((group) => group.members.map((member) => member.userId)));
      const who = members.size === 1 ? "the 1 member" : `all ${members.size} members`;
      await confirm(context, `Disable ${who} of ${groups.map((group) => group.name).join(", ")}`, "Disabled users are signed out and their inference keys are refused.");
    }
    const { data } = await call<{ data: { usersUpdated: number } }>(client, "POST", "/groups/bulk-user-update", {
      json: { groupIds: groups.map((group) => group.id), enabled, defaultMonthlyCredits },
    });
    const changes = [
      enabled === undefined ? "" : enabled ? "enabled" : "disabled",
      defaultMonthlyCredits === undefined ? "" : `set monthly credits to ${formatCredits(defaultMonthlyCredits)}`,
    ].filter(Boolean).join(" and ");
    report(context, `Updated ${data.usersUpdated} user${data.usersUpdated === 1 ? "" : "s"} in ${groups.map((group) => group.name).join(", ")}: ${changes}.`, data);
  },
};

export const groupsGroup: CommandGroup = {
  name: "groups",
  summary: "Groups and memberships",
  details: "Commands take <group> as a group's ID or name and <user> as a user's ID, username or email.",
  commands: [list, get, create, update, remove, addMember, removeMember, setRole, bulkUpdate],
};
