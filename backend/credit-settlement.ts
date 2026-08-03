export interface CreditSettlement {
  actualCost: number;
  creditsCharged: number;
  balanceAfter: number;
  partiallyCharged: boolean;
}

export function hasAvailableCredits(balance: number): boolean {
  return Number.isFinite(balance) && balance > 0;
}

export function calculateCreditSettlement(currentBalance: number, actualCost: number): CreditSettlement {
  if (!Number.isFinite(currentBalance)) {
    throw new Error("Credit balance must be a finite number");
  }
  if (!Number.isFinite(actualCost) || actualCost < 0) {
    throw new Error("Credit cost must be a finite non-negative number");
  }

  const availableCredits = Math.max(currentBalance, 0);
  const creditsCharged = Math.min(actualCost, availableCredits);
  const balanceAfter = Math.max(availableCredits - actualCost, 0);

  return {
    actualCost,
    creditsCharged,
    balanceAfter,
    partiallyCharged: creditsCharged < actualCost,
  };
}
