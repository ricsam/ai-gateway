// Models, aliases and apps: the model catalog API clients see at /v1/models.
import { ALIAS_ID_PATTERN, APP_NAME_PATTERN, DEFAULT_APP_TIERS } from "../../../shared/alias-contract";
import { EFFORT_LEVELS, REASONING_EFFORT_VALUES, REASONING_MODE_LABELS, REASONING_MODES, type ReasoningMode } from "../../../shared/reasoning";
import { call, type ManagementClient } from "../client";
import { CliError, UsageError } from "../errors";
import type { Command, CommandContext, CommandGroup, OptionSpec, OptionValue } from "../framework";
import { confirm, listOption, optionalAmount, optionalBoolean, optionalInteger, parseAmount, parseInteger, parseRegion, stringOption, YES_OPTION } from "../inputs";
import { formatInteger, formatPrice, formatTime, printJson, printList, renderDetails, renderTable, type Column } from "../output";
import { listAliases, listApps, listModels, resolveAlias, resolveApp, resolveModel, type Alias, type App, type Model } from "../resources";
import { parseChoice, report } from "./common";

const MAX_TOKENS = 100_000_000;

/** An alias's public model ID, checked before anything is sent. */
function aliasId(context: CommandContext, value: string, what: string): string {
  const id = value.trim();
  if (!ALIAS_ID_PATTERN.test(id) || id.length > 128) {
    throw new UsageError(`${what} must be 1-128 lowercase letters, digits, dots, underscores or hyphens, such as claude-opus-max; '${value}' is not`, context.commandName);
  }
  return id;
}

/** An app name, checked before anything is sent. */
function appName(context: CommandContext, value: string, what: string): string {
  const name = value.trim();
  if (!APP_NAME_PATTERN.test(name) || name.length > 128) throw new UsageError(`${what} must be lowercase kebab-case, such as chat-app; '${value}' is not`, context.commandName);
  return name;
}
const CLEAR_VALUES = new Set(["", "none"]);
const DEFAULT_VALUES = new Set(["", "default"]);

function nullableText(value: OptionValue): string | null | undefined {
  const text = stringOption(value);
  return text === undefined ? undefined : text.trim() || null;
}
function nullablePrice(flag: string, value: OptionValue): number | null | undefined {
  const text = stringOption(value);
  if (text === undefined) return undefined;
  return CLEAR_VALUES.has(text.trim().toLowerCase()) ? null : parseAmount(flag, text);
}
function nullableTokens(flag: string, value: OptionValue): number | null | undefined {
  const text = stringOption(value);
  if (text === undefined) return undefined;
  return CLEAR_VALUES.has(text.trim().toLowerCase()) ? null : parseInteger(flag, text, 1, MAX_TOKENS);
}
function nullableRegion(value: OptionValue): string | null | undefined {
  const text = stringOption(value);
  if (text === undefined) return undefined;
  return DEFAULT_VALUES.has(text.trim().toLowerCase()) ? null : parseRegion("region", text);
}
/** An effort from `values`, or null for '' or default. */
function nullableEffort(context: CommandContext, flag: string, value: OptionValue, values: readonly string[]): string | null | undefined {
  const text = stringOption(value);
  if (text === undefined) return undefined;
  const normalized = text.trim().toLowerCase();
  if (DEFAULT_VALUES.has(normalized)) return null;
  if (!values.includes(normalized)) throw new UsageError(`--${flag} must be one of ${values.join(", ")}, or default`, context.commandName);
  return normalized;
}
function setDefined(target: Record<string, unknown>, key: string, value: unknown) {
  if (value !== undefined) target[key] = value;
}

// ---------------------------------------------------------------- models

const MODEL_OPTIONS: Record<string, OptionSpec> = {
  "model-id": { type: "string", value: "<id>", description: "Bedrock model ID, inference profile ID or ARN; also the model ID API clients use" },
  name: { type: "string", value: "<name>", description: "Display name" },
  description: { type: "string", value: "<text>", description: "Description ('' clears it)" },
  "input-price": { type: "string", value: "<usd>", description: "Input price per million tokens" },
  "output-price": { type: "string", value: "<usd>", description: "Output price per million tokens" },
  "cache-read-price": { type: "string", value: "<usd>", description: "Cache read price per million tokens ('' or none: no cache price)" },
  "cache-write-5m-price": { type: "string", value: "<usd>", description: "5-minute cache write price per million tokens ('' or none clears it)" },
  "cache-write-1h-price": { type: "string", value: "<usd>", description: "1-hour cache write price per million tokens ('' or none clears it)" },
  "context-window": { type: "string", value: "<tokens>", description: "Context window shown to users ('' or none clears it)" },
  "max-output-tokens": { type: "string", value: "<tokens>", description: "Upper bound for output tokens per request (default 32000)" },
  region: { type: "string", value: "<region>", description: "AWS region for this model ('' or default: the AWS default region)" },
  thinking: { type: "string", value: "<bool>", description: "Honor reasoning_effort requests (reasoning controls)" },
  "reasoning-mode": { type: "string", value: "<mode>", description: `How effort is sent to Bedrock: ${REASONING_MODES.join(", ")} (auto detects it from the model ID)` },
  "default-effort": { type: "string", value: "<effort>", description: `Effort when a request has none: ${REASONING_EFFORT_VALUES.join(", ")}, or default (leave it to the request)` },
  "managed-cache": { type: "string", value: "<bool>", description: "Insert prompt cache points into requests" },
};

