declare const process: { env: Record<string, string | undefined> };

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function httpUrl(name: string, value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an absolute http:// or https:// URL`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${name} must be an absolute http:// or https:// URL`);
  return url.toString().replace(/\/$/, "");
}

function encryptionKey(value: string): string {
  const trimmed = value.trim();
  const encoded = trimmed.startsWith("v1:") ? trimmed.slice(3) : trimmed;
  let decoded: Uint8Array;
  try { decoded = Uint8Array.from(Buffer.from(encoded, "base64")); } catch { throw new Error("SETTINGS_ENCRYPTION_KEY must be v1:<base64> or base64"); }
  if (decoded.byteLength !== 32) throw new Error("SETTINGS_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return `v1:${Buffer.from(decoded).toString("base64")}`;
}

const env = {
  BASE_URL: httpUrl("BASE_URL", required("BASE_URL")),
  DATABASE_URL: required("DATABASE_URL"),
  BETTER_AUTH_SECRET: required("BETTER_AUTH_SECRET"),
  SETTINGS_ENCRYPTION_KEY: encryptionKey(required("SETTINGS_ENCRYPTION_KEY")),
};

export default env;
