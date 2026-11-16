import { call, type ManagementClient } from "../client";
import { ApiError, UsageError } from "../errors";
import type { Command, CommandGroup } from "../framework";
import { confirm, readJsonDocument, requireObject, stringOption, YES_OPTION } from "../inputs";
import { formatTime, printJson, printList, renderDetails, type Column } from "../output";
import { resolveProvider, type AuthProvider } from "../resources";
import { report } from "./common";

const COLUMNS: Column<AuthProvider>[] = [
  { header: "ID", value: (provider) => provider.id, wide: true },
  { header: "KEY", value: (provider) => provider.providerKey },
  { header: "LABEL", value: (provider) => provider.label, maxWidth: 30 },
  { header: "TYPE", value: (provider) => provider.type },
  { header: "ENABLED", value: (provider) => provider.enabled },
  { header: "SECRET", value: (provider) => provider.secret.configured ? "configured" : "missing" },
  { header: "LAST-TEST", value: (provider) => provider.lastTestedAt ? `${provider.lastTestSucceeded ? "passed" : "failed"} ${formatTime(provider.lastTestedAt)}` : "never" },
  { header: "REVISION", value: (provider) => provider.revision, wide: true },
];

function providerDetails(provider: AuthProvider): string {
  return renderDetails([
    ["ID", provider.id], ["Key", provider.providerKey], ["Label", provider.label],
    ["Type", provider.type === "oidc" ? "OpenID Connect" : "trusted headers"], ["Enabled", provider.enabled],
    ["Secret", provider.secret.configured ? "configured" : "missing"],
    ["Last test", provider.lastTestedAt ? `${provider.lastTestSucceeded ? "passed" : "failed"} at ${formatTime(provider.lastTestedAt)}${provider.lastTestMessage ? `: ${provider.lastTestMessage}` : ""}` : "never"],
    ["Revision", provider.revision], ["Updated", formatTime(provider.updatedAt)],
    ["Config", JSON.stringify(provider.config, null, 2)],
  ]);
}

const FILE_OPTION = { file: { type: "string", short: "f", value: "<file>", description: "JSON document, or - for standard input (required)" } } as const;

async function readDocument(context: Parameters<Command["run"]>[0]): Promise<Record<string, unknown>> {
  const source = stringOption(context.options.file);
  if (!source) throw new UsageError("--file is required (use - for standard input)", context.commandName);
  return requireObject(await readJsonDocument(context, source), source === "-" ? "Standard input" : source);
}

async function patchProvider(client: ManagementClient, provider: AuthProvider, patch: Record<string, unknown>): Promise<AuthProvider> {
  const { data } = await call<{ data: AuthProvider }>(client, "PATCH", `/auth/providers/${encodeURIComponent(provider.id)}`, {
    json: { revision: provider.revision, ...patch },
  });
  return data;
}

function toggle(enabled: boolean): Command {
  return {
    name: enabled ? "enable" : "disable",
    summary: enabled ? "Enable a login provider after a successful test" : "Disable a login provider",
    usage: "<provider>",
    async run(context) {
      const client = await context.client();
      const provider = await resolveProvider(client, context.args[0]!);
      const updated = await patchProvider(client, provider, { enabled });
      report(context, `${enabled ? "Enabled" : "Disabled"} the login provider ${updated.providerKey}.`, updated);
    },
  };
}

export const authProvidersGroup: CommandGroup = {
  name: "auth-providers",
  summary: "OIDC and trusted-header login providers",
  details: `Commands take <provider> as a provider's ID or key. Create and update take the management API's JSON
(see docs/administration/authentication.mdx), with secrets written as {"operation": "replace", "value": "..."}.
Pipe documents that contain secrets through standard input (-f -) instead of copying files into the container.`,
  commands: [
    {
      name: "list",
      summary: "List login providers",
      async run(context) {
        const { data } = await call<{ data: AuthProvider[] }>(await context.client(), "GET", "/auth/providers");
        printList(context.io, context.output, data, COLUMNS, "No login providers are configured; local sign-in is always available.");
      },
    },
    {
      name: "get",
      summary: "Show a login provider's configuration (secret redacted)",
      usage: "<provider>",
      async run(context) {
        const provider = await resolveProvider(await context.client(), context.args[0]!);
        if (context.output === "json") printJson(context.io, provider);
        else context.io.out(providerDetails(provider));
      },
    },
    {
      name: "create",
      summary: "Create a login provider (disabled) from a JSON document",
      options: { ...FILE_OPTION },
      examples: [
        `kubectl exec -i deploy/ai-gateway-ai-gateway -- aigctl auth-providers create -f - <<'EOF'
  {"type": "oidc", "providerKey": "entra", "label": "Microsoft Entra ID",
   "config": {"issuer": "https://login.microsoftonline.com/<tenant>/v2.0", "clientId": "<client-id>"},
   "secret": {"operation": "replace", "value": "<client-secret>"}}
  EOF`,
      ],
      async run(context) {
        const document = await readDocument(context);
        const { data } = await call<{ data: AuthProvider }>(await context.client(), "POST", "/auth/providers", { json: { enabled: false, ...document } });
        report(context, `Created the login provider ${data.providerKey} (disabled). Test it with 'aigctl auth-providers test ${data.providerKey}', then enable it.`, data);
      },
    },
    {
      name: "update",
      summary: "Change a login provider with a JSON document of the fields to change",
      usage: "<provider>",
      details: "The document's revision defaults to the provider's current revision. Configuration or secret changes need a new test before enabling.",
      options: { ...FILE_OPTION },
      async run(context) {
        const document = await readDocument(context);
        const client = await context.client();
        const provider = await resolveProvider(client, context.args[0]!);
        const updated = await patchProvider(client, provider, document);
        report(context, `Updated the login provider ${updated.providerKey} (revision ${updated.revision}).`, updated);
      },
    },
    {
      name: "test",
      summary: "Test a login provider's configuration (OIDC discovery)",
      usage: "<provider>",
      async run(context) {
        const client = await context.client();
        const provider = await resolveProvider(client, context.args[0]!);
        try {
          const result = await call<{ success: boolean; message: string }>(client, "POST", `/auth/providers/${encodeURIComponent(provider.id)}/test`);
          report(context, `Test passed: ${result.message}`, { ...result, providerKey: provider.providerKey });
          return 0;
        } catch (error) {
          // A failed test answers 400 with { success: false, message }.
          const body = error instanceof ApiError ? error.body as { success?: boolean; message?: string } | undefined : undefined;
          if (!body || body.success !== false) throw error;
          if (context.output === "json") printJson(context.io, { ...body, providerKey: provider.providerKey });
          else context.io.err(`Test failed: ${body.message}\n`);
          return 1;
        }
      },
    },
    toggle(true),
    toggle(false),
    {
      name: "delete",
      summary: "Delete a login provider",
      usage: "<provider>",
      options: { ...YES_OPTION },
      async run(context) {
        const client = await context.client();
        const provider = await resolveProvider(client, context.args[0]!);
        await confirm(context, `Delete the login provider ${provider.providerKey} (${provider.label})`, "Its users can no longer sign in with it; local sign-in keeps working.");
        await call(client, "DELETE", `/auth/providers/${encodeURIComponent(provider.id)}`);
        report(context, `Deleted the login provider ${provider.providerKey}.`, { success: true, id: provider.id });
      },
    },
  ],
};
