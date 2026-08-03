import db from "@/db";
import { userTable, creditEventsTable } from "../schema";
import { eq, gt } from "drizzle-orm";

export default async function resetCredits() {
  return await db.transaction(async (tx) => {
    // Query all users with their individual monthly quotas (skip users with quota = 0)
    const users = await tx
      .select({
        id: userTable.id,
        defaultMonthlyCredits: userTable.defaultMonthlyCredits,
        creditBalance: userTable.creditBalance,
      })
      .from(userTable)
      .where(gt(userTable.defaultMonthlyCredits, 0));

    for (const user of users) {
      // Calculate the actual net change (can be negative if user is over quota)
      const netChange = user.defaultMonthlyCredits - user.creditBalance;

      await tx
        .update(userTable)
        .set({ creditBalance: user.defaultMonthlyCredits })
        .where(eq(userTable.id, user.id));

      await tx.insert(creditEventsTable).values({
        userId: user.id,
        requestId: crypto.randomUUID(),
        source: "system",
        creditsAdded: Math.max(0, netChange),
        creditsConsumed: Math.abs(Math.min(0, netChange)),
        type: "monthly_reset",
        description: `Monthly credit reset to ${user.defaultMonthlyCredits.toFixed(2)}`,
      });
    }

    return { usersReset: users.length };
  });
}
