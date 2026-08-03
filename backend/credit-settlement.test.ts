import { describe, expect, test } from "bun:test";
import { calculateCreditSettlement, hasAvailableCredits } from "./credit-settlement";

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
  });
});
