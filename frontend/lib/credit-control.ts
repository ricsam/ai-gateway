import type { MonthlyCreditMode } from "@/shared/credit-control";

/** How an account's monthly credits work, as the management API takes and returns it. */
export interface CreditControl {
  monthlyCreditMode: MonthlyCreditMode;
  rolloverCap: number | null;
  monthlySpendLimit: number | null;
}

/** The form's values: amounts as typed, where blank means no cap or limit. */
export interface CreditControlDraft {
  monthlyCreditMode: MonthlyCreditMode;
  rolloverCap: string;
  monthlySpendLimit: string;
}

export const DEFAULT_CREDIT_CONTROL_DRAFT: CreditControlDraft = { monthlyCreditMode: "reset", rolloverCap: "", monthlySpendLimit: "" };

export function creditControlDraft(control: CreditControl): CreditControlDraft {
  return {
    monthlyCreditMode: control.monthlyCreditMode,
    rolloverCap: control.rolloverCap === null ? "" : String(control.rolloverCap),
    monthlySpendLimit: control.monthlySpendLimit === null ? "" : String(control.monthlySpendLimit),
  };
}

function optionalAmount(text: string, label: string): number | null {
  if (!text.trim()) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be blank or an amount of zero or more`);
  return value;
}

/** The draft as an API body; throws with a message for the form when an amount is invalid. */
export function parseCreditControlDraft(draft: CreditControlDraft): CreditControl {
  return {
    monthlyCreditMode: draft.monthlyCreditMode,
    rolloverCap: optionalAmount(draft.rolloverCap, "Rollover cap"),
    monthlySpendLimit: optionalAmount(draft.monthlySpendLimit, "Max monthly spend"),
  };
}

const usd = (value: number) => `$${value.toFixed(2)}`;

/** What the monthly run would do to an account with this balance, as backend/monthly-credits.ts does it. */
export function monthlyRunPreview(control: CreditControl, monthlyCredits: number, balance: number): string {
  if (!(monthlyCredits > 0)) return "Without a monthly quota, the monthly run leaves this account's balance alone.";
  if (control.monthlyCreditMode === "reset") return `The monthly run sets the balance to ${usd(monthlyCredits)}; unspent credits expire.`;
  const cap = control.rolloverCap;
  const added = cap === null ? monthlyCredits : Math.max(Math.min(monthlyCredits, cap - balance), 0);
  if (added >= monthlyCredits) return `The monthly run adds ${usd(monthlyCredits)} to the balance: ${usd(balance)} now would become ${usd(balance + monthlyCredits)}.`;
  if (added <= 0) return `The monthly run adds nothing while the balance (${usd(balance)} now) is at or above the ${usd(cap!)} cap.`;
  return `The monthly run adds ${usd(added)} of the ${usd(monthlyCredits)} quota, since the ${usd(cap!)} cap trims the rest: ${usd(balance)} now would become ${usd(cap!)}.`;
}

/** Lines describing a rollover cap and monthly spend limit, for tables and cards. */
export function creditControlDetails(control: CreditControl, monthlySpendRemaining?: number | null): string[] {
  const lines: string[] = [];
  if (control.monthlyCreditMode === "rollover") lines.push(control.rolloverCap === null ? "No rollover cap" : `Cap ${usd(control.rolloverCap)}`);
  if (control.monthlySpendLimit !== null) {
    lines.push(`Max ${usd(control.monthlySpendLimit)}/month${monthlySpendRemaining !== undefined && monthlySpendRemaining !== null ? ` · ${usd(monthlySpendRemaining)} left` : ""}`);
  }
  return lines;
}

/** How a user's own credits work, for their profile. */
export function accountCreditNote(account: CreditControl & { monthlyCredits: number; monthlySpendRemaining: number | null }): string {
  const parts = [account.monthlyCredits > 0
    ? account.monthlyCreditMode === "rollover"
      ? `At the start of each UTC month, ${usd(account.monthlyCredits)} is added to your balance, so unspent credits carry over${account.rolloverCap === null ? "" : `, up to a balance of ${usd(account.rolloverCap)}`}.`
      : `At the start of each UTC month, your balance is reset to ${usd(account.monthlyCredits)}; unspent credits expire.`
    : "You have no monthly allocation: your balance changes with your usage and with administrator adjustments."];
  if (account.monthlySpendLimit !== null) {
    parts.push(`You can spend up to ${usd(account.monthlySpendLimit)} per UTC month${account.monthlySpendRemaining === null ? "" : `, and ${usd(account.monthlySpendRemaining)} of it is left this month`}.`);
  }
  return parts.join(" ");
}
