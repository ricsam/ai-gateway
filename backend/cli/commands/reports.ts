import { TIME_RANGES, type TimeRange } from "../../../shared/analytics-time-ranges";
import { call, type ManagementClient, type Query } from "../client";
import { ApiError, UsageError } from "../errors";
import type { Command, CommandContext, CommandGroup } from "../framework";
import { confirm, optionalInteger, stringOption, YES_OPTION } from "../inputs";
import {
  formatCredits, formatDecimal, formatInteger, formatTime, printJson, printList, renderDetails, renderTable, type Column,
} from "../output";
import { listAll, resolveGroup, resolveUser, type Group, type ManagementKey, type User } from "../resources";
import { report } from "./common";

const TIME_RANGE_NAMES = Object.keys(TIME_RANGES) as TimeRange[];

const SCOPE_OPTIONS = {
  user: { type: "string", value: "<user>", description: "Only this user (ID, username or email)" },
  group: { type: "string", value: "<group>", description: "Only the current members of this group (ID or name)" },
} as const;

const RANGE_OPTION = {
  range: { type: "string", value: "<range>", description: `Rolling window ending now: ${TIME_RANGE_NAMES.map((name) => `${name} (${TIME_RANGES[name].label.toLowerCase()})`).join(", ")}; default month` },
} as const;

function timeRange(context: CommandContext): TimeRange {
  const value = stringOption(context.options.range)?.trim().toLowerCase() ?? "month";
  if (!(TIME_RANGE_NAMES as string[]).includes(value)) throw new UsageError(`--range must be one of ${TIME_RANGE_NAMES.join(", ")}`, context.commandName);
  return value as TimeRange;
}

interface Scope { query: { userId?: string; groupId?: string }; label: string }

async function scope(context: CommandContext, client: ManagementClient): Promise<Scope> {
  const user = stringOption(context.options.user);
  const group = stringOption(context.options.group);
  if (user && group) throw new UsageError("Choose either --user or --group", context.commandName);
  if (user) { const resolved = await resolveUser(client, user); return { query: { userId: resolved.id }, label: `user ${resolved.username}` }; }
  if (group) { const resolved = await resolveGroup(client, group); return { query: { groupId: resolved.id }, label: `group ${resolved.name} (current members)` }; }
  return { query: {}, label: "all users" };
}

/** Best effort: a management key may lack the scopes to read names. */
async function optional<T>(load: () => Promise<T>, fallback: T): Promise<T> {
  try { return await load(); } catch (error) { if (error instanceof ApiError && [401, 403, 404].includes(error.status)) return fallback; throw error; }
}

async function eachLimited<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]!);
  }));
}

/** Names for the user, key and group IDs that appear in the events; only those are looked up. */
async function auditNames(client: ManagementClient, events: readonly AuditEvent[]) {
  const userIds = new Set<string>();
  let keys = false;
  let groups = false;
  for (const event of events) {
    for (const [type, id] of [[event.actorType, event.actorId], [event.targetType, event.targetId]] as const) {
      if (!id) continue;
      if (type === "user" || type === "setup") userIds.add(id);
      else if (type === "management_key" || type === "management_api_key") keys = true;
      else if (type === "group") groups = true;
    }
  }
  const names = new Map<string, string>();
  await Promise.all([
    eachLimited([...userIds], 8, async (id) => {
      const user = await optional(async () => (await call<{ data: User }>(client, "GET", `/users/${encodeURIComponent(id)}`)).data, null);
      if (user) names.set(`user:${id}`, user.username);
    }),
    keys && optional(async () => {
      for (const key of (await call<{ data: ManagementKey[] }>(client, "GET", "/management-keys")).data) names.set(`key:${key.id}`, `${key.name} (${key.keyPrefix})`);
    }, undefined),
    groups && optional(async () => {
      for (const group of (await listAll<Group>(client, "/groups")).items) names.set(`group:${group.id}`, group.name);
    }, undefined),
  ]);
  return (type: string, id: string | null) => {
    if (!id) return type;
    const kind = type === "user" || type === "setup" ? "user" : type === "management_key" || type === "management_api_key" ? "key" : type;
    return `${type} ${names.get(`${kind}:${id}`) ?? id}`;
  };
}

