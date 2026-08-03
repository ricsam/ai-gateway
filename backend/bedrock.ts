import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import env from "@/env";

// Default BedrockRuntimeClient using global AWS_REGION
const defaultClient = new BedrockRuntimeClient({
  region: env.AWS_REGION,
  credentials: {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.AWS_SESSION_TOKEN,
  },
});

// Get a region-specific BedrockRuntimeClient for proxy endpoints
export function getBedrockClient(region?: string | null) {
  if (!region || region === env.AWS_REGION) return defaultClient;
  return new BedrockRuntimeClient({
    region,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      sessionToken: env.AWS_SESSION_TOKEN,
    },
  });
}
