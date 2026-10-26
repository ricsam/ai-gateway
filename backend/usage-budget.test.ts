import { describe, expect, test } from "bun:test";
import { buildPeriodBudget, type BudgetUnavailableReason, type PeriodBudgetAmounts } from "./usage-contract";

const funding: PeriodBudgetAmounts = {
  opening_balance: 150,
  top_ups: 100,
  adjustment_removals: 0,
  reset_additions: 0,
  reset_removals: 0,
  net_funding: 100,
  effective_budget: 250,
};

describe("authoritative period budget serialization", () => {
  test("top-ups increase the denominator independently of recurring allocation", () => {
    const budget = buildPeriodBudget(funding, 163.22, 86.78, null);
    expect(budget).toMatchObject({ version: 1, status: "available", reason: null, ...funding, metered_spend: 163.22, remaining: 86.78 });
    expect(budget.percent_used).toBeCloseTo(65.288, 6);
  });

  test("zero funding is known zero, not unlimited; exhaustion is 100 percent", () => {
    expect(buildPeriodBudget({ ...funding, effective_budget: 0 }, 0, 0, null).percent_used).toBeNull();
    expect(buildPeriodBudget(funding, 250, 0, null).percent_used).toBe(100);
  });

  test("does not clamp percentages", () => {
    expect(buildPeriodBudget(funding, 275, -25, null).percent_used).toBeCloseTo(110, 8);
  });

  test("unavailable funding is never zero and retains known metering/balance", () => {
    for (const reason of ["unsupported_ledger_event", "future_ledger_event", "ledger_balance_mismatch", "invalid_amount"] satisfies BudgetUnavailableReason[]) {
      const budget = buildPeriodBudget(funding, 163.22, 86.88, reason);
      expect(budget).toMatchObject({ status: "unavailable", reason, metered_spend: 163.22, remaining: 86.88, percent_used: null });
      for (const key of Object.keys(funding) as Array<keyof PeriodBudgetAmounts>) expect(budget[key]).toBeNull();
    }
  });

  test("does not normalize invalid budget numbers into plausible zeroes", () => {
    expect(buildPeriodBudget({ ...funding, opening_balance: NaN }, 0, 0, null)).toMatchObject({ status: "unavailable", reason: "invalid_amount", opening_balance: null });
    expect(buildPeriodBudget(funding, Infinity, NaN, null)).toMatchObject({ status: "unavailable", metered_spend: null, remaining: null, percent_used: null });
  });
});
