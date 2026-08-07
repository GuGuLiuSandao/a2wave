import { type SQL, and, asc, eq, or, sql } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import { Hono } from 'hono'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'

const app = new Hono()

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 20
const MIN_LIMIT = 1

/**
 * SQLite LIKE has NO escape behavior unless `ESCAPE '<char>'` is supplied.
 * We use `!` as escape (no JS quoting headache, no SQL string quoting issue),
 * and pair every LIKE site with the matching ESCAPE clause via raw `sql`
 * (drizzle's high-level `like()` helper does not emit ESCAPE).
 */
const ESCAPE_CHAR = '!'

export function escapeLikePattern(input: string): string {
  return input.replace(/!/g, '!!').replace(/%/g, '!%').replace(/_/g, '!_')
}

/**
 * Drizzle SQL fragment: a **case-insensitive** `LIKE` with an explicit ESCAPE.
 *
 * Case handling is done here rather than left to the database, because the two
 * backends disagree: SQLite's `LIKE` folds ASCII case by default, PostgreSQL's
 * does not. Inheriting that default would mean searching "alice" silently stops
 * finding "Alice" the moment a deployment moves to PostgreSQL — a behaviour
 * change with no error to notice.
 *
 * `lower()` on both sides is used instead of PostgreSQL's `ILIKE` so a single
 * expression covers both dialects. The escape clause stays: `%`, `_` and the
 * escape character itself must keep matching literally, since a username may
 * legitimately contain them.
 */
export function likeWithEscape(col: SQLiteColumn, pattern: string): SQL {
  return sql`lower(${col}) LIKE lower(${pattern}) ESCAPE ${ESCAPE_CHAR}`
}

/**
 * GET /user-lookup?q=<keyword>&limit=<n>
 *
 * Authenticated (NOT admin-only) endpoint for picking users as collaborators
 * by username / displayName / email. Returns only minimal public fields —
 * never role, idaasSub, passwordHash, or other sensitive columns.
 */
app.get('/', async (c) => {
  const q = (c.req.query('q') ?? '').trim()
  if (q.length < 1) {
    return c.json({ error: 'Query parameter "q" is required' }, 400)
  }

  const rawLimit = Number.parseInt(c.req.query('limit') ?? '', 10)
  const limit = Number.isFinite(rawLimit)
    ? Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, rawLimit))
    : DEFAULT_LIMIT

  const pattern = `%${escapeLikePattern(q)}%`

  const data = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      email: users.email,
    })
    .from(users)
    .where(
      and(
        eq(users.isActive, true),
        or(
          likeWithEscape(users.username, pattern),
          likeWithEscape(users.displayName, pattern),
          likeWithEscape(users.email, pattern),
        ),
      ),
    )
    .orderBy(asc(users.username))
    .limit(limit)

  return c.json({ data })
})

export default app
