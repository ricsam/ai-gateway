export interface BootstrapAdminPolicy {
  subjects: ReadonlySet<string>;
  emails: ReadonlySet<string>;
}

export interface BootstrapIdentity {
  subject: string | null;
  email: string;
  emailVerified: boolean;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function shouldBootstrapAdmin(
  identity: BootstrapIdentity,
  policy: BootstrapAdminPolicy,
): boolean {
  if (identity.subject && policy.subjects.has(identity.subject)) return true;
  return identity.emailVerified && policy.emails.has(normalizeEmail(identity.email));
}

export function removesEnabledAdministrator(
  current: { role: string; enabled: boolean },
  updates: { role?: string; enabled?: boolean },
): boolean {
  return current.role === "admin" && current.enabled &&
    (updates.role === "user" || updates.enabled === false);
}

export function assertAdministratorUpdateIsSafe(
  current: { role: string; enabled: boolean },
  updates: { role?: string; enabled?: boolean },
  otherEnabledAdministratorCount: number,
): void {
  if (removesEnabledAdministrator(current, updates) && otherEnabledAdministratorCount === 0) {
    throw new Error("Cannot remove or disable the final enabled administrator");
  }
}
