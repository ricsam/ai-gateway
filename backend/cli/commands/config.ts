import { inspectImage } from "../../branding-assets";
import { call, type ManagementClient } from "../client";
import { CliError, UsageError } from "../errors";
import type { Command, CommandGroup } from "../framework";
import { confirm, optionalBoolean, readPipedSecret, stringOption, YES_OPTION } from "../inputs";
import { formatCredits, formatInteger, formatTime, printJson, printList, renderDetails, type Column } from "../output";
import { report, requiredOption } from "./common";

interface Model {
  id: string; modelId: string; name: string; description: string | null; provider: string;
  inputPricePerMTok: number; outputPricePerMTok: number; cacheReadPricePerMTok: number | null;
  cacheWrite5mPricePerMTok: number | null; cacheWrite1hPricePerMTok: number | null;
  contextWindow: number | null; maxOutputTokens: number; thinking: boolean; reasoningMode: string;
  defaultReasoningEffort: string | null; managedCache: boolean; region: string | null; enabled: boolean;
}

const MODEL_COLUMNS: Column<Model>[] = [
  { header: "ID", value: (model) => model.id, wide: true },
  { header: "NAME", value: (model) => model.name, maxWidth: 32 },
  { header: "MODEL-ID", value: (model) => model.modelId },
  { header: "ENABLED", value: (model) => model.enabled },
  { header: "INPUT/MTOK", value: (model) => formatCredits(model.inputPricePerMTok), align: "right" },
  { header: "OUTPUT/MTOK", value: (model) => formatCredits(model.outputPricePerMTok), align: "right" },
  { header: "CACHE-READ/MTOK", value: (model) => formatCredits(model.cacheReadPricePerMTok), align: "right", wide: true },
  { header: "REGION", value: (model) => model.region ?? "default" },
  { header: "THINKING", value: (model) => model.thinking },
  { header: "REASONING", value: (model) => model.reasoningMode, wide: true },
  { header: "DEFAULT-EFFORT", value: (model) => model.defaultReasoningEffort, wide: true },
  { header: "MANAGED-CACHE", value: (model) => model.managedCache },
  { header: "CONTEXT", value: (model) => formatInteger(model.contextWindow), align: "right", wide: true },
  { header: "MAX-OUTPUT", value: (model) => formatInteger(model.maxOutputTokens), align: "right", wide: true },
];

async function listModels(client: ManagementClient): Promise<Model[]> {
  return (await call<{ data: Model[] }>(client, "GET", "/models")).data;
}

export const modelsGroup: CommandGroup = {
  name: "models",
  summary: "Configured Bedrock models and their prices",
  details: "Models, aliases and apps are edited in Admin → Models; the management API lists models.",
  commands: [{
    name: "list",
    summary: "List configured models",
    async run(context) {
      printList(context.io, context.output, await listModels(await context.client()), MODEL_COLUMNS, "No models are configured.");
    },
  }],
};

interface Settings { revision: number; remoteImageUrlsEnabled: boolean; reasoningReplayEnabled: boolean }

async function getSettings(client: ManagementClient): Promise<Settings> {
  return (await call<{ data: Settings }>(client, "GET", "/settings")).data;
}

function settingsDetails(settings: Settings): string {
  return renderDetails([
    ["Remote image URLs", settings.remoteImageUrlsEnabled ? "on (http(s) image URLs are downloaded)" : "off (only base64 data URLs are accepted)"],
    ["Reasoning replay", settings.reasoningReplayEnabled ? "on (Claude's earlier reasoning is sent back)" : "off"],
    ["Revision", settings.revision],
  ]);
}

export const settingsGroup: CommandGroup = {
  name: "settings",
  summary: "Runtime inference settings",
  commands: [
    {
      name: "get",
      summary: "Show the inference settings",
      async run(context) {
        const settings = await getSettings(await context.client());
        if (context.output === "json") printJson(context.io, settings);
        else context.io.out(settingsDetails(settings));
      },
    },
    {
      name: "set",
      summary: "Change inference settings",
      details: "Turning reasoning replay off also deletes the reasoning stored for it.",
      options: {
        "remote-image-urls": { type: "string", value: "<bool>", description: "Download http(s) image URLs in chat completions (SSRF-restricted)" },
        "reasoning-replay": { type: "string", value: "<bool>", description: "Store Claude's reasoning and send it back in later turns" },
      },
      examples: ["aigctl settings set --remote-image-urls off", "aigctl settings set --reasoning-replay on"],
      async run(context) {
        const remoteImageUrlsEnabled = optionalBoolean("remote-image-urls", context.options["remote-image-urls"]);
        const reasoningReplayEnabled = optionalBoolean("reasoning-replay", context.options["reasoning-replay"]);
        if (remoteImageUrlsEnabled === undefined && reasoningReplayEnabled === undefined) {
          throw new UsageError("Nothing to change: pass --remote-image-urls or --reasoning-replay", context.commandName);
        }
        const client = await context.client();
        const current = await getSettings(client);
        const { data } = await call<{ data: Settings }>(client, "PUT", "/settings", {
          json: { revision: current.revision, remoteImageUrlsEnabled, reasoningReplayEnabled },
        });
        const purged = reasoningReplayEnabled === false && current.reasoningReplayEnabled ? " Stored reasoning was deleted." : "";
        if (context.output === "json") printJson(context.io, data);
        else context.io.out(`${settingsDetails(data)}${purged ? `${purged.trim()}\n` : ""}`);
      },
    },
  ],
};