/** The management API fields that the given model options set. */
function modelChanges(context: CommandContext): Record<string, unknown> {
  const options = context.options;
  const changes: Record<string, unknown> = {};
  const modelId = stringOption(options["model-id"]);
  if (modelId !== undefined) changes.modelId = modelId.trim();
  const name = stringOption(options.name);
  if (name !== undefined) changes.name = name.trim();
  setDefined(changes, "description", nullableText(options.description));
  setDefined(changes, "inputPricePerMTok", optionalAmount("input-price", options["input-price"]));
  setDefined(changes, "outputPricePerMTok", optionalAmount("output-price", options["output-price"]));
  setDefined(changes, "cacheReadPricePerMTok", nullablePrice("cache-read-price", options["cache-read-price"]));
  setDefined(changes, "cacheWrite5mPricePerMTok", nullablePrice("cache-write-5m-price", options["cache-write-5m-price"]));
  setDefined(changes, "cacheWrite1hPricePerMTok", nullablePrice("cache-write-1h-price", options["cache-write-1h-price"]));
  setDefined(changes, "contextWindow", nullableTokens("context-window", options["context-window"]));
  setDefined(changes, "maxOutputTokens", optionalInteger("max-output-tokens", options["max-output-tokens"], 1, MAX_TOKENS));
  setDefined(changes, "region", nullableRegion(options.region));
  setDefined(changes, "thinking", optionalBoolean("thinking", options.thinking));
  setDefined(changes, "reasoningMode", parseChoice(context, "reasoning-mode", stringOption(options["reasoning-mode"]), REASONING_MODES));
  setDefined(changes, "defaultReasoningEffort", nullableEffort(context, "default-effort", options["default-effort"], REASONING_EFFORT_VALUES));
  setDefined(changes, "managedCache", optionalBoolean("managed-cache", options["managed-cache"]));
  return changes;
}

const MODEL_COLUMNS: Column<Model>[] = [
  { header: "ID", value: (model) => model.id, wide: true },
  { header: "NAME", value: (model) => model.name, maxWidth: 32 },
  { header: "MODEL-ID", value: (model) => model.modelId, maxWidth: 60 },
  { header: "ENABLED", value: (model) => model.enabled },
  { header: "AVAILABLE", value: (model) => model.available },
  { header: "INPUT/MTOK", value: (model) => formatPrice(model.inputPricePerMTok), align: "right" },
  { header: "OUTPUT/MTOK", value: (model) => formatPrice(model.outputPricePerMTok), align: "right" },
  { header: "CACHE-READ/MTOK", value: (model) => formatPrice(model.cacheReadPricePerMTok), align: "right", wide: true },
  { header: "CACHE-WRITE-5M/MTOK", value: (model) => formatPrice(model.cacheWrite5mPricePerMTok), align: "right", wide: true },
  { header: "CACHE-WRITE-1H/MTOK", value: (model) => formatPrice(model.cacheWrite1hPricePerMTok), align: "right", wide: true },
  { header: "REGION", value: (model) => model.region || "default" },
  { header: "THINKING", value: (model) => model.thinking },
  { header: "REASONING", value: (model) => model.reasoningMode, wide: true },
  { header: "DEFAULT-EFFORT", value: (model) => model.defaultReasoningEffort ?? "default", wide: true },
  { header: "MANAGED-CACHE", value: (model) => model.managedCache },
  { header: "CONTEXT", value: (model) => formatInteger(model.contextWindow), align: "right", wide: true },
  { header: "MAX-OUTPUT", value: (model) => formatInteger(model.maxOutputTokens), align: "right", wide: true },
];

function modelState(model: Model): string {
  if (model.available) return "yes";
  if (!model.enabled) return "no (disabled)";
  return model.provider === "bedrock" ? "no (/v1/models doesn't list it)" : `no (provider ${model.provider} is not served)`;
}

