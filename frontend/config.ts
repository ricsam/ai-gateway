import env from "@/env";

export interface PublicConfig {
  setup: { required: boolean; completedAt: string | null };
  brand: { name: string; tagline: string; logoUrl: string | null; faviconUrl: string | null; primaryColor: string; primaryForegroundColor: string };
  auth: { local: boolean; providers: { providerKey: string; label: string; type: "oidc" }[] };
  api: { baseUrl: string; managementBaseUrl: string };
}

let cached: PublicConfig | null = null;
let pending: Promise<PublicConfig> | null = null;

export function loadPublicConfig(force = false): Promise<PublicConfig> {
  if (force) { cached = null; pending = null; }
  if (cached) return Promise.resolve(cached);
  pending ??= fetch(`${env.BASE_URL}/api/config`, { cache: "no-store" }).then(async (response) => {
    if (!response.ok) throw new Error("Could not load runtime configuration");
    cached = await response.json() as PublicConfig;
    return cached;
  }).finally(() => { pending = null; });
  return pending;
}