interface Branding {
  revision: number; productName: string; tagline: string; logoUrl: string | null; faviconUrl: string | null;
  primaryColor: string; primaryForegroundColor: string; updatedAt: string;
}

async function getBranding(client: ManagementClient): Promise<Branding> {
  const { data } = await call<{ data: Branding }>(client, "GET", "/branding");
  const { revision, productName, tagline, logoUrl, faviconUrl, primaryColor, primaryForegroundColor, updatedAt } = data;
  return { revision, productName, tagline, logoUrl, faviconUrl, primaryColor, primaryForegroundColor, updatedAt };
}

const BRANDING_FIELDS = {
  "product-name": "productName", tagline: "tagline", "primary-color": "primaryColor",
  "primary-foreground-color": "primaryForegroundColor", "logo-url": "logoUrl", "favicon-url": "faviconUrl",
} as const;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const ASSET_KINDS = ["logo", "favicon"] as const;

function assetKind(value: string): "logo" | "favicon" {
  if (!(ASSET_KINDS as readonly string[]).includes(value)) throw new UsageError(`The asset must be logo or favicon, not '${value}'`);
  return value as "logo" | "favicon";
}

export const brandingGroup: CommandGroup = {
  name: "branding",
  summary: "Product name, tagline, colors, logo and favicon",
  commands: [
    {
      name: "get",
      summary: "Show the branding",
      async run(context) {
        const branding = await getBranding(await context.client());
        if (context.output === "json") return printJson(context.io, branding);
        context.io.out(renderDetails([
          ["Product name", branding.productName], ["Tagline", branding.tagline],
          ["Primary color", branding.primaryColor], ["Primary foreground color", branding.primaryForegroundColor],
          ["Logo URL", branding.logoUrl], ["Favicon URL", branding.faviconUrl],
          ["Revision", branding.revision], ["Updated", formatTime(branding.updatedAt)],
        ]));
      },
    },
    {
      name: "set",
      summary: "Change the product name, tagline, colors or external logo and favicon URLs",
      details: "An uploaded logo or favicon ('aigctl branding upload') takes precedence over its external URL. Pass '' to clear a URL.",
      options: {
        "product-name": { type: "string", value: "<name>", description: "Product name" },
        tagline: { type: "string", value: "<text>", description: "Tagline on the sign-in page" },
        "primary-color": { type: "string", value: "<#rrggbb>", description: "Primary color" },
        "primary-foreground-color": { type: "string", value: "<#rrggbb>", description: "Text color on the primary color" },
        "logo-url": { type: "string", value: "<url>", description: "External logo URL" },
        "favicon-url": { type: "string", value: "<url>", description: "External favicon URL" },
      },
      examples: ["aigctl branding set --product-name 'Acme AI' --primary-color '#0f766e'"],
      async run(context) {
        const changes: Record<string, string | null> = {};
        for (const [flag, field] of Object.entries(BRANDING_FIELDS)) {
          const value = stringOption(context.options[flag]);
          if (value === undefined) continue;
          if ((field === "primaryColor" || field === "primaryForegroundColor") && !HEX_COLOR.test(value)) throw new UsageError(`--${flag} must be a six-digit hex color such as #2563eb`, context.commandName);
          if ((field === "productName" || field === "tagline") && !value.trim()) throw new UsageError(`--${flag} cannot be empty`, context.commandName);
          changes[field] = field === "logoUrl" || field === "faviconUrl" ? value.trim() || null : value.trim();
        }
        if (!Object.keys(changes).length) throw new UsageError("Nothing to change: pass at least one option", context.commandName);
        const client = await context.client();
        const current = await getBranding(client);
        await call(client, "PUT", "/branding", { json: { revision: current.revision, ...changes } });
        const branding = await getBranding(client);
        report(context, `Updated the branding (${Object.keys(changes).join(", ")}).`, branding);
      },
    },
    {
      name: "upload",
      summary: "Upload a logo (PNG, JPEG or WebP) or favicon (PNG or ICO)",
      usage: "<logo|favicon> <file>",
      details: `<file> is a path in the container, or - to read the image from standard input:
  kubectl exec -i deploy/ai-gateway-ai-gateway -- aigctl branding upload logo - < logo.png
Images are at most 512 KiB; logos at most 2048 and favicons at most 512 pixels on a side.`,
      async run(context) {
        const kind = assetKind(context.args[0]!);
        const source = context.args[1]!;
        let bytes: Uint8Array;
        try { bytes = source === "-" ? await context.io.readStdin() : await context.io.readFile(source); }
        catch (error) { throw new CliError(`Could not read ${source}: ${error instanceof Error ? error.message : String(error)}`); }
        const image = inspectImage(bytes);
        if (!image) throw new CliError(`${source === "-" ? "Standard input" : source} is not a PNG, JPEG, WebP or ICO image`);
        const { data } = await call<{ data: { kind: string; digest: string; url: string } }>(await context.client(), "POST", `/branding/assets/${kind}`, {
          bytes, contentType: image.mimeType,
        });
        report(context, `Uploaded the ${kind} (${image.mimeType}, ${image.width}×${image.height}, ${(bytes.byteLength / 1024).toFixed(1)} KiB): ${data.url}`, { ...data, mimeType: image.mimeType, byteLength: bytes.byteLength });
      },
    },
    {
      name: "remove",
      summary: "Remove an uploaded logo or favicon",
      usage: "<logo|favicon>",
      details: "The external URL, if one is set, applies again.",
      options: { ...YES_OPTION },
      async run(context) {
        const kind = assetKind(context.args[0]!);
        await confirm(context, `Remove the uploaded ${kind}`);
        await call(await context.client(), "DELETE", `/branding/assets/${kind}`);
        report(context, `Removed the uploaded ${kind}.`, { success: true, kind });
      },
    },
  ],
};