function modelDetails(model: Model, aliases: readonly Alias[]): string {
  const mode = REASONING_MODE_LABELS[model.reasoningMode as ReasoningMode] ?? model.reasoningMode;
  return renderDetails([
    ["ID", model.id],
    ["Model ID", model.modelId],
    ["Name", model.name],
    ["Description", model.description],
    ["Enabled", model.enabled],
    ["Available to API clients", modelState(model)],
    ["Input price", `${formatPrice(model.inputPricePerMTok)} per million tokens`],
    ["Output price", `${formatPrice(model.outputPricePerMTok)} per million tokens`],
    ["Cache read price", model.cacheReadPricePerMTok === null ? "-" : `${formatPrice(model.cacheReadPricePerMTok)} per million tokens`],
    ["Cache write price (5 min)", model.cacheWrite5mPricePerMTok === null ? "-" : `${formatPrice(model.cacheWrite5mPricePerMTok)} per million tokens`],
    ["Cache write price (1 h)", model.cacheWrite1hPricePerMTok === null ? "-" : `${formatPrice(model.cacheWrite1hPricePerMTok)} per million tokens`],
    ["Context window", formatInteger(model.contextWindow)],
    ["Max output tokens", formatInteger(model.maxOutputTokens)],
    ["Region", model.region || "AWS default region"],
    ["Reasoning controls", model.thinking],
    ["Reasoning control", mode],
    ["Default effort", model.defaultReasoningEffort ?? "request's choice"],
    ["Managed cache", model.managedCache],
    ["Aliases", aliases.map((alias) => alias.modelId)],
    ["Created", formatTime(model.createdAt)],
    ["Updated", formatTime(model.updatedAt)],
  ]);
}

const modelsList: Command = {
  name: "list",
  summary: "List configured models",
  details: "AVAILABLE says whether API clients can use the model: /v1/models lists it.",
  async run(context) {
    printList(context.io, context.output, await listModels(await context.client()), MODEL_COLUMNS, "No models are configured.");
  },
};

const modelsGet: Command = {
  name: "get",
  summary: "Show a model",
  usage: "<model>",
  details: "<model> is the model's ID, Bedrock model ID or name.",
  async run(context) {
    const client = await context.client();
    const model = await resolveModel(client, context.args[0]!);
    if (context.output === "json") return printJson(context.io, model);
    const aliases = (await listAliases(client)).filter((alias) => alias.upstreamModelId === model.id);
    context.io.out(modelDetails(model, aliases));
  },
};

const modelsCreate: Command = {
  name: "create",
  summary: "Add a Bedrock model with its prices",
  details: `Requests for the model go to --model-id, which API clients also use as the model ID. Prices are USD per
million tokens and set what each request costs in credits. The model is enabled unless --disabled is given.
Check that Bedrock accepts it with 'aigctl aws test <model>'.`,
  options: { ...MODEL_OPTIONS, disabled: { type: "boolean", description: "Add the model disabled" } },
  examples: [
    "aigctl models create --model-id us.anthropic.claude-opus-4-6-v1 --name 'Claude Opus 4.6' --input-price 5 --output-price 25 \\\n    --cache-read-price 0.5 --cache-write-5m-price 6.25 --thinking on --max-output-tokens 128000",
    "aigctl models create --model-id amazon.nova-pro-v1:0 --name 'Nova Pro' --input-price 0.8 --output-price 3.2 --region us-east-1",
  ],
  async run(context) {
    const changes = modelChanges(context);
    if (!changes.modelId) throw new UsageError("--model-id is required", context.commandName);
    if (changes.inputPricePerMTok === undefined || changes.outputPricePerMTok === undefined) {
      throw new UsageError("--input-price and --output-price are required (USD per million tokens; 0 makes requests free)", context.commandName);
    }
    changes.name ??= changes.modelId;
    if (context.options.disabled === true) changes.enabled = false;
    const { data } = await call<{ data: Model }>(await context.client(), "POST", "/models", { json: changes });
    report(context, `Added model ${data.name}${data.enabled ? `: API clients use the model ID ${data.modelId}` : ` (${data.modelId}), disabled`}. Test it with 'aigctl aws test ${data.modelId}'.`, data);
  },
};

const modelsUpdate: Command = {
  name: "update",
  summary: "Change a model's settings or prices",
  usage: "<model>",
  details: `<model> is the model's ID, Bedrock model ID or name. Changing --model-id also changes the model ID API clients use.
Changes that would make one of the model's aliases invalid are refused.`,
  options: MODEL_OPTIONS,
  examples: ["aigctl models update us.anthropic.claude-opus-4-6-v1 --input-price 4 --output-price 20", "aigctl models update 'Claude Opus 4.6' --region '' --default-effort high"],
  async run(context) {
    const changes = modelChanges(context);
    if (!Object.keys(changes).length) throw new UsageError("Nothing to change: pass at least one option", context.commandName);
    const client = await context.client();
    const model = await resolveModel(client, context.args[0]!);
    const { data } = await call<{ data: Model }>(client, "PATCH", `/models/${encodeURIComponent(model.id)}`, { json: changes });
    report(context, `Updated model ${data.name} (${data.modelId}).`, data);
  },
};

