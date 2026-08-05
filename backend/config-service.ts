import { asc, eq } from "drizzle-orm";
import db from "./db";
import env from "./env";
import { applicationSettingsTable, authProvidersTable, brandingAssetsTable } from "./schema";
import { getSetupStatus } from "./setup";

export async function getBranding() {
  const [settings] = await db.select().from(applicationSettingsTable).where(eq(applicationSettingsTable.id, "main")).limit(1);
  return settings ?? {
    id: "main", revision: 1, productName: "AI Gateway", tagline: "Secure, metered access to AI models",
    logoUrl: null, faviconUrl: null, primaryColor: "#2563eb", primaryForegroundColor: "#ffffff", updatedAt: new Date(0),
  };
}

export async function getPublicConfig() {
  const [brand, setup, providers, assets] = await Promise.all([
    getBranding(),
    getSetupStatus(),
    db.select({ providerKey: authProvidersTable.providerKey, label: authProvidersTable.label, type: authProvidersTable.type })
      .from(authProvidersTable).where(eq(authProvidersTable.enabled, true)).orderBy(asc(authProvidersTable.label)),
    db.select({ kind: brandingAssetsTable.kind, digest: brandingAssetsTable.digest }).from(brandingAssetsTable),
  ]);
  const assetByKind = new Map(assets.map((asset) => [asset.kind, asset.digest]));
  return {
    setup,
    brand: {
      name: brand.productName, tagline: brand.tagline,
      logoUrl: assetByKind.has("logo") ? `/api/branding/assets/logo/${assetByKind.get("logo")}` : brand.logoUrl,
      faviconUrl: assetByKind.has("favicon") ? `/api/branding/assets/favicon/${assetByKind.get("favicon")}` : brand.faviconUrl,
      primaryColor: brand.primaryColor, primaryForegroundColor: brand.primaryForegroundColor,
    },
    auth: { local: true, providers: providers.filter((provider) => provider.type === "oidc") },
    api: { baseUrl: `${env.BASE_URL}/v1`, managementBaseUrl: `${env.BASE_URL}/management/v1` },
  };
}

export async function handleBrandingAsset(pathname: string): Promise<Response> {
  const match = pathname.match(/^\/api\/branding\/assets\/(logo|favicon)\/([a-f0-9]{64})$/);
  if (!match) return new Response("Not found", { status: 404 });
  const [asset] = await db.select().from(brandingAssetsTable).where(eq(brandingAssetsTable.kind, match[1]!)).limit(1);
  if (!asset || asset.digest !== match[2]) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(asset.bytes), { headers: {
    "content-type": asset.mimeType,
    "content-length": String(asset.byteLength),
    "cache-control": "public, max-age=31536000, immutable",
    "content-security-policy": "default-src 'none'; sandbox",
    "x-content-type-options": "nosniff",
  } });
}
