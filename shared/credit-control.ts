/**
 * How the monthly run applies an account's monthly credits (`defaultMonthlyCredits`):
 * - `reset` replaces the balance with the monthly credits, so unspent credits expire.
 * - `rollover` adds the monthly credits to the balance, so unspent credits carry over,
 *   up to the account's rollover cap when it has one.
 */
export const MONTHLY_CREDIT_MODES = ["reset", "rollover"] as const;

export type MonthlyCreditMode = (typeof MONTHLY_CREDIT_MODES)[number];

export function isMonthlyCreditMode(value: unknown): value is MonthlyCreditMode {
  return typeof value === "string" && (MONTHLY_CREDIT_MODES as readonly string[]).includes(value);
}

/** The largest amount the numeric(20,8) credit columns hold. */
export const MAX_CREDIT_AMOUNT = 999_999_999_999;