function modelsToggle(enabled: boolean): Command {
  return {
    name: enabled ? "enable" : "disable",
    summary: enabled ? "Make a model available to API clients again" : "Stop API clients from using a model and its aliases",
    usage: "<model>",
    async run(context) {
      const client = await context.client();
      const model = await resolveModel(client, context.args[0]!);
      const { data } = await call<{ data: Model }>(client, "PATCH", `/models/${encodeURIComponent(model.id)}`, { json: { enabled } });
      const aliases = (await listAliases(client)).filter((alias) => alias.upstreamModelId === model.id).map((alias) => alias.modelId);
      const note = aliases.length ? ` Its aliases (${aliases.join(", ")}) ${enabled ? "work again where they are enabled" : "are unavailable too"}.` : "";
      report(context, `${enabled ? "Enabled" : "Disabled"} model ${data.name} (${data.modelId}).${note}`, data);
    },
  };
}

const modelsDelete: Command = {
  name: "delete",
  summary: "Delete a model that no alias uses",
  usage: "<model>",
  details: "Usage history keeps the model's ID. A model that an alias uses is refused: change or delete the alias first.",
  options: { ...YES_OPTION },
  async run(context) {
    const client = await context.client();
    const model = await resolveModel(client, context.args[0]!);
    await confirm(context, `Delete model ${model.name} (${model.modelId})`, "API clients can no longer use it; its usage history is kept.");
    await call(client, "DELETE", `/models/${encodeURIComponent(model.id)}`);
    report(context, `Deleted model ${model.name} (${model.modelId}).`, { success: true, id: model.id, modelId: model.modelId });
  },
};

export const modelsGroup: CommandGroup = {
  name: "models",
  summary: "Bedrock models: prices, limits, regions and reasoning",
  details: `Commands that take <model> accept a model's ID, Bedrock model ID or name. Test a model with 'aigctl aws test <model>'.
Aliases ('aigctl aliases') and apps ('aigctl apps') give models more public model IDs.`,
  commands: [modelsList, modelsGet, modelsCreate, modelsUpdate, modelsToggle(true), modelsToggle(false), modelsDelete],
};

// ---------------------------------------------------------------- aliases

const REASONING_SOURCES = { alias: "alias", pinned: "alias", client: "client" } as const;

function reasoningSource(context: CommandContext, value: OptionValue): "alias" | "client" | undefined {
  const text = stringOption(value)?.trim().toLowerCase();
  if (text === undefined) return undefined;
  const source = REASONING_SOURCES[text as keyof typeof REASONING_SOURCES];
  if (!source) throw new UsageError("--reasoning must be pinned (the alias sets thinking and effort) or client (requests choose reasoning_effort)", context.commandName);
  return source;
}

const ALIAS_OPTIONS: Record<string, OptionSpec> = {
  name: { type: "string", value: "<name>", description: "Display name" },
  description: { type: "string", value: "<text>", description: "Description ('' clears it)" },
  upstream: { type: "string", value: "<model>", description: "The model requests go to (ID, Bedrock model ID or name)" },
  reasoning: { type: "string", value: "<who>", description: "pinned (default): the alias sets thinking and effort; client: requests choose reasoning_effort" },
  thinking: { type: "string", value: "<bool>", description: "Pinned aliases: think before answering" },
  effort: { type: "string", value: "<effort>", description: `Pinned aliases: ${EFFORT_LEVELS.join(", ")}; default sets none (only with --thinking off)` },
};

async function aliasChanges(context: CommandContext, client: ManagementClient): Promise<Record<string, unknown>> {
  const options = context.options;
  const changes: Record<string, unknown> = {};
  const name = stringOption(options.name);
  if (name !== undefined) changes.name = name.trim();
  setDefined(changes, "description", nullableText(options.description));
  setDefined(changes, "reasoningSource", reasoningSource(context, options.reasoning));
  setDefined(changes, "thinking", optionalBoolean("thinking", options.thinking));
  setDefined(changes, "effort", nullableEffort(context, "effort", options.effort, EFFORT_LEVELS));
  const upstream = stringOption(options.upstream);
  if (upstream !== undefined) changes.upstreamModelId = (await resolveModel(client, upstream)).id;
  return changes;
}

function aliasReasoning(alias: Alias): string {
  if (alias.reasoningSource === "client") return "client";
  return `pinned: thinking ${alias.thinking ? "on" : "off"}, effort ${alias.effort ?? "default"}`;
}

function aliasState(alias: Alias, upstream: Model | undefined): string {
  if (alias.available) return "yes";
  if (!alias.enabled) return "no (disabled)";
  if (!upstream) return "no (its upstream model is missing)";
  if (!upstream.enabled) return `no (its upstream model ${upstream.modelId} is disabled)`;
  if (!upstream.available) return `no (its upstream model ${upstream.modelId} isn't available)`;
  return "no (its reasoning settings don't suit the upstream model)";
}