interface AuditEvent {
  id: string; actorType: string; actorId: string | null; action: string; targetType: string; targetId: string | null;
  requestId: string; metadata: Record<string, unknown>; createdAt: string;
}

const auditList: Command = {
  name: "list",
  summary: "List audit events, newest first",
  options: {
    action: { type: "string", value: "<action>", description: "Only this action, such as user.updated" },
    "target-type": { type: "string", value: "<type>", description: "Only this target type, such as user, group or api_key" },
    limit: { type: "string", value: "<n>", description: "Number of events (default 50, at most 1000)" },
    offset: { type: "string", value: "<n>", description: "Skip this many newer events" },
  },
  examples: ["aigctl audit list", "aigctl audit list --action user.updated --limit 200", "aigctl audit list --target-type api_key -o json"],
  async run(context) {
    const limit = optionalInteger("limit", context.options.limit, 1, 1000) ?? 50;
    const offset = optionalInteger("offset", context.options.offset, 0, Number.MAX_SAFE_INTEGER) ?? 0;
    const client = await context.client();
    const query: Query = { action: stringOption(context.options.action)?.trim(), targetType: stringOption(context.options["target-type"])?.trim() };
    const { items, total } = await listAll<AuditEvent>(client, "/audit-events", query, limit, offset);
    if (context.output === "json") return printJson(context.io, items);
    const name = await auditNames(client, items);
    const columns: Column<AuditEvent>[] = [
      { header: "TIME", value: (event) => formatTime(event.createdAt) },
      { header: "ACTION", value: (event) => event.action },
      { header: "ACTOR", value: (event) => name(event.actorType, event.actorId), maxWidth: 40 },
      { header: "TARGET", value: (event) => name(event.targetType, event.targetId), maxWidth: 40 },
      { header: "DETAILS", value: (event) => Object.keys(event.metadata ?? {}).length ? JSON.stringify(event.metadata) : "", maxWidth: 60 },
      { header: "REQUEST-ID", value: (event) => event.requestId, wide: true },
    ];
    printList(context.io, context.output, items, columns, "No audit events found.");
    if (items.length && offset + items.length < total) context.io.err(`Showing ${offset + 1}-${offset + items.length} of ${total}; use --limit and --offset for more.\n`);
  },
};

export const auditGroup: CommandGroup = {
  name: "audit",
  summary: "Audit history of administrative changes",
  details: "Changes made with aigctl inside the gateway container are recorded with the actor cli aigctl@<pod>, or cli <name> via aigctl@<pod> with --actor.",
  commands: [auditList],
};

interface UsageSummary {
  days: number; since: string; creditsConsumed: number; inputTokens: number; outputTokens: number; requests: number;
  byModel: { model: string | null; creditsConsumed: number; requests: number }[];
  byUser: { userId: string; username: string; creditsConsumed: number; requests: number }[];
}

interface UsageEvent {
  id: string; time: string; userId: string; username: string; source: string; type: string; model: string | null;
  creditsAdded: number; creditsConsumed: number; inputTokens: number; outputTokens: number;
}

