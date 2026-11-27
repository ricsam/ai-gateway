import { describe, expect, test } from "bun:test";
import { calculateCreditSettlement, creditAdmission, hasAvailableCredits, monthlySpendAllowance } from "./credit-settlement";

describe("hasAvailableCredits", () => {
  test("allows any positive balance and rejects exhausted balances", () => {
    expect(hasAvailableCredits(0.0067)).toBe(true);
    expect(hasAvailableCredits(0)).toBe(false);
    expect(hasAvailableCredits(-0.01)).toBe(false);
    expect(hasAvailableCredits(Number.NaN)).toBe(false);
  });
});

describe("calculateCreditSettlement", () => {
  test("charges the full cost when sufficient credits remain", () => {
    const settlement = calculateCreditSettlement(10, 3);

    expect(settlement).toEqual({
      actualCost: 3,
      creditsCharged: 3,
      balanceAfter: 7,
      partiallyCharged: false,
    });
  });

  test("charges the remaining balance and clamps an oversized request to zero", () => {
    const settlement = calculateCreditSettlement(0.01, 10);

    expect(settlement.actualCost).toBe(10);
    expect(settlement.creditsCharged).toBe(0.01);
    expect(settlement.balanceAfter).toBe(0);
    expect(settlement.partiallyCharged).toBe(true);
  });

  test("treats an exact final charge as fully charged", () => {
    const settlement = calculateCreditSettlement(0.01, 0.01);

    expect(settlement.creditsCharged).toBe(0.01);
    expect(settlement.balanceAfter).toBe(0);
    expect(settlement.partiallyCharged).toBe(false);
  });

  test("allows a fractional positive balance to be fully consumed", () => {
    const settlement = calculateCreditSettlement(0.0067, 0.02);

    expect(settlement.creditsCharged).toBe(0.0067);
    expect(settlement.balanceAfter).toBe(0);
    expect(settlement.partiallyCharged).toBe(true);
  });

  test("records actual cost without charging an already exhausted balance", () => {
    const settlement = calculateCreditSettlement(0, 2);

    expect(settlement.actualCost).toBe(2);
    expect(settlement.creditsCharged).toBe(0);
    expect(settlement.balanceAfter).toBe(0);
    expect(settlement.partiallyCharged).toBe(true);
  });

  test("never charges concurrent settlements beyond the original balance", () => {
    const first = calculateCreditSettlement(0.01, 0.03);
    const second = calculateCreditSettlement(first.balanceAfter, 0.02);

    expect(first.creditsCharged + second.creditsCharged).toBeCloseTo(0.01);
    expect(second.creditsCharged).toBe(0);
    expect(second.actualCost).toBe(0.02);
    expect(second.balanceAfter).toBe(0);
  });

  test("rejects invalid costs", () => {
    expect(() => calculateCreditSettlement(1, -1)).toThrow();
    expect(() => calculateCreditSettlement(1, Number.NaN)).toThrow();
    expect(() => calculateCreditSettlement(1, Number.POSITIVE_INFINITY)).toThrow();
    expect(() => calculateCreditSettlement(Number.NaN, 1)).toThrow();
    expect(() => calculateCreditSettlement(1, 1, Number.NaN)).toThrow();
  });

  test("charges no more than the monthly spend limit leaves, keeping the rest of the balance", () => {
    expect(calculateCreditSettlement(800, 5, 2)).toEqual({ actualCost: 5, creditsCharged: 2, balanceAfter: 798, partiallyCharged: true });
    expect(calculateCreditSettlement(800, 1.5, 2)).toEqual({ actualCost: 1.5, creditsCharged: 1.5, balanceAfter: 798.5, partiallyCharged: false });
    expect(calculateCreditSettlement(800, 2, 2)).toEqual({ actualCost: 2, creditsCharged: 2, balanceAfter: 798, partiallyCharged: false });
    expect(calculateCreditSettlement(800, 3, 0)).toEqual({ actualCost: 3, creditsCharged: 0, balanceAfter: 800, partiallyCharged: true });
    expect(calculateCreditSettlement(800, 3, -4)).toEqual({ actualCost: 3, creditsCharged: 0, balanceAfter: 800, partiallyCharged: true });
  });

  test("the balance still bounds a charge under a larger spend allowance", () => {
    expect(calculateCreditSettlement(1, 5, 100)).toEqual({ actualCost: 5, creditsCharged: 1, balanceAfter: 0, partiallyCharged: true });
    expect(calculateCreditSettlement(10, 3, Number.POSITIVE_INFINITY)).toEqual(calculateCreditSettlement(10, 3));
  });
});

describe("monthlySpendAllowance", () => {
  test("is unlimited without a limit and never negative with one", () => {
    expect(monthlySpendAllowance(null, 1_000)).toBe(Number.POSITIVE_INFINITY);
    expect(monthlySpendAllowance(300, 120)).toBe(180);
    expect(monthlySpendAllowance(300, 300)).toBe(0);
    expect(monthlySpendAllowance(100, 300)).toBe(0);
  });
});

describe("creditAdmission", () => {
  const periodEnd = new Date("2026-12-01T00:00:00.000Z");

  test("admits a positive balance below the monthly spend limit", () => {
    expect(creditAdmission({ balance: 10, monthlySpendLimit: null, monthlySpend: 5_000, periodEnd })).toEqual({ ok: true });
    expect(creditAdmission({ balance: 10, monthlySpendLimit: 300, monthlySpend: 299.99, periodEnd })).toEqual({ ok: true });
  });

  test("refuses an exhausted balance first", () => {
    expect(creditAdmission({ balance: 0, monthlySpendLimit: 300, monthlySpend: 300, periodEnd })).toEqual({
      ok: false, code: "insufficient_credits", message: "Insufficient credit balance",
    });
  });

  test("refuses once the month's spend reaches the limit, whatever the balance", () => {
    for (const monthlySpend of [300, 301]) {
      expect(creditAdmission({ balance: 1_000, monthlySpendLimit: 300, monthlySpend, periodEnd })).toEqual({
        ok: false, code: "monthly_spend_limit_reached",
        message: "Monthly spend limit of $300.00 reached; it resets on 2026-12-01 (UTC)",
      });
    }
    expect(creditAdmission({ balance: 1_000, monthlySpendLimit: 0, monthlySpend: 0, periodEnd })).toMatchObject({ ok: false, code: "monthly_spend_limit_reached" });
  });
});