function aliasColumns(models: ReadonlyMap<string, Model>): Column<Alias>[] {
  return [
    { header: "ID", value: (alias) => alias.id, wide: true },
    { header: "ALIAS", value: (alias) => alias.modelId },
    { header: "NAME", value: (alias) => alias.name, maxWidth: 28 },
    { header: "UPSTREAM", value: (alias) => models.get(alias.upstreamModelId)?.modelId ?? alias.upstreamModelId, maxWidth: 48 },
    { header: "REASONING", value: (alias) => alias.reasoningSource === "client" ? "client" : "pinned" },
    { header: "THINKING", value: (alias) => alias.reasoningSource === "client" ? "-" : alias.thinking },
    { header: "EFFORT", value: (alias) => alias.reasoningSource === "client" ? "-" : alias.effort ?? "default" },
    { header: "ENABLED", value: (alias) => alias.enabled },
    { header: "AVAILABLE", value: (alias) => alias.available },
    { header: "DESCRIPTION", value: (alias) => alias.description, wide: true },
    { header: "CREATED", value: (alias) => formatTime(alias.createdAt), wide: true },
  ];
}

const aliasesList: Command = {
  name: "list",
  summary: "List model aliases",
  details: "AVAILABLE says whether API clients can use the alias: /v1/models lists it.",
  async run(context) {
    const client = await context.client();
    const [aliases, models] = await Promise.all([listAliases(client), listModels(client)]);
    printList(context.io, context.output, aliases, aliasColumns(new Map(models.map((model) => [model.id, model]))), "No model aliases are configured.");
  },
};

const aliasesGet: Command = {
  name: "get",
  summary: "Show a model alias and the app tiers that use it",
  usage: "<alias>",
  async run(context) {
    const client = await context.client();
    const [aliases, models, apps] = await Promise.all([listAliases(client), listModels(client), listApps(client)]);
    const alias = await resolveAlias(client, context.args[0]!, aliases);
    if (context.output === "json") return printJson(context.io, alias);
    const upstream = models.find((model) => model.id === alias.upstreamModelId);
    const tiers = apps.flatMap((app) => app.tiers.filter((tier) => tier.aliasId === alias.id).map((tier) => tier.modelId));
    context.io.out(renderDetails([
      ["ID", alias.id], ["Alias", alias.modelId], ["Name", alias.name], ["Description", alias.description],
      ["Upstream model", upstream ? `${upstream.name} (${upstream.modelId})` : alias.upstreamModelId],
      ["Reasoning", alias.reasoningSource === "client" ? "client: requests choose reasoning_effort" : aliasReasoning(alias)],
      ["Enabled", alias.enabled], ["Available to API clients", aliasState(alias, upstream)],
      ["Used by app tiers", tiers], ["Created", formatTime(alias.createdAt)], ["Updated", formatTime(alias.updatedAt)],
    ]));
  },
};

const aliasesCreate: Command = {
  name: "create",
  summary: "Add a public model ID for a model, with its own name and reasoning settings",
  usage: "<alias>",
  details: `<alias> is the public model ID API clients send, such as claude-opus-max-thinking: lowercase letters, digits,
dots, underscores and hyphens. Pinned aliases (the default) set thinking and effort, and requests cannot change them;
with --reasoning client, requests choose reasoning_effort within what the upstream model supports.
Prices, limits and region come from the upstream model.`,
  options: { ...ALIAS_OPTIONS, disabled: { type: "boolean", description: "Add the alias disabled" } },
  examples: [
    "aigctl aliases create claude-opus-max-thinking --upstream us.anthropic.claude-opus-4-6-v1 --thinking on --effort max",
    "aigctl aliases create claude-opus --upstream 'Claude Opus 4.6' --reasoning client",
  ],
  async run(context) {
    const client = await context.client();
    const changes = await aliasChanges(context, client);
    if (!changes.upstreamModelId) throw new UsageError("--upstream is required: the model requests go to", context.commandName);
    const modelId = aliasId(context, context.args[0]!, "The alias");
    const { data } = await call<{ data: Alias }>(client, "POST", "/model-aliases", { json: {
      modelId, name: modelId, ...changes, ...(context.options.disabled === true && { enabled: false }),
    } });
    const upstream = (await listModels(client)).find((model) => model.id === data.upstreamModelId);
    const state = data.available ? `API clients can use the model ID ${data.modelId}` : `not available yet: ${aliasState(data, upstream).replace(/^no \(|\)$/g, "")}`;
    report(context, `Added alias ${data.modelId} for ${upstream?.modelId ?? data.upstreamModelId} (${aliasReasoning(data)}); ${state}.`, data);
  },
};