export const usageGroup: CommandGroup = {
  name: "usage",
  summary: "Metered inference usage and the credit ledger",
  commands: [
    {
      name: "summary",
      summary: "Summarize metered inference over the last days, by model and user",
      options: { days: { type: "string", value: "<n>", description: "Days to include, 1-365 (default 30)" }, ...SCOPE_OPTIONS },
      examples: ["aigctl usage summary --days 7", "aigctl usage summary --group engineering"],
      async run(context) {
        const days = optionalInteger("days", context.options.days, 1, 365) ?? 30;
        const client = await context.client();
        const selected = await scope(context, client);
        const { data } = await call<{ data: UsageSummary }>(client, "GET", "/usage/summary", { query: { days, ...selected.query } });
        if (context.output === "json") return printJson(context.io, data);
        context.io.out(renderDetails([
          ["Period", `last ${data.days} day${data.days === 1 ? "" : "s"} (since ${formatTime(data.since)})`],
          ["Scope", selected.label],
          ["Requests", formatInteger(data.requests)],
          ["Credits consumed", formatCredits(data.creditsConsumed, 4)],
          ["Input tokens", formatInteger(data.inputTokens)],
          ["Output tokens", formatInteger(data.outputTokens)],
        ]));
        if (data.byModel.length) context.io.out(`\n${renderTable(data.byModel, [
          { header: "MODEL", value: (row) => row.model ?? "(none)" },
          { header: "REQUESTS", value: (row) => formatInteger(row.requests), align: "right" },
          { header: "CREDITS", value: (row) => formatCredits(row.creditsConsumed, 4), align: "right" },
        ])}`);
        if (data.byUser.length && !selected.query.userId) context.io.out(`\n${renderTable(data.byUser, [
          { header: "USER", value: (row) => row.username },
          { header: "REQUESTS", value: (row) => formatInteger(row.requests), align: "right" },
          { header: "CREDITS", value: (row) => formatCredits(row.creditsConsumed, 4), align: "right" },
        ])}`);
      },
    },
    {
      name: "events",
      summary: "List credit ledger events (usage, adjustments and resets), newest first",
      options: {
        ...SCOPE_OPTIONS,
        limit: { type: "string", value: "<n>", description: "Number of events (default 50, at most 1000)" },
        offset: { type: "string", value: "<n>", description: "Skip this many newer events" },
      },
      async run(context) {
        const limit = optionalInteger("limit", context.options.limit, 1, 1000) ?? 50;
        const offset = optionalInteger("offset", context.options.offset, 0, Number.MAX_SAFE_INTEGER) ?? 0;
        const client = await context.client();
        const selected = await scope(context, client);
        const { items, total } = await listAll<UsageEvent>(client, "/usage/events", selected.query, limit, offset);
        printList(context.io, context.output, items, [
          { header: "ID", value: (event) => event.id, wide: true },
          { header: "TIME", value: (event) => formatTime(event.time) },
          { header: "USER", value: (event) => event.username },
          { header: "TYPE", value: (event) => event.type },
          { header: "SOURCE", value: (event) => event.source, wide: true },
          { header: "MODEL", value: (event) => event.model, maxWidth: 45 },
          { header: "ADDED", value: (event) => event.creditsAdded ? formatCredits(event.creditsAdded, 4) : "", align: "right" },
          { header: "CONSUMED", value: (event) => event.creditsConsumed ? formatCredits(event.creditsConsumed, 4) : "", align: "right" },
          { header: "INPUT", value: (event) => event.inputTokens ? formatInteger(event.inputTokens) : "", align: "right" },
          { header: "OUTPUT", value: (event) => event.outputTokens ? formatInteger(event.outputTokens) : "", align: "right" },
        ], "No ledger events found.");
        if (context.output !== "json" && items.length && offset + items.length < total) context.io.err(`Showing ${offset + 1}-${offset + items.length} of ${total}; use --limit and --offset for more.\n`);
      },
    },
  ],
};

interface ThroughputStats {
  requests: number; tokens: number; activeHours: number; steadyStateTpm: number; steadyStateRpm: number;
  peakTpm: number; peakTpmAt: string | null; peakRpm: number; peakRpmAt: string | null;
  avgInputTokensPerRequest: number; avgOutputTokensPerRequest: number; avgCacheReadTokensPerRequest: number;
}

