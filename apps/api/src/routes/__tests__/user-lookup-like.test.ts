import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'
import { escapeLikePattern, likeWithEscape } from '../user-lookup.js'

/**
 * User search runs against a **real** SQLite here rather than a mocked chain,
 * because the property under test is a dialect semantic the mock cannot express:
 * SQLite's `LIKE` is case-insensitive for ASCII by default, while PostgreSQL's
 * is case-sensitive. Typing "alice" must keep finding "Alice" on both backends,
 * so the helper has to normalise case itself instead of inheriting SQLite's.
 */
const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull(),
  displayName: text('display_name'),
})

function makeDb(rows: Array<{ id: string; username: string; displayName?: string }>) {
  const sqlite = new Database(':memory:')
  sqlite.exec('CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, display_name TEXT)')
  const ins = sqlite.prepare('INSERT INTO users (id, username, display_name) VALUES (?, ?, ?)')
  for (const r of rows) ins.run(r.id, r.username, r.displayName ?? null)
  return drizzle(sqlite, { schema: { users } })
}

function search(
  rows: Array<{ id: string; username: string; displayName?: string }>,
  query: string,
): string[] {
  const db = makeDb(rows)
  const pattern = `%${escapeLikePattern(query)}%`
  return db
    .select({ id: users.id })
    .from(users)
    .where(likeWithEscape(users.username, pattern))
    .all()
    .map((r) => r.id)
}

describe('user search LIKE semantics', () => {
  const ROWS = [
    { id: 'u1', username: 'Alice' },
    { id: 'u2', username: 'bob' },
    { id: 'u3', username: 'CAROL' },
  ]

  it('finds a capitalised name from a lowercase query', async () => {
    expect(search(ROWS, 'alice')).toEqual(['u1'])
  })

  it('finds an uppercase name from a lowercase query', async () => {
    expect(search(ROWS, 'carol')).toEqual(['u3'])
  })

  it('finds a lowercase name from an uppercase query', async () => {
    expect(search(ROWS, 'BOB')).toEqual(['u2'])
  })

  it('matches on a substring, not only a prefix', async () => {
    expect(search(ROWS, 'LIC')).toEqual(['u1'])
  })

  it('still treats % as a literal, not a wildcard', async () => {
    const rows = [
      { id: 'u1', username: 'a%b' },
      { id: 'u2', username: 'axxb' },
    ]
    expect(search(rows, 'a%b')).toEqual(['u1'])
  })

  it('still treats _ as a literal, not a single-char wildcard', async () => {
    const rows = [
      { id: 'u1', username: 'a_b' },
      { id: 'u2', username: 'axb' },
    ]
    expect(search(rows, 'a_b')).toEqual(['u1'])
  })

  it('still treats the escape character itself literally', async () => {
    const rows = [
      { id: 'u1', username: 'a!b' },
      { id: 'u2', username: 'ab' },
    ]
    expect(search(rows, 'a!b')).toEqual(['u1'])
  })
})