const aliasesUpdate: Command = {
  name: "update",
  summary: "Change a model alias",
  usage: "<alias>",
  details: "<alias> is the alias's ID, public model ID or name. Changing --public-id also changes the model ID API clients send.",
  options: {
    "public-id": { type: "string", value: "<id>", description: "New public model ID" },
    ...ALIAS_OPTIONS,
  },
  examples: ["aigctl aliases update claude-opus-max-thinking --effort high", "aigctl aliases update claude-opus --upstream us.anthropic.claude-opus-4-7-v1"],
  async run(context) {
    const client = await context.client();
    const changes = await aliasChanges(context, client);
    const publicId = stringOption(context.options["public-id"]);
    if (publicId !== undefined) changes.modelId = aliasId(context, publicId, "--public-id");
    if (!Object.keys(changes).length) throw new UsageError("Nothing to change: pass at least one option", context.commandName);
    const alias = await resolveAlias(client, context.args[0]!);
    const { data } = await call<{ data: Alias }>(client, "PATCH", `/model-aliases/${encodeURIComponent(alias.id)}`, { json: changes });
    report(context, `Updated alias ${data.modelId} (${aliasReasoning(data)}).`, data);
  },
};

function aliasesToggle(enabled: boolean): Command {
  return {
    name: enabled ? "enable" : "disable",
    summary: enabled ? "Make a model alias available again" : "Stop API clients from using a model alias and its app tiers",
    usage: "<alias>",
    async run(context) {
      const client = await context.client();
      const alias = await resolveAlias(client, context.args[0]!);
      const { data } = await call<{ data: Alias }>(client, "PATCH", `/model-aliases/${encodeURIComponent(alias.id)}`, { json: { enabled } });
      let note = "";
      if (enabled && !data.available) {
        const upstream = (await listModels(client)).find((model) => model.id === data.upstreamModelId);
        note = `, but it is not available: ${aliasState(data, upstream).replace(/^no \(|\)$/g, "")}`;
      }
      report(context, `${enabled ? "Enabled" : "Disabled"} alias ${data.modelId}${note}.`, data);
    },
  };
}

const aliasesDelete: Command = {
  name: "delete",
  summary: "Delete a model alias that no app tier uses",
  usage: "<alias>",
  options: { ...YES_OPTION },
  async run(context) {
    const client = await context.client();
    const alias = await resolveAlias(client, context.args[0]!);
    await confirm(context, `Delete alias ${alias.modelId}`, "API clients can no longer use its model ID.");
    await call(client, "DELETE", `/model-aliases/${encodeURIComponent(alias.id)}`);
    report(context, `Deleted alias ${alias.modelId}.`, { success: true, id: alias.id, modelId: alias.modelId });
  },
};

export const aliasesGroup: CommandGroup = {
  name: "aliases",
  summary: "Model aliases: public model IDs with pinned or client-chosen reasoning",
  details: "Commands that take <alias> accept an alias's ID, public model ID or name.",
  commands: [aliasesList, aliasesGet, aliasesCreate, aliasesUpdate, aliasesToggle(true), aliasesToggle(false), aliasesDelete],
};

// ---------------------------------------------------------------- apps

function tierName(context: CommandContext, value: string): string {
  const name = value.trim();
  if (!APP_NAME_PATTERN.test(name) || name.length > 128) throw new UsageError(`Tier names are lowercase kebab-case, such as max or long-context; '${value}' is not`, context.commandName);
  return name;
}

function tierSummary(app: App, aliases: ReadonlyMap<string, Alias>): string {
  return app.tiers.map((tier) => tier.aliasId ? `${tier.name}=${aliases.get(tier.aliasId)?.modelId ?? tier.aliasId}` : tier.name).join(", ");
}

const appsList: Command = {
  name: "list",
  summary: "List apps",
  details: "TIERS lists each tier, with tier=alias where it is mapped; AVAILABLE counts the tiers API clients can use.",
  async run(context) {
    const client = await context.client();
    const [apps, aliases] = await Promise.all([listApps(client), listAliases(client)]);
    const byId = new Map(aliases.map((alias) => [alias.id, alias]));
    printList(context.io, context.output, apps, [
      { header: "ID", value: (app) => app.id, wide: true },
      { header: "APP", value: (app) => app.name },
      { header: "ENABLED", value: (app) => app.enabled },
      { header: "TIERS", value: (app) => tierSummary(app, byId), maxWidth: 70 },
      { header: "AVAILABLE", value: (app) => `${app.tiers.filter((tier) => tier.available).length} of ${app.tiers.length}`, align: "right" },
      { header: "DESCRIPTION", value: (app) => app.description, wide: true },
    ], "No apps are configured.");
  },
};