interface ThroughputReport { start: string; end: string; summary: ThroughputStats; models: (ThroughputStats & { model: string | null })[] }

const THROUGHPUT_COLUMNS: Column<ThroughputStats & { model: string }>[] = [
  { header: "MODEL", value: (row) => row.model, maxWidth: 45 },
  { header: "REQUESTS", value: (row) => formatInteger(row.requests), align: "right" },
  { header: "TOKENS", value: (row) => formatInteger(row.tokens), align: "right" },
  { header: "ACTIVE-HOURS", value: (row) => formatInteger(row.activeHours), align: "right" },
  { header: "STEADY-TPM", value: (row) => formatInteger(row.steadyStateTpm), align: "right" },
  { header: "PEAK-TPM", value: (row) => formatInteger(row.peakTpm), align: "right" },
  { header: "PEAK-TPM-AT", value: (row) => formatTime(row.peakTpmAt), wide: true },
  { header: "STEADY-RPM", value: (row) => formatDecimal(row.steadyStateRpm, 2), align: "right" },
  { header: "PEAK-RPM", value: (row) => formatInteger(row.peakRpm), align: "right" },
  { header: "PEAK-RPM-AT", value: (row) => formatTime(row.peakRpmAt), wide: true },
  { header: "AVG-INPUT", value: (row) => formatInteger(row.avgInputTokensPerRequest), align: "right" },
  { header: "AVG-OUTPUT", value: (row) => formatInteger(row.avgOutputTokensPerRequest), align: "right" },
  { header: "AVG-CACHE-READ", value: (row) => formatInteger(row.avgCacheReadTokensPerRequest), align: "right", wide: true },
];

