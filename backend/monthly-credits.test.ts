import { describe, expect, test } from "bun:test";
import {
  formatCreditUnits, parseCreditUnits, planMonthlyCredits, rolloverAppliedThisMonth, utcMonthStart,
  type MonthlyCreditAccount,
} from "./monthly-credits";

const units = (dollars: string) => parseCreditUnits(dollars);
const rollover = (balance: string, rolloverCap: string | null, monthlyCredits = "100"): MonthlyCreditAccount => ({
  mode: "rollover", monthlyCredits: units(monthlyCredits), balance: units(balance), rolloverCap: rolloverCap === null ? null : units(rolloverCap),
});

describe("credit units", () => {
  test("round-trip numeric(20,8) values exactly", () => {
    for (const text of ["0.00000000", "550.12345678", "999999999999.99999999", "-12.50000000"]) {
      expect(formatCreditUnits(parseCreditUnits(text))).toBe(text);
    }
    expect(parseCreditUnits("25")).toBe(2_500_000_000n);
    expect(parseCreditUnits("0.1")).toBe(10_000_000n);
    expect(formatCreditUnits(parseCreditUnits("0.1") + parseCreditUnits("0.2"))).toBe("0.30000000");
  });

  test("refuse anything else", () => {
    for (const text of ["", "abc", "1e3", "1.123456789", "NaN", "Infinity"]) expect(() => parseCreditUnits(text)).toThrow();
  });
});

describe("planMonthlyCredits", () => {
  test("a reset replaces the balance, adding or removing credits", () => {
    expect(planMonthlyCredits({ mode: "reset", monthlyCredits: units("100"), balance: units("13.22"), rolloverCap: null })).toEqual({
      balanceAfter: units("100"), change: units("86.78"), trimmed: 0n, description: "Monthly credit reset to 100.00",
    });
    // A rollover cap means nothing to a reset, and unspent credits expire.
    expect(planMonthlyCredits({ mode: "reset", monthlyCredits: units("100"), balance: units("550"), rolloverCap: units("600") })).toMatchObject({
      balanceAfter: units("100"), change: units("-450"),
    });
  });

  test("a rollover adds the monthly credits to the balance", () => {
    expect(planMonthlyCredits(rollover("86.78", null))).toEqual({
      balanceAfter: units("186.78"), change: units("100"), trimmed: 0n, description: "Monthly rollover of 100.00",
    });
    expect(planMonthlyCredits(rollover("0", "600"))).toMatchObject({ balanceAfter: units("100"), change: units("100"), trimmed: 0n });
    expect(planMonthlyCredits(rollover("500", "600"))).toMatchObject({ balanceAfter: units("600"), change: units("100"), trimmed: 0n });
  });

  test("the rollover cap trims the monthly credits that would take the balance past it", () => {
    // The issue's example: $550 banked, $100 a month and a $600 cap add only $50.
    expect(planMonthlyCredits(rollover("550", "600"))).toEqual({
      balanceAfter: units("600"), change: units("50"), trimmed: units("50"),
      description: "Monthly rollover of 100.00, trimmed to 50.00 by the 600.00 rollover cap",
    });
    expect(planMonthlyCredits(rollover("550.12345678", "600"))).toMatchObject({
      balanceAfter: units("600"), change: units("49.87654322"), trimmed: units("50.12345678"),
    });
  });

  test("at or above the cap the monthly credits are skipped, and a top-up above it is kept", () => {
    for (const balance of ["600", "750"]) {
      expect(planMonthlyCredits(rollover(balance, "600"))).toEqual({
        balanceAfter: units(balance), change: 0n, trimmed: units("100"),
        description: "Monthly rollover of 100.00 skipped: balance at or above the 600.00 rollover cap",
      });
    }
  });

  test("six months of $100 bank $600 under a $600 cap, then stop growing", () => {
    let balance = 0n;
    const balances: string[] = [];
    for (let month = 0; month < 8; month++) {
      balance = planMonthlyCredits({ mode: "rollover", monthlyCredits: units("100"), balance, rolloverCap: units("600") }).balanceAfter;
      balances.push(formatCreditUnits(balance));
    }
    expect(balances).toEqual(["100", "200", "300", "400", "500", "600", "600", "600"].map((value) => `${value}.00000000`));
  });
});

describe("rollover months", () => {
  test("a rollover applies once per UTC calendar month", () => {
    const now = new Date("2026-11-15T12:00:00.000Z");
    expect(utcMonthStart(now).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(rolloverAppliedThisMonth(null, now)).toBe(false);
    expect(rolloverAppliedThisMonth(new Date("2026-10-31T23:59:59.999Z"), now)).toBe(false);
    expect(rolloverAppliedThisMonth(new Date("2026-11-01T00:00:00.000Z"), now)).toBe(true);
    expect(rolloverAppliedThisMonth(new Date("2026-11-15T11:00:00.000Z"), now)).toBe(true);
    // The first of the month starts a new one.
    expect(rolloverAppliedThisMonth(new Date("2026-11-20T00:00:00.000Z"), new Date("2026-12-01T00:00:30.000Z"))).toBe(false);
  });
});