async function showApp(context: CommandContext, app: App) {
  if (context.output === "json") return printJson(context.io, app);
  const client = await context.client();
  const [aliases, models] = await Promise.all([listAliases(client), listModels(client)]);
  const aliasById = new Map(aliases.map((alias) => [alias.id, alias]));
  const modelById = new Map(models.map((model) => [model.id, model]));
  context.io.out(renderDetails([
    ["ID", app.id], ["App", app.name], ["Description", app.description], ["Enabled", app.enabled],
    ["Created", formatTime(app.createdAt)], ["Updated", formatTime(app.updatedAt)],
  ]));
  context.io.out(`\n${renderTable(app.tiers, [
    { header: "TIER", value: (tier) => tier.name },
    { header: "MODEL-ID", value: (tier) => tier.modelId },
    { header: "ALIAS", value: (tier) => tier.aliasId ? aliasById.get(tier.aliasId)?.modelId ?? tier.aliasId : "-" },
    { header: "UPSTREAM", value: (tier) => { const alias = tier.aliasId ? aliasById.get(tier.aliasId) : undefined; return alias ? modelById.get(alias.upstreamModelId)?.modelId ?? "-" : "-"; }, maxWidth: 48 },
    { header: "AVAILABLE", value: (tier) => tier.available },
  ], context.output === "wide")}`);
}

const appsGet: Command = {
  name: "get",
  summary: "Show an app and its tiers",
  usage: "<app>",
  async run(context) {
    await showApp(context, await resolveApp(await context.client(), context.args[0]!));
  },
};

const appsCreate: Command = {
  name: "create",
  summary: "Add an app: public model IDs <app>-<tier> that map to aliases",
  usage: "<app>",
  details: `<app> is lowercase kebab-case, such as chat-app; API clients then send <app>-<tier>, such as chat-app-max.
Tiers default to ${DEFAULT_APP_TIERS.join(", ")}. Unmapped tiers reserve their model IDs but aren't available until
they are mapped to an alias ('aigctl apps set-tier'). A tier takes its reasoning settings from its alias.`,
  options: {
    description: { type: "string", value: "<text>", description: "Description" },
    tiers: { type: "string", value: "<tiers>", description: `Comma-separated tier names (default ${DEFAULT_APP_TIERS.join(",")})` },
    map: { type: "string", multiple: true, value: "<tier=alias>", description: "Map a tier to an alias (ID, public model ID or name)" },
    disabled: { type: "boolean", description: "Add the app disabled" },
  },
  examples: ["aigctl apps create chat-app --map max=claude-opus-max-thinking --map low=claude-haiku", "aigctl apps create editor --tiers fast,smart --map fast=claude-haiku,smart=claude-opus"],
  async run(context) {
    const name = appName(context, context.args[0]!, "The app name");
    const requested = listOption(context.options.tiers).map((tier) => tierName(context, tier));
    const tiers = requested.length ? requested : [...DEFAULT_APP_TIERS];
    if (new Set(tiers).size !== tiers.length) throw new UsageError("Each tier name may appear only once", context.commandName);
    const client = await context.client();
    const mappings = new Map<string, string>();
    const maps = listOption(context.options.map);
    const aliases = maps.length ? await listAliases(client) : [];
    for (const entry of maps) {
      const separator = entry.indexOf("=");
      const tier = separator < 0 ? "" : entry.slice(0, separator).trim();
      const aliasReference = separator < 0 ? "" : entry.slice(separator + 1).trim();
      if (!tier || !aliasReference) throw new UsageError(`--map takes tier=alias, such as max=claude-opus-max-thinking; got '${entry}'`, context.commandName);
      if (!tiers.includes(tier)) throw new UsageError(`--map: '${tier}' is not one of the app's tiers (${tiers.join(", ")})`, context.commandName);
      mappings.set(tier, (await resolveAlias(client, aliasReference, aliases)).id);
    }
    const { data } = await call<{ data: App }>(client, "POST", "/model-apps", { json: {
      name, description: stringOption(context.options.description)?.trim() || null, enabled: context.options.disabled !== true,
      tiers: tiers.map((tier) => ({ name: tier, aliasId: mappings.get(tier) ?? null })),
    } });
    const available = data.tiers.filter((tier) => tier.available).map((tier) => tier.modelId);
    report(context, `Added app ${data.name} with tiers ${data.tiers.map((tier) => tier.name).join(", ")}. ${available.length ? `API clients can use ${available.join(", ")}.` : "No tier is available yet: map tiers to aliases with 'aigctl apps set-tier'."}`, data);
  },
};

const appsUpdate: Command = {
  name: "update",
  summary: "Rename an app or change its description",
  usage: "<app>",
  details: "Renaming an app changes the model IDs of all its tiers (<app>-<tier>) for API clients.",
  options: {
    name: { type: "string", value: "<name>", description: "New name" },
    description: { type: "string", value: "<text>", description: "New description ('' clears it)" },
  },
  async run(context) {
    const changes: Record<string, unknown> = {};
    const name = stringOption(context.options.name);
    if (name !== undefined) changes.name = appName(context, name, "--name");
    setDefined(changes, "description", nullableText(context.options.description));
    if (!Object.keys(changes).length) throw new UsageError("Nothing to change: pass --name or --description", context.commandName);
    const client = await context.client();
    const app = await resolveApp(client, context.args[0]!);
    const { data } = await call<{ data: App }>(client, "PATCH", `/model-apps/${encodeURIComponent(app.id)}`, { json: changes });
    const renamed = data.name !== app.name ? ` Its tier model IDs changed from ${app.name}-<tier> to ${data.name}-<tier>.` : "";
    report(context, `Updated app ${data.name}.${renamed}`, data);
  },
};

