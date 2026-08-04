import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { eq } from "drizzle-orm";
import db from "./db";
import { awsConfigurationTable } from "./schema";
import { decryptSetting } from "./settings-crypto";

export class ProviderNotConfiguredError extends Error {
  override name = "ProviderNotConfiguredError";
  code = "provider_not_configured";
  constructor() { super("AWS Bedrock credentials and default region are not configured"); }
}

const clients = new Map<string, BedrockRuntimeClient>();

export function invalidateBedrockClients(): void {
  for (const client of clients.values()) client.destroy();
  clients.clear();
}

export async function getBedrockClient(regionOverride?: string | null): Promise<BedrockRuntimeClient> {
  const [configuration] = await db.select().from(awsConfigurationTable).where(eq(awsConfigurationTable.id, "main")).limit(1);
  if (!configuration?.defaultRegion || !configuration.accessKeyId || !configuration.secretAccessKeyEnvelope) throw new ProviderNotConfiguredError();
  const region = regionOverride || configuration.defaultRegion;
  const cacheKey = `${configuration.revision}:${region}`;
  const cached = clients.get(cacheKey);
  if (cached) return cached;
  const secretAccessKey = await decryptSetting(configuration.secretAccessKeyEnvelope, "aws:secret-access-key");
  const sessionToken = configuration.sessionTokenEnvelope
    ? await decryptSetting(configuration.sessionTokenEnvelope, "aws:session-token")
    : undefined;
  const client = new BedrockRuntimeClient({ region, credentials: { accessKeyId: configuration.accessKeyId, secretAccessKey, sessionToken } });
  clients.set(cacheKey, client);
  return client;
}
