import env from "@/env";

export interface PublicConfig {
  brand: {
    name: string;
    tagline: string;
    logoUrl: string | null;
    faviconUrl: string | null;
    primaryColor: string;
    primaryForegroundColor: string;
  };
  auth: { mode: "oidc"; providerId: string; providerLabel: string };
  api: { baseUrl: string };
}

let cached: PublicConfig | null = null;
let pending: Promise<PublicConfig> | null = null;

export function loadPublicConfig(): Promise<PublicConfig> {
  if (cached) return Promise.resolve(cached);
  pending ??= fetch(`${env.BASE_URL}/api/config`).then(async (response) => {
    if (!response.ok) throw new Error("Could not load runtime configuration");
    cached = await response.json() as PublicConfig;
    return cached;
  });
  return pending;
}
