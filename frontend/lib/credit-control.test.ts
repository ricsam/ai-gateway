import { describe, expect, test } from "bun:test";
import {
  accountCreditNote, creditControlDetails, creditControlDraft, monthlyRunPreview, parseCreditControlDraft, type CreditControl,
} from "./credit-control";

const rollover = (rolloverCap: number | null, monthlySpendLimit: number | null = null): CreditControl => ({ monthlyCreditMode: "rollover", rolloverCap, monthlySpendLimit });

describe("credit control drafts", () => {
  test("blank amounts mean no cap or limit", () => {
    expect(parseCreditControlDraft({ monthlyCreditMode: "rollover", rolloverCap: " ", monthlySpendLimit: "" })).toEqual(rollover(null));
    expect(parseCreditControlDraft({ monthlyCreditMode: "rollover", rolloverCap: "600", monthlySpendLimit: "0" })).toEqual(rollover(600, 0));
    expect(creditControlDraft(rollover(600, null))).toEqual({ monthlyCreditMode: "rollover", rolloverCap: "600", monthlySpendLimit: "" });
  });

  test("refuse negative or non-numeric amounts", () => {
    expect(() => parseCreditControlDraft({ monthlyCreditMode: "reset", rolloverCap: "", monthlySpendLimit: "-1" })).toThrow("Max monthly spend must be blank or an amount of zero or more");
    expect(() => parseCreditControlDraft({ monthlyCreditMode: "rollover", rolloverCap: "abc", monthlySpendLimit: "" })).toThrow("Rollover cap");
  });
});

describe("monthly run preview", () => {
  test("describes resets, rollovers and the cap trimming the issue's example", () => {
    expect(monthlyRunPreview({ monthlyCreditMode: "reset", rolloverCap: null, monthlySpendLimit: null }, 100, 37)).toBe("The monthly run sets the balance to $100.00; unspent credits expire.");
    expect(monthlyRunPreview(rollover(null), 100, 37)).toBe("The monthly run adds $100.00 to the balance: $37.00 now would become $137.00.");
    expect(monthlyRunPreview(rollover(600), 100, 550)).toBe("The monthly run adds $50.00 of the $100.00 quota, since the $600.00 cap trims the rest: $550.00 now would become $600.00.");
    expect(monthlyRunPreview(rollover(600), 100, 650)).toBe("The monthly run adds nothing while the balance ($650.00 now) is at or above the $600.00 cap.");
    expect(monthlyRunPreview(rollover(600), 0, 10)).toContain("Without a monthly quota");
  });
});

describe("credit control descriptions", () => {
  test("list the rollover cap and what the monthly spend limit leaves", () => {
    expect(creditControlDetails({ monthlyCreditMode: "reset", rolloverCap: 600, monthlySpendLimit: null })).toEqual([]);
    expect(creditControlDetails(rollover(null))).toEqual(["No rollover cap"]);
    expect(creditControlDetails(rollover(600, 300), 136.78)).toEqual(["Cap $600.00", "Max $300.00/month · $136.78 left"]);
  });

  test("explain an account's own credits", () => {
    expect(accountCreditNote({ ...rollover(600, 300), monthlyCredits: 100, monthlySpendRemaining: 136.78 })).toBe(
      "At the start of each UTC month, $100.00 is added to your balance, so unspent credits carry over, up to a balance of $600.00. You can spend up to $300.00 per UTC month, and $136.78 of it is left this month.",
    );
    expect(accountCreditNote({ monthlyCreditMode: "reset", rolloverCap: null, monthlySpendLimit: null, monthlyCredits: 50, monthlySpendRemaining: null })).toBe(
      "At the start of each UTC month, your balance is reset to $50.00; unspent credits expire.",
    );
  });
});
