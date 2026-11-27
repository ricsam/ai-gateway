import type { MonthlyCreditMode } from "../shared/credit-control";

/**
 * Exact credit amounts for the monthly run: integers of 1e-8 dollars, the values
 * the numeric(20,8) columns hold. The run's ledger events must reconcile exactly
 * with the balance (see usage-budget-query.ts), so it does no float arithmetic.
 */
export type CreditUnits = bigint;

const SCALE = 100_000_000n;
const AMOUNT = /^(-?)(\d+)(?:\.(\d{1,8}))?$/;

/** Parses a numeric(20,8) value as PostgreSQL prints it, such as "550.12000000". */
export function parseCreditUnits(text: string): CreditUnits {
  const match = AMOUNT.exec(text.trim());
  if (!match) throw new Error(`Not a credit amount: ${JSON.stringify(text)}`);
  const units = BigInt(match[2]!) * SCALE + BigInt((match[3] ?? "").padEnd(8, "0"));
  return match[1] ? -units : units;
}

/** Formats units as a numeric literal with eight decimals, such as "50.00000000". */
export function formatCreditUnits(units: CreditUnits): string {
  const magnitude = units < 0n ? -units : units;
  return `${units < 0n ? "-" : ""}${magnitude / SCALE}.${(magnitude % SCALE).toString().padStart(8, "0")}`;
}

/** Dollars with two decimals, as ledger descriptions show amounts. */
function dollars(units: CreditUnits): string {
  return (Number(units) / Number(SCALE)).toFixed(2);
}

const min = (a: CreditUnits, b: CreditUnits) => (a < b ? a : b);
const max = (a: CreditUnits, b: CreditUnits) => (a > b ? a : b);

export interface MonthlyCreditAccount {
  mode: MonthlyCreditMode;
  /** The account's monthly credits (defaultMonthlyCredits). */
  monthlyCredits: CreditUnits;
  balance: CreditUnits;
  /** Rollover mode only: the balance the monthly credits may bring the account up to; null is no cap. */
  rolloverCap: CreditUnits | null;
}

export interface MonthlyCreditPlan {
  balanceAfter: CreditUnits;
  /** balanceAfter - balance: what the run adds, or removes (a reset to less than the balance). */
  change: CreditUnits;
  /** Rollover: the part of the monthly credits the rollover cap left out. */
  trimmed: CreditUnits;
  /** The ledger event's description. */
  description: string;
}

/**
 * What the monthly run does to an account. A reset replaces the balance with the
 * monthly credits. A rollover adds them to the balance, trimmed so the balance does
 * not pass the rollover cap; at or above the cap it adds nothing, and it never
 * takes away credits above the cap that top-ups gave the account.
 */
export function planMonthlyCredits(account: MonthlyCreditAccount): MonthlyCreditPlan {
  const { monthlyCredits, balance, rolloverCap } = account;
  if (account.mode === "reset") {
    return {
      balanceAfter: monthlyCredits, change: monthlyCredits - balance, trimmed: 0n,
      description: `Monthly credit reset to ${dollars(monthlyCredits)}`,
    };
  }
  const added = rolloverCap === null ? monthlyCredits : max(min(monthlyCredits, rolloverCap - balance), 0n);
  const trimmed = monthlyCredits - added;
  const description = trimmed === 0n
    ? `Monthly rollover of ${dollars(monthlyCredits)}`
    : added === 0n
      ? `Monthly rollover of ${dollars(monthlyCredits)} skipped: balance at or above the ${dollars(rolloverCap!)} rollover cap`
      : `Monthly rollover of ${dollars(monthlyCredits)}, trimmed to ${dollars(added)} by the ${dollars(rolloverCap!)} rollover cap`;
  return { balanceAfter: balance + added, change: added, trimmed, description };
}

/** The start of the UTC calendar month containing `at`. */
export function utcMonthStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

/**
 * Whether a rollover account already received this month's credits. A rollover adds
 * credits, so running the monthly run again in the same UTC month (manually, say)
 * must not add them twice. A reset can run any number of times.
 */
export function rolloverAppliedThisMonth(appliedAt: Date | null, now: Date): boolean {
  return appliedAt !== null && appliedAt >= utcMonthStart(now);
}
