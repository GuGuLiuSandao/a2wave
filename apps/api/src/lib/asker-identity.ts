/**
 * Who counts as an "asker", as one SQL expression.
 *
 * The Agent overview page reports asker numbers in three places — the headline
 * count, the Top Askers list, and the trend chart. They must agree: an agent
 * used only through the debug drawer once showed askers in the chart while the
 * count below it read 0 and Top Askers was empty.
 *
 * The rule, and why each half exists:
 *
 * - **Display name first.** External channels (Feishu and friends) carry
 *   `trigger_user_name` but have no local user row, so `user_id` is NULL there.
 * - **`user_id` only for human surfaces.** The first-party debug and chat_app
 *   pages are signed in but never denormalize the name, storing `user_id` with
 *   a NULL `trigger_user_name` — so the name alone reports zero for entire
 *   channels. But `user_id` is not always a caller: schedule stamps it with the
 *   agent owner purely so the run appears in that person's list. Counting that
 *   would draw a permanent flat line of one asker under a cron-only agent,
 *   contradicting the copy that promises scheduled runs are excluded. Schedule
 *   still counts when it carries a real display name, which it only does when
 *   configured to run as a named owner.
 *
 * The `n:` / `u:` prefixes stop a user_id from colliding with a display name
 * that happens to equal it. Rows with neither identity contribute nothing.
 *
 * The rule is asserted against real SQLite in `__tests__/asker-count.test.ts`;
 * the route tests mock the DB and can only check that a number is plumbed
 * through, not that the counting rule is right.
 */
import { sql } from 'drizzle-orm'
import { runs } from '../db/schema.js'

/** Channels where `user_id` identifies the person who asked, not a stand-in. */
export const HUMAN_TRIGGER_SOURCES = ['debug', 'chat_app', 'oauth'] as const

/**
 * A per-row asker key, or NULL when the row identifies nobody.
 * Wrap in `COUNT(DISTINCT …)` to get an asker count.
 *
 * Built lazily rather than at module scope: several route tests mock
 * `db/schema`, so touching `runs.*` on import would throw before any test runs.
 */
export function askerIdentityExpr() {
  return sql`CASE
    WHEN ${runs.triggerUserName} IS NOT NULL THEN 'n:' || ${runs.triggerUserName}
    WHEN ${runs.userId} IS NOT NULL
         AND ${runs.triggerSource} IN ('debug', 'chat_app', 'oauth')
      THEN 'u:' || ${runs.userId}
    ELSE NULL END`
}

/** Distinct askers over the selected rows. */
export function askerCountExpr() {
  return sql<number>`COUNT(DISTINCT ${askerIdentityExpr()})`
}
