import db from "@/db";
import { userTable, creditEventsTable } from "./schema";
import { eq, sql } from "drizzle-orm";
import { calculateCreditSettlement, type CreditSettlement } from "./credit-settlement";

export async function checkBalance(userId: string): Promise<number> {
  const user = await db
    .select({ creditBalance: userTable.creditBalance })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .then((rows) => rows[0]);
  return user?.creditBalance ?? 0;
}

export interface CostBreakdown {
  total: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWrite5mCost: number;
  cacheWrite1hCost: number;
}

export async function deductCredits(params: {
  userId: string;
  amount: number;
  type: "chat" | "api";
  description: string;
  requestId?: string;
  apiKeyId?: string;
  source?: "api" | "playground";
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  // Cost breakdown fields
  inputCost?: number;
  outputCost?: number;
  cacheReadCost?: number;
  cacheWrite5mCost?: number;
  cacheWrite1hCost?: number;
}): Promise<CreditSettlement> {
  return await db.transaction(async (tx) => {
    // Serialize settlements per user so concurrent completions see the latest balance.
    const user = await tx
      .select({ creditBalance: userTable.creditBalance })
      .from(userTable)
      .where(eq(userTable.id, params.userId))
      .limit(1)
      .for("update")
      .then((rows) => rows[0]);

    if (!user) {
      throw new Error("User not found");
    }

    const settlement = calculateCreditSettlement(user.creditBalance, params.amount);

    await tx
      .update(userTable)
      .set({ creditBalance: settlement.balanceAfter })
      .where(eq(userTable.id, params.userId));

    await tx.insert(creditEventsTable).values({
      userId: params.userId,
      requestId: params.requestId ?? crypto.randomUUID(),
      apiKeyId: params.apiKeyId,
      source: params.source ?? (params.type === "chat" ? "playground" : "api"),
      creditsConsumed: settlement.creditsCharged,
      creditsAdded: 0,
      type: "usage",
      description: params.description,
      model: params.modelId,
      inputTokens: params.inputTokens ?? 0,
      outputTokens: params.outputTokens ?? 0,
      cacheReadTokens: params.cacheReadTokens ?? 0,
      cacheWrite5mTokens: params.cacheWrite5mTokens ?? 0,
      cacheWrite1hTokens: params.cacheWrite1hTokens ?? 0,
      inputCost: params.inputCost ?? 0,
      outputCost: params.outputCost ?? 0,
      cacheReadCost: params.cacheReadCost ?? 0,
      cacheWrite5mCost: params.cacheWrite5mCost ?? 0,
      cacheWrite1hCost: params.cacheWrite1hCost ?? 0,
    });

    return settlement;
  });
}

export async function addCredits(params: {
  userId: string;
  amount: number;
  type: "monthly_reset" | "admin_adjustment";
  description: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(userTable)
      .set({ creditBalance: sql`${userTable.creditBalance} + ${params.amount}` })
      .where(eq(userTable.id, params.userId));

    await tx.insert(creditEventsTable).values({
      userId: params.userId,
      requestId: crypto.randomUUID(),
      source: "system",
      creditsAdded: Math.max(0, params.amount),
      creditsConsumed: Math.abs(Math.min(0, params.amount)),
      type: params.type,
      description: params.description,
    });
  });
}

export interface CostParams {
  inputTokens: number;
  outputTokens: number;
  inputPricePerMTok: number;
  outputPricePerMTok: number;
  cacheReadTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  cacheReadPricePerMTok?: number;
  cacheWrite5mPricePerMTok?: number;
  cacheWrite1hPricePerMTok?: number;
}

export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  inputPricePerMTok: number,
  outputPricePerMTok: number,
): number;
export function calculateCost(params: CostParams): number;
export function calculateCost(
  inputTokensOrParams: number | CostParams,
  outputTokens?: number,
  inputPricePerMTok?: number,
  outputPricePerMTok?: number,
): number {
  // Handle legacy signature for backward compatibility
  if (typeof inputTokensOrParams === "number") {
    return (inputTokensOrParams * inputPricePerMTok! + outputTokens! * outputPricePerMTok!) / 1_000_000;
  }

  // New params-based signature with cache support
  const params = inputTokensOrParams;
  const baseCost = params.inputTokens * params.inputPricePerMTok + params.outputTokens * params.outputPricePerMTok;
  
  let cacheCost = 0;
  if (params.cacheReadTokens && params.cacheReadPricePerMTok) {
    cacheCost += params.cacheReadTokens * params.cacheReadPricePerMTok;
  }
  if (params.cacheWrite5mTokens && params.cacheWrite5mPricePerMTok) {
    cacheCost += params.cacheWrite5mTokens * params.cacheWrite5mPricePerMTok;
  }
  if (params.cacheWrite1hTokens && params.cacheWrite1hPricePerMTok) {
    cacheCost += params.cacheWrite1hTokens * params.cacheWrite1hPricePerMTok;
  }

  return (baseCost + cacheCost) / 1_000_000;
}

/**
 * Calculate cost breakdown with individual cost components.
 * Returns total and per-token-type costs.
 */
export function calculateCostBreakdown(params: CostParams): CostBreakdown {
  const inputCost = (params.inputTokens * params.inputPricePerMTok) / 1_000_000;
  const outputCost = (params.outputTokens * params.outputPricePerMTok) / 1_000_000;
  
  let cacheReadCost = 0;
  let cacheWrite5mCost = 0;
  let cacheWrite1hCost = 0;
  
  if (params.cacheReadTokens && params.cacheReadPricePerMTok) {
    cacheReadCost = (params.cacheReadTokens * params.cacheReadPricePerMTok) / 1_000_000;
  }
  if (params.cacheWrite5mTokens && params.cacheWrite5mPricePerMTok) {
    cacheWrite5mCost = (params.cacheWrite5mTokens * params.cacheWrite5mPricePerMTok) / 1_000_000;
  }
  if (params.cacheWrite1hTokens && params.cacheWrite1hPricePerMTok) {
    cacheWrite1hCost = (params.cacheWrite1hTokens * params.cacheWrite1hPricePerMTok) / 1_000_000;
  }

  const total = inputCost + outputCost + cacheReadCost + cacheWrite5mCost + cacheWrite1hCost;

  return {
    total,
    inputCost,
    outputCost,
    cacheReadCost,
    cacheWrite5mCost,
    cacheWrite1hCost,
  };
}
