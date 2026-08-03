import { eq } from "drizzle-orm";
import db from "@/db";
import { settingsTable } from "./schema";
import resetCredits from "./jobs/reset-credits";

const CHECK_INTERVAL_MS = 60_000;
const LAST_AUTOMATIC_RESET_KEY = "monthlyCreditResetLastAutomaticRun";
const LOCK_KEY_PREFIX = "llm-proxy:monthly-credit-reset";

function getUtcMonthKey(date: Date): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}`;
}

function isMonthlyResetWindow(date: Date): boolean {
  return date.getUTCDate() === 1;
}

function getSettingMonth(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "month" in value) {
    const month = (value as { month?: unknown }).month;
    return typeof month === "string" ? month : null;
  }
  return null;
}

async function acquireResetLock(month: string): Promise<(() => Promise<void>) | null> {
  const lockKey = `${LOCK_KEY_PREFIX}:${month}`;
  const result = await db.executeRaw<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [lockKey]);
  if (!result.rows[0]?.locked) {
    return null;
  }

  return async () => {
    await db.executeRaw("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
  };
}

async function hasCompletedResetForMonth(month: string): Promise<boolean> {
  const [setting] = await db
    .select({ value: settingsTable.value })
    .from(settingsTable)
    .where(eq(settingsTable.key, LAST_AUTOMATIC_RESET_KEY))
    .limit(1);

  return getSettingMonth(setting?.value) === month;
}

async function markResetComplete(month: string, usersReset: number): Promise<void> {
  const value = {
    month,
    usersReset,
    completedAt: new Date().toISOString(),
  };

  await db
    .insert(settingsTable)
    .values({ key: LAST_AUTOMATIC_RESET_KEY, value })
    .onConflictDoUpdate({
      target: settingsTable.key,
      set: { value },
    });
}

async function runMonthlyCreditResetIfDue(now = new Date()): Promise<void> {
  if (!isMonthlyResetWindow(now)) {
    return;
  }

  const month = getUtcMonthKey(now);
  const releaseLock = await acquireResetLock(month);
  if (!releaseLock) {
    return;
  }

  try {
    if (await hasCompletedResetForMonth(month)) {
      return;
    }

    console.log(`[scheduler] Running automatic monthly credit reset for ${month}`);
    const result = await resetCredits();
    await markResetComplete(month, result.usersReset);
    console.log(`[scheduler] Automatic monthly credit reset complete: ${result.usersReset} user(s) reset`);
  } catch (error) {
    console.error("[scheduler] Automatic monthly credit reset failed:", error);
  } finally {
    await releaseLock();
  }
}

export function startMonthlyCreditResetScheduler() {
  let isTicking = false;

  const tick = async () => {
    if (isTicking) {
      return;
    }

    isTicking = true;
    try {
      await runMonthlyCreditResetIfDue();
    } finally {
      isTicking = false;
    }
  };

  void tick();
  const interval = setInterval(() => {
    void tick();
  }, CHECK_INTERVAL_MS);

  console.log("[scheduler] Monthly credit reset scheduler started");

  return {
    stop() {
      clearInterval(interval);
      console.log("[scheduler] Monthly credit reset scheduler stopped");
    },
  };
}

