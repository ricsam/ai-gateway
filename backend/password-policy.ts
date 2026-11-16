// The local password policy, without server imports so aigctl can check a
// password before sending it.

/** Why the gateway refuses a local password, or null when it accepts it. */
export function passwordPolicyError(password: string): string | null {
  if (password.length < 12 || password.length > 128) return "Password must be between 12 and 128 characters";
  if (!/[a-z]/i.test(password) || !/\d/.test(password)) return "Password must contain a letter and a number";
  return null;
}
