# Period budget verification (issue 294)

Verified on 2026-10-26 against an isolated TimescaleDB 2.19.3 / PostgreSQL 17 container, using a fresh migrated database and synthetic development accounts. No production database, reporter account, or provider inference calls were used.

## Reproduce

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
# Point to a development TimescaleDB administrator with CREATE DATABASE permission.
TIMESCALE_ADMIN_URL=postgres://user:password@localhost:5432/postgres bun run usage:verify-budget
```

The verifier creates a uniquely named database, runs the production public handlers over loopback HTTP with real `credits.read` inference keys, and exercises production funding/settlement/reset writers. It drops only its own database in `finally`. Its exact resource manifest and captured JSON responses remain under the printed `.data/usage-budget-*/` directory for inspection. Never point the script at an environment where creating a development database is inappropriate. No API key or administrator credential is recorded in response captures.

## Inspected endpoint results

All rows below are sequential observations of the same synthetic owner unless noted. Funding figures are USD. `credits.monthly_allocation` and `credits.percent_used` retain their legacy meanings.

| Scenario | Opening | Top-ups | Adjustment removals | Reset additions | Reset removals | Effective budget | Metered spend | Remaining |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Opening carry-in | 150 | 0 | 0 | 0 | 0 | 150 | 0 | 150 |
| Top-up + metered spend | 150 | 100 | 0 | 0 | 0 | 250 | 163.22 | 86.78 |
| Remove 20 | 150 | 100 | 20 | 0 | 0 | 230 | 163.22 | 66.78 |
| Edit allocation 150 → 200 | 150 | 100 | 20 | 0 | 0 | 230 | 163.22 | 66.78 |
| Reset replaces balance with 200 | 150 | 100 | 20 | 133.22 | 0 | 363.22 | 163.22 | 200 |
| Add 100 then reset back to 200 | 150 | 200 | 20 | 133.22 | 100 | 363.22 | 163.22 | 200 |
| Exhaust balance (500 requested, 200 charged) | 150 | 200 | 20 | 133.22 | 100 | 363.22 | 363.22 | 0 |

The requested example returned **65.288%** in `budget.percent_used`, with recurring allocation **150** and legacy percentage **108.81333333333333**. The allocation-only edit changed legacy percentage to **81.61** without changing funds. Exhaustion returned **100%**. Repeated zero-delta resets did not add grants.

Additional checks passed:

- Empty zero-allocation account: known effective budget 0, percentage null. Adding 25: budget 25, remaining 25, percentage 0, legacy percentage null; reset skips this account.
- New account funded with 150 in the current month: opening 0 and top-ups 150.
- Historical usage and reset removals reduce carry-in; current-month spending does not. A reset exactly at month start is included; next-month events are not treated as current funding.
- Session timezone `Pacific/Honolulu` does not change UTC boundaries or opening funds.
- Missing history, negative opening balance, malformed/unsupported historical events, numeric NaN, future-month timestamps, same-month clock skew, and existing sub-1e-8 writer rounding drift explicitly yield unavailable funding rather than guessed numbers.
- Another owner with 999 funds remains isolated. Query-string owner/range overrides have no effect. Missing/invalid keys get 401; keys without `credits.read` get 403. `/v1/credits` is unchanged. Usage responses carry `Cache-Control: no-store`.
- A deterministic advisory gate holds the production report statement's snapshot while a top-up and settlement commit. The report returns all old values (150 balance, 0 spend, 0 top-ups); the next HTTP response returns all new values (86.78 balance, 163.22 spend, 100 top-ups).
- A reset blocked by an uncommitted adjustment reads the new balance after the writer commits, yielding the correct 36.78 reset removal and 150 balance.
- Repeated real HTTP reads during 20 top-up/settlement cycles all reconcile exactly.

## Scope and limitations

No accounting history is repaired. Existing writer rounding drift intentionally makes the budget unavailable; changing settlement rounding is separate work. A complete, accurate append-only ledger is the accounting source: reconciliation can detect discrepancies, not missing offsetting pairs of events. The report scans the owner's full history; a future checkpoint optimization must preserve the same integrity and snapshot semantics. Large-history performance was not benchmarked.

No deployment, monthly rollover wait, chart/frontend change, or reporter-specific reconciliation was performed. Synthetic events verify both sides of the boundary. The unexplained $0.10 in the issue screenshot remains unverified. No MDX documentation site build was run.