interface AwsConfiguration {
  revision: number; defaultRegion: string | null; accessKeyId: string | null;
  secretAccessKey: { configured: boolean }; sessionToken: { configured: boolean };
  lastTestedAt?: string | null; lastTestSucceeded?: boolean | null; lastTestMessage?: string | null;
}

async function getAws(client: ManagementClient): Promise<AwsConfiguration> {
  return (await call<{ data: AwsConfiguration }>(client, "GET", "/aws")).data;
}

function awsDetails(aws: AwsConfiguration): string {
  const test = aws.lastTestedAt
    ? `${aws.lastTestSucceeded ? "succeeded" : "failed"} at ${formatTime(aws.lastTestedAt)}${aws.lastTestMessage ? `: ${aws.lastTestMessage}` : ""}`
    : "never";
  return renderDetails([
    ["Default region", aws.defaultRegion],
    ["Access key ID", aws.accessKeyId],
    ["Secret access key", aws.secretAccessKey.configured ? "configured" : "not set"],
    ["Session token", aws.sessionToken.configured ? "configured" : "not set"],
    ["Last test", test],
    ["Revision", aws.revision],
  ]);
}

const REGION = /^[a-z]{2}(-[a-z0-9]+)+$/;

function region(value: string, flag?: string): string {
  const text = value.trim();
  if (!REGION.test(text)) throw new UsageError(`${flag ? `--${flag}` : "The region"} must be an AWS region such as us-east-1 or eu-west-1`);
  return text;
}