const appsSetTier: Command = {
  name: "set-tier",
  summary: "Map an app tier to an alias, add a tier, or unmap one",
  usage: "<app> <tier> <alias>",
  details: `<alias> is an alias's ID, public model ID or name, or - to unmap the tier. A tier the app doesn't have is added.
Remapping a tier changes what its model ID serves without changing the ID API clients send.`,
  examples: ["aigctl apps set-tier chat-app max claude-opus-max-thinking", "aigctl apps set-tier chat-app low -"],
  async run(context) {
    const client = await context.client();
    const app = await resolveApp(client, context.args[0]!);
    const tier = tierName(context, context.args[1]!);
    const target = context.args[2]!.trim();
    const alias = target === "-" || target.toLowerCase() === "none" ? null : await resolveAlias(client, target);
    const tiers = app.tiers.map(({ name, aliasId }) => ({ name, aliasId }));
    const existing = tiers.find((entry) => entry.name === tier);
    if (existing) existing.aliasId = alias?.id ?? null;
    else tiers.push({ name: tier, aliasId: alias?.id ?? null });
    const { data } = await call<{ data: App }>(client, "PATCH", `/model-apps/${encodeURIComponent(app.id)}`, { json: { tiers } });
    const saved = data.tiers.find((entry) => entry.name === tier)!;
    const action = existing ? "" : "Added tier: ";
    const state = alias
      ? `${saved.modelId} now serves alias ${alias.modelId}${saved.available ? "" : ", but it is not available (the app, the alias or its model is disabled)"}`
      : `${saved.modelId} is unmapped; API clients can't use it until it is mapped again`;
    report(context, `${action}${state}.`, data);
  },
};

const appsRemoveTier: Command = {
  name: "remove-tier",
  summary: "Remove a tier from an app",
  usage: "<app> <tier>",
  options: { ...YES_OPTION },
  async run(context) {
    const client = await context.client();
    const app = await resolveApp(client, context.args[0]!);
    const tier = context.args[1]!.trim();
    const removed = app.tiers.find((entry) => entry.name === tier);
    if (!removed) throw new CliError(`${app.name} has no tier '${tier}' (tiers: ${app.tiers.map((entry) => entry.name).join(", ")})`);
    if (app.tiers.length === 1) throw new CliError(`${tier} is ${app.name}'s only tier; an app needs at least one (delete the app instead)`);
    await confirm(context, `Remove tier ${tier} from ${app.name}`, `API clients can no longer use ${removed.modelId}.`);
    const { data } = await call<{ data: App }>(client, "PATCH", `/model-apps/${encodeURIComponent(app.id)}`, {
      json: { tiers: app.tiers.filter((entry) => entry.name !== tier).map(({ name, aliasId }) => ({ name, aliasId })) },
    });
    report(context, `Removed tier ${tier} from ${app.name}; ${removed.modelId} is no longer a model ID.`, data);
  },
};

function appsToggle(enabled: boolean): Command {
  return {
    name: enabled ? "enable" : "disable",
    summary: enabled ? "Make an app's mapped tiers available again" : "Stop API clients from using an app's tiers",
    usage: "<app>",
    async run(context) {
      const client = await context.client();
      const app = await resolveApp(client, context.args[0]!);
      const { data } = await call<{ data: App }>(client, "PATCH", `/model-apps/${encodeURIComponent(app.id)}`, { json: { enabled } });
      const available = data.tiers.filter((tier) => tier.available).length;
      report(context, enabled ? `Enabled app ${data.name}: ${available} of ${data.tiers.length} tiers are available.` : `Disabled app ${data.name}: its tier model IDs are unavailable.`, data);
    },
  };
}

const appsDelete: Command = {
  name: "delete",
  summary: "Delete an app",
  usage: "<app>",
  details: "Its aliases and models are kept.",
  options: { ...YES_OPTION },
  async run(context) {
    const client = await context.client();
    const app = await resolveApp(client, context.args[0]!);
    await confirm(context, `Delete app ${app.name}`, `API clients can no longer use ${app.tiers.map((tier) => tier.modelId).join(", ")}.`);
    await call(client, "DELETE", `/model-apps/${encodeURIComponent(app.id)}`);
    report(context, `Deleted app ${app.name}.`, { success: true, id: app.id, name: app.name });
  },
};

export const appsGroup: CommandGroup = {
  name: "apps",
  summary: "Apps: tiered model IDs such as chat-app-max that map to aliases",
  details: "Commands that take <app> accept an app's ID or name.",
  commands: [appsList, appsGet, appsCreate, appsUpdate, appsSetTier, appsRemoveTier, appsToggle(true), appsToggle(false), appsDelete],
};
