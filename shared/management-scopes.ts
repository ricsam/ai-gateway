// Management API scopes. Kept free of server imports so aigctl can list and
// expand them without a database connection.

/** Scopes a management key can hold. Administrator sessions and aigctl inside the gateway container hold all of them. */
export const MANAGEMENT_SCOPES = [
  "users.read", "users.write", "groups.read", "groups.write", "auth.read", "auth.write",
  "branding.read", "branding.write", "aws.read", "aws.write", "models.read", "models.write",
  "settings.read", "settings.write", "usage.read", "management-keys.read", "management-keys.write", "audit.read",
  "api-keys.read", "api-keys.write",
] as const;
export type ManagementScope = typeof MANAGEMENT_SCOPES[number];

export function isManagementScope(value: string): value is ManagementScope {
  return (MANAGEMENT_SCOPES as readonly string[]).includes(value);
}
