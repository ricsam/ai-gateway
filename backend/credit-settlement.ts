export interface CreditSettlement {
  actualCost: number;
  creditsCharged: number;
  balanceAfter: number;
  partiallyCharged: boolean;
}

export function hasAvailableCredits(balance: number): boolean {
  return Number.isFinite(balance) && balance > 0;
}

/**
 * Charges what a request cost, but never more than the balance nor, for an account
 * with a monthly spend limit, more than what the limit has left this month
 * (`spendAllowance`). The rest is recorded as a partial charge.
 */
export function calculateCreditSettlement(currentBalance: number, actualCost: number, spendAllowance = Number.POSITIVE_INFINITY): CreditSettlement {
  if (!Number.isFinite(currentBalance)) {
    throw new Error("Credit balance must be a finite number");
  }
  if (!Number.isFinite(actualCost) || actualCost < 0) {
    throw new Error("Credit cost must be a finite non-negative number");
  }
  if (Number.isNaN(spendAllowance)) {
    throw new Error("Monthly spend allowance must be a number");
  }

  const balance = Math.max(currentBalance, 0);
  const availableCredits = Math.min(balance, Math.max(spendAllowance, 0));
  const creditsCharged = Math.min(actualCost, availableCredits);
  const balanceAfter = creditsCharged === actualCost ? Math.max(balance - actualCost, 0) : balance - creditsCharged;

  return {
    actualCost,
    creditsCharged,
    balanceAfter,
    partiallyCharged: creditsCharged < actualCost,
  };
}

/** What the monthly spend limit leaves to spend this month; Infinity without a limit. */
export function monthlySpendAllowance(monthlySpendLimit: number | null, monthlySpend: number): number {
  return monthlySpendLimit === null ? Number.POSITIVE_INFINITY : Math.max(monthlySpendLimit - monthlySpend, 0);
}

export type CreditAdmission =
  | { ok: true }
  | { ok: false; code: "insufficient_credits" | "monthly_spend_limit_reached"; message: string };

/**
 * Whether an inference request may start: the account needs a positive balance and,
 * with a monthly spend limit, to have been charged less than the limit this UTC month.
 */
export function creditAdmission(account: {
  balance: number;
  monthlySpendLimit: number | null;
  monthlySpend: number;
  /** When the monthly spend limit resets: the start of the next UTC month. */
  periodEnd: Date;
}): CreditAdmission {
  if (!hasAvailableCredits(account.balance)) {
    return { ok: false, code: "insufficient_credits", message: "Insufficient credit balance" };
  }
  if (monthlySpendAllowance(account.monthlySpendLimit, account.monthlySpend) <= 0) {
    return {
      ok: false,
      code: "monthly_spend_limit_reached",
      message: `Monthly spend limit of $${account.monthlySpendLimit!.toFixed(2)} reached; it resets on ${account.periodEnd.toISOString().slice(0, 10)} (UTC)`,
    };
  }
  return { ok: true };
}
