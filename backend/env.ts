declare const process: { env: Record<string, string | undefined> };

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function csv(name: string, fallback: string[] = []): string[] {
  const value = process.env[name]?.trim();
  return value ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be true or false`);
}

function color(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${name} must be a six-digit hex color`);
  return value;
}

function httpUrl(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute http:// or https:// URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must be an absolute http:// or https:// URL`);
  }
  return url.toString().replace(/\/$/, "");
}

function optionalHttpUrl(name: string): string {
  const value = process.env[name]?.trim();
  return value ? httpUrl(name, value) : "";
}

const baseUrl = httpUrl("BASE_URL", required("BASE_URL"));
const oidcIssuer = httpUrl("OIDC_ISSUER", required("OIDC_ISSUER"));
const oidcProviderId = process.env.OIDC_PROVIDER_ID?.trim() || "oidc";
if (!/^[a-z0-9][a-z0-9_-]*$/i.test(oidcProviderId)) {
  throw new Error("OIDC_PROVIDER_ID must contain only letters, digits, underscores, and hyphens");
}

const env = {
  BASE_URL: baseUrl,
  AWS_ACCESS_KEY_ID: required("AWS_ACCESS_KEY_ID"),
  AWS_REGION: required("AWS_REGION"),
  AWS_SECRET_ACCESS_KEY: required("AWS_SECRET_ACCESS_KEY"),
  AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN?.trim() || undefined,
  BETTER_AUTH_SECRET: required("BETTER_AUTH_SECRET"),
  OIDC_ISSUER: oidcIssuer,
  OIDC_DISCOVERY_URL: process.env.OIDC_DISCOVERY_URL?.trim()
    ? httpUrl("OIDC_DISCOVERY_URL", process.env.OIDC_DISCOVERY_URL)
    : `${oidcIssuer}/.well-known/openid-configuration`,
  OIDC_CLIENT_ID: required("OIDC_CLIENT_ID"),
  OIDC_CLIENT_SECRET: required("OIDC_CLIENT_SECRET"),
  OIDC_PROVIDER_ID: oidcProviderId,
  OIDC_PROVIDER_LABEL: process.env.OIDC_PROVIDER_LABEL?.trim() || "Single Sign-On",
  OIDC_SCOPES: csv("OIDC_SCOPES", ["openid", "profile", "email"]),
  OIDC_PKCE: bool("OIDC_PKCE", true),
  OIDC_STRICT_ISSUER_VALIDATION: bool("OIDC_STRICT_ISSUER_VALIDATION", false),
  BOOTSTRAP_ADMIN_SUBJECTS: new Set(csv("BOOTSTRAP_ADMIN_SUBJECTS")),
  BOOTSTRAP_ADMIN_EMAILS: new Set(csv("BOOTSTRAP_ADMIN_EMAILS").map((email) => email.toLowerCase())),
  BRAND_NAME: process.env.BRAND_NAME?.trim() || "LLM Proxy",
  BRAND_TAGLINE: process.env.BRAND_TAGLINE?.trim() || "Secure, metered access to AI models",
  BRAND_LOGO_URL: optionalHttpUrl("BRAND_LOGO_URL"),
  BRAND_FAVICON_URL: optionalHttpUrl("BRAND_FAVICON_URL"),
  BRAND_PRIMARY_COLOR: color("BRAND_PRIMARY_COLOR", "#2563eb"),
  BRAND_PRIMARY_FOREGROUND_COLOR: color("BRAND_PRIMARY_FOREGROUND_COLOR", "#ffffff"),
};

export default env;
