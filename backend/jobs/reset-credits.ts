import db from "@/db";
import { userTable, creditEventsTable } from "../schema";
import { eq, gt, sql } from "drizzle-orm";
import { formatCreditUnits, parseCreditUnits, planMonthlyCredits, rolloverAppliedThisMonth } from "../monthly-credits";

export type MonthlyCreditRun = {
  /** Reset accounts whose balance was replaced with their monthly credits. */
  usersReset: number;
  /** Rollover accounts that received this month's credits, including ones a rollover cap trimmed or skipped. */
  usersRolledOver: number;
  /** Rollover accounts left alone because they already received this month's credits. */
  usersSkipped: number;
};

/**
 * The monthly run: applies every account's monthly credits by its monthly credit mode.
 * The scheduler runs it on the first day of each UTC month, and administrators can
 * run it at any time. Accounts without monthly credits are skipped. A reset replaces
 * the balance whenever it runs; a rollover adds credits only once per UTC month, so
 * running it again cannot give rollover accounts a month's credits twice.
 */
export default async function resetCredits(now = new Date()): Promise<MonthlyCreditRun> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('ai-gateway:credit-reset'))`);
    // Lock before reading the balance used for the ledger delta. Otherwise a
    // concurrent settlement/adjustment can commit between this read and reset.
    // Amounts are read as text and computed exactly, so the ledger reconciles.
    const users = await tx
      .select({
        id: userTable.id,
        mode: userTable.monthlyCreditMode,
        monthlyCredits: sql<string>`${userTable.defaultMonthlyCredits}::text`,
        balance: sql<string>`${userTable.creditBalance}::text`,
        rolloverCap: sql<string | null>`${userTable.rolloverCap}::text`,
        appliedAt: userTable.monthlyCreditsAppliedAt,
      })
      .from(userTable)
      .where(gt(userTable.defaultMonthlyCredits, 0))
      .orderBy(userTable.id)
      .for("update");

    const run: MonthlyCreditRun = { usersReset: 0, usersRolledOver: 0, usersSkipped: 0 };
    for (const user of users) {
      if (user.mode === "rollover" && rolloverAppliedThisMonth(user.appliedAt, now)) {
        run.usersSkipped++;
        continue;
      }
      const plan = planMonthlyCredits({
        mode: user.mode,
        monthlyCredits: parseCreditUnits(user.monthlyCredits),
        balance: parseCreditUnits(user.balance),
        rolloverCap: user.rolloverCap === null ? null : parseCreditUnits(user.rolloverCap),
      });

      await tx
        .update(userTable)
        .set({ creditBalance: sql`${formatCreditUnits(plan.balanceAfter)}::numeric`, monthlyCreditsAppliedAt: now })
        .where(eq(userTable.id, user.id));

      await tx.insert(creditEventsTable).values({
        userId: user.id,
        requestId: crypto.randomUUID(),
        source: "system",
        creditsAdded: sql`${formatCreditUnits(plan.change > 0n ? plan.change : 0n)}::numeric`,
        creditsConsumed: sql`${formatCreditUnits(plan.change < 0n ? -plan.change : 0n)}::numeric`,
        type: "monthly_reset",
        description: plan.description,
      });
      if (user.mode === "rollover") run.usersRolledOver++;
      else run.usersReset++;
    }

    return run;
  });
}