export const analyticsGroup: CommandGroup = {
  name: "analytics",
  summary: "Usage analytics and Bedrock throughput",
  commands: [
    {
      name: "throughput",
      summary: "Steady-state and peak tokens and requests per minute, for Bedrock quota requests",
      details: `Tokens follow Bedrock's quota accounting: input, cache writes and output; cache reads are excluded.
Steady state averages the hours that had traffic; peaks are the busiest UTC minute.`,
      options: { ...RANGE_OPTION, ...SCOPE_OPTIONS },
      examples: ["aigctl analytics throughput", "aigctl analytics throughput --range week -o wide"],
      async run(context) {
        const range = timeRange(context);
        const client = await context.client();
        const selected = await scope(context, client);
        const { data } = await call<{ data: ThroughputReport }>(client, "GET", "/analytics/throughput", { query: { timeRange: range, ...selected.query } });
        if (context.output === "json") return printJson(context.io, data);
        context.io.out(`${TIME_RANGES[range].label} (${formatTime(data.start)} to ${formatTime(data.end)}), ${selected.label}\n\n`);
        context.io.out(renderTable([{ ...data.summary, model: "all models" }, ...data.models.map((row) => ({ ...row, model: row.model ?? "(none)" }))], THROUGHPUT_COLUMNS, context.output === "wide"));
      },
    },
    {
      name: "users",
      summary: "Credits used per user",
      options: { ...RANGE_OPTION, group: SCOPE_OPTIONS.group },
      async run(context) {
        const range = timeRange(context);
        const client = await context.client();
        const group = stringOption(context.options.group);
        const groupId = group ? (await resolveGroup(client, group)).id : undefined;
        const { data } = await call<{ data: { users: { userId: string; username: string; creditsUsed: number; activeDays: number; avgCreditsPerDay: number; lastActivity: string | null; percentOfTotal: number }[] } }>(
          client, "GET", "/analytics/users", { query: { timeRange: range, groupId } });
        printList(context.io, context.output, data.users, [
          { header: "USER-ID", value: (row) => row.userId, wide: true },
          { header: "USERNAME", value: (row) => row.username },
          { header: "CREDITS", value: (row) => formatCredits(row.creditsUsed), align: "right" },
          { header: "ACTIVE-DAYS", value: (row) => row.activeDays, align: "right" },
          { header: "AVG/DAY", value: (row) => formatCredits(row.avgCreditsPerDay), align: "right" },
          { header: "LAST-ACTIVITY", value: (row) => formatTime(row.lastActivity) },
          { header: "SHARE", value: (row) => `${row.percentOfTotal.toFixed(1)}%`, align: "right" },
        ], `No usage in the ${TIME_RANGES[range].label.toLowerCase()}.`, data);
      },
    },
    {
      name: "groups",
      summary: "Credits used per group (current members)",
      options: { ...RANGE_OPTION },
      async run(context) {
        const range = timeRange(context);
        const { data } = await call<{ data: { groups: { groupId: string; groupName: string; creditsUsed: number; activeUsers: number; avgCreditsPerUser: number }[] } }>(
          await context.client(), "GET", "/analytics/groups", { query: { timeRange: range } });
        printList(context.io, context.output, data.groups, [
          { header: "GROUP-ID", value: (row) => row.groupId, wide: true },
          { header: "GROUP", value: (row) => row.groupName },
          { header: "CREDITS", value: (row) => formatCredits(row.creditsUsed), align: "right" },
          { header: "ACTIVE-USERS", value: (row) => row.activeUsers, align: "right" },
          { header: "AVG/USER", value: (row) => formatCredits(row.avgCreditsPerUser), align: "right" },
        ], `No group usage in the ${TIME_RANGES[range].label.toLowerCase()}.`, data);
      },
    },
    {
      name: "models",
      summary: "Credits and tokens per upstream model",
      options: { ...RANGE_OPTION, ...SCOPE_OPTIONS },
      async run(context) {
        const range = timeRange(context);
        const client = await context.client();
        const selected = await scope(context, client);
        const { data } = await call<{ data: { models: { model: string; totalCredits: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWrite5mTokens: number; cacheWrite1hTokens: number; percentOfTotal: number }[] } }>(
          client, "GET", "/analytics/model-summary", { query: { timeRange: range, ...selected.query } });
        printList(context.io, context.output, data.models, [
          { header: "MODEL", value: (row) => row.model, maxWidth: 50 },
          { header: "CREDITS", value: (row) => formatCredits(row.totalCredits), align: "right" },
          { header: "INPUT", value: (row) => formatInteger(row.inputTokens), align: "right" },
          { header: "OUTPUT", value: (row) => formatInteger(row.outputTokens), align: "right" },
          { header: "CACHE-READ", value: (row) => formatInteger(row.cacheReadTokens), align: "right" },
          { header: "CACHE-WRITE", value: (row) => formatInteger(row.cacheWrite5mTokens + row.cacheWrite1hTokens), align: "right" },
          { header: "SHARE", value: (row) => `${row.percentOfTotal.toFixed(1)}%`, align: "right" },
        ], `No model usage in the ${TIME_RANGES[range].label.toLowerCase()}.`, data);
      },
    },
  ],
};

export const creditsGroup: CommandGroup = {
  name: "credits",
  summary: "Monthly credit reset",
  details: `Set a user's balance with 'aigctl users update <user> --balance'. Monthly credits are set per user with
'aigctl users update <user> --monthly-credits' and for every member of groups with 'aigctl groups bulk-update --monthly-credits'.`,
  commands: [{
    name: "monthly-reset",
    summary: "Reset every user with monthly credits to that balance now",
    details: "The gateway also runs this reset automatically on the first day of each month (UTC). Users with 0 monthly credits are skipped.",
    options: { ...YES_OPTION },
    async run(context) {
      await confirm(context, "Reset every user with monthly credits to that balance now");
      const { data } = await call<{ data: { usersReset: number } }>(await context.client(), "POST", "/users/monthly-reset");
      report(context, `Reset ${data.usersReset} user${data.usersReset === 1 ? "" : "s"} to their monthly credits.`, data);
    },
  }],
};