export const awsGroup: CommandGroup = {
  name: "aws",
  summary: "AWS credentials and default region for Bedrock",
  details: "Secrets are encrypted with SETTINGS_ENCRYPTION_KEY and never shown again.",
  commands: [
    {
      name: "get",
      summary: "Show the AWS configuration (secrets redacted)",
      async run(context) {
        const aws = await getAws(await context.client());
        if (context.output === "json") printJson(context.io, aws);
        else context.io.out(awsDetails(aws));
      },
    },
    {
      name: "set-region",
      summary: "Set the default Bedrock region",
      usage: "<region>",
      async run(context) {
        const defaultRegion = region(context.args[0]!);
        const client = await context.client();
        const current = await getAws(client);
        await call(client, "PUT", "/aws", { json: { revision: current.revision, defaultRegion } });
        const aws = await getAws(client);
        report(context, `Set the default region to ${aws.defaultRegion}.`, aws);
      },
    },
    {
      name: "set-credentials",
      summary: "Store a static AWS access key for Bedrock",
      details: `aigctl asks for the secret access key (use kubectl exec -it), or reads it from the first line of standard input with --stdin;
with --with-session-token, the session token follows (second line). Secrets are never accepted as arguments.
Replaces any previous key and session token. Test it with 'aigctl aws test'.`,
      options: {
        "access-key-id": { type: "string", value: "<id>", description: "Access key ID (required)" },
        region: { type: "string", value: "<region>", description: "Also set the default region" },
        "with-session-token": { type: "boolean", description: "Also store a session token (temporary credentials)" },
        stdin: { type: "boolean", description: "Read the secret access key (and session token) from standard input" },
      },
      examples: [
        "kubectl exec -it deploy/ai-gateway-ai-gateway -- aigctl aws set-credentials --access-key-id AKIA... --region us-east-1",
        "printf '%s\\n' \"$AWS_SECRET_ACCESS_KEY\" | kubectl exec -i deploy/ai-gateway-ai-gateway -- aigctl aws set-credentials --access-key-id AKIA... --stdin",
      ],
      async run(context) {
        const accessKeyId = requiredOption(context, "access-key-id");
        const regionOption = stringOption(context.options.region);
        const defaultRegion = regionOption === undefined ? undefined : region(regionOption, "region");
        const withSessionToken = context.options["with-session-token"] === true;
        let secretAccessKey: string;
        let sessionToken: string | undefined;
        if (context.options.stdin === true) {
          const lines = (await readPipedSecret(context, "stdin")).split(/\r?\n/);
          secretAccessKey = lines[0]?.trim() ?? "";
          sessionToken = withSessionToken ? lines[1]?.trim() : undefined;
          if (withSessionToken && !sessionToken) throw new CliError("Standard input has no session token on its second line");
        } else {
          if (!context.io.interactive) throw new UsageError("Standard input is not a terminal, so aigctl cannot ask for the secret: pass --stdin and pipe it in", context.commandName);
          secretAccessKey = (await context.io.prompt("Secret access key: ", { hidden: true })).trim();
          if (withSessionToken) sessionToken = (await context.io.prompt("Session token: ", { hidden: true })).trim();
        }
        if (!secretAccessKey) throw new CliError("No secret access key given");
        if (withSessionToken && !sessionToken) throw new CliError("No session token given");
        const client = await context.client();
        const current = await getAws(client);
        await call(client, "PUT", "/aws", { json: {
          revision: current.revision, defaultRegion: defaultRegion ?? current.defaultRegion, accessKeyId,
          secretAccessKey: { operation: "replace", value: secretAccessKey },
          sessionToken: sessionToken ? { operation: "replace", value: sessionToken } : { operation: "clear" },
        } });
        const aws = await getAws(client);
        report(context, `Stored the AWS access key ${aws.accessKeyId}${aws.defaultRegion ? ` (default region ${aws.defaultRegion})` : "; set a default region with 'aigctl aws set-region'"}. Test it with 'aigctl aws test'.`, aws);
      },
    },
    {
      name: "clear-credentials",
      summary: "Remove the stored AWS credentials",
      options: { ...YES_OPTION },
      async run(context) {
        await confirm(context, "Clear the AWS credentials", "Enabled models stop working until credentials are configured again.");
        const client = await context.client();
        const current = await getAws(client);
        await call(client, "PUT", "/aws", { json: {
          revision: current.revision, defaultRegion: current.defaultRegion, accessKeyId: null,
          secretAccessKey: { operation: "clear" }, sessionToken: { operation: "clear" },
        } });
        report(context, "Cleared the AWS credentials.", await getAws(client));
      },
    },
    {
      name: "test",
      summary: "Send a short Converse request to Bedrock with the stored credentials",
      usage: "[bedrock-model-id]",
      details: "Without a model ID, tests the first enabled configured model. The request costs a few tokens.",
      options: { region: { type: "string", value: "<region>", description: "Test this region instead of the model's or the default" } },
      examples: ["aigctl aws test", "aigctl aws test anthropic.claude-sonnet-4-5-20250929-v1:0 --region us-east-1"],
      async run(context) {
        const client = await context.client();
        let modelId = context.args[0];
        let modelRegion = stringOption(context.options.region);
        if (!modelId) {
          const model = (await listModels(client)).find((candidate) => candidate.enabled);
          if (!model) throw new UsageError("No enabled model is configured: pass a Bedrock model ID", context.commandName);
          modelId = model.modelId;
          modelRegion ??= model.region ?? undefined;
        }
        const result = await call<{ success: boolean; message: string }>(client, "POST", "/aws/test", { json: { modelId, region: modelRegion } });
        report(context, `${result.message} (${modelId}${modelRegion ? ` in ${modelRegion}` : ""}).`, { ...result, modelId, region: modelRegion ?? null });
      },
    },
  ],
};
