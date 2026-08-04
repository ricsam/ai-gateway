import db from "@/db";
import resetCredits from "./jobs/reset-credits";

const CHECK_INTERVAL_MS = 60_000;
function monthKey(date: Date): string { return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`; }

async function tick(now = new Date()): Promise<void> {
  if (now.getUTCDate() !== 1) return;
  const month = monthKey(now); const lock = `llm-proxy:monthly-credit-reset:${month}`;
  const result = await db.executeRaw<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [lock]);
  if (!result.rows[0]?.locked) return;
  try {
    const prior = await db.executeRaw<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM audit_events WHERE action = 'credits.monthly_reset' AND metadata->>'month' = $1) AS exists", [month]);
    if (prior.rows[0]?.exists) return;
    const reset = await resetCredits();
    await db.executeRaw("INSERT INTO audit_events (id, actor_type, action, target_type, request_id, metadata, created_at) VALUES ($1, 'system', 'credits.monthly_reset', 'users', $2, $3::jsonb, now())", [crypto.randomUUID(), crypto.randomUUID(), JSON.stringify({ month, usersReset: reset.usersReset })]);
  } catch (error) { console.error("[scheduler] Automatic monthly credit reset failed", error); }
  finally { await db.executeRaw("SELECT pg_advisory_unlock(hashtext($1))", [lock]); }
}

export function startMonthlyCreditResetScheduler() {
  void tick(); const interval = setInterval(() => void tick(), CHECK_INTERVAL_MS);
  return { stop() { clearInterval(interval); } };
}
