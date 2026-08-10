export function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
  return match?.[1] ?? null;
}

export async function hashApiKey(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const USER_API_KEY_SCOPES = ["ai.invoke", "models.read", "credits.read"] as const;
export type UserApiKeyScope = typeof USER_API_KEY_SCOPES[number];

export function userApiKeyScopes(value: unknown): UserApiKeyScope[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Select at least one valid API key scope");
  const scopes = [...new Set(value)];
  if (scopes.some((scope) => typeof scope !== "string" || !USER_API_KEY_SCOPES.includes(scope as UserApiKeyScope))) {
    throw new Error("Select only valid API key scopes");
  }
  return scopes as UserApiKeyScope[];
}

export function generateUserApiKey(): string {
  return `aig_${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
}
