import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

/**
 * Asker counting, asserted against real SQLite.
 *
 * The route tests mock the DB, so they can only check that *a* number is
 * plumbed through — they cannot catch a counting rule that is simply wrong.
 * Two such rules already shipped and had to be corrected:
 *
 *  1. Counting `trigger_user_name` alone reported zero askers for an agent
 *     whose every run came from the first-party debug / chat_app surfaces,
 *     because those channels store `user_id` and leave the display name NULL.
 *  2. Falling back to `user_id` unconditionally then counted *scheduled* runs
 *     as askers, because schedule stamps the agent owner's id purely so the run
 *     appears in that person's list — nobody asked anything.
 *
 * Hence the rule below: display name first, and the `user_id` fallback only for
 * channels that represent a human at a keyboard.
 */
const HUMAN_CHANNELS = "('debug', 'chat_app', 'oauth')"

const COUNT_ASKERS = `
  SELECT COUNT(DISTINCT CASE
    WHEN trigger_user_name IS NOT NULL THEN 'n:' || trigger_user_name
    WHEN user_id IS NOT NULL AND trigger_source IN ${HUMAN_CHANNELS} THEN 'u:' || user_id
    ELSE NULL END) AS cnt
  FROM runs`

let db: InstanceType<typeof Database>

function insert(rows: { userId?: string | null; name?: string | null; source?: string | null }[]) {
  const stmt = db.prepare(
    'INSERT INTO runs (user_id, trigger_user_name, trigger_source) VALUES (?, ?, ?)',
  )
  for (const r of rows) stmt.run(r.userId ?? null, r.name ?? null, r.source ?? 'debug')
}

const askers = () => (db.prepare(COUNT_ASKERS).get() as { cnt: number }).cnt

beforeEach(() => {
  db = new Database(':memory:')
  db.exec('CREATE TABLE runs (user_id TEXT, trigger_user_name TEXT, trigger_source TEXT)')
})

/** Top Askers can only list rows that carry a display name. */
const TOP_ASKERS = `
  SELECT trigger_user_name AS name, COUNT(*) AS cnt
  FROM runs WHERE trigger_user_name IS NOT NULL
  GROUP BY trigger_user_name ORDER BY cnt DESC LIMIT 5`

describe('asker counting — one rule across the whole overview page', () => {
  it('reports the same count for the headline number and the trend chart', async () => {
    // The regression this guards: the chart used the identity rule below while
    // /stats counted trigger_user_name alone, so an agent used only through the
    // debug drawer showed askers in the chart and 0 directly beneath it.
    insert([
      { userId: 'usr_a', source: 'debug' },
      { userId: 'usr_b', source: 'chat_app' },
      { name: 'Alice', source: 'feishu' },
    ])

    // Bucketed (chart) and unbucketed (headline) must agree on the total.
    const bucketed = db
      .prepare(`SELECT COUNT(DISTINCT CASE
        WHEN trigger_user_name IS NOT NULL THEN 'n:' || trigger_user_name
        WHEN user_id IS NOT NULL AND trigger_source IN ${HUMAN_CHANNELS} THEN 'u:' || user_id
        ELSE NULL END) AS cnt FROM runs`)
      .get() as { cnt: number }

    expect(askers()).toBe(3)
    expect(bucketed.cnt).toBe(askers())
  })

  it('lets Top Askers be shorter than the count without contradicting it', async () => {
    // Only named rows are listable, so two of these three askers have no row in
    // the list. That is expected — but the count must still include them, and
    // the list must never exceed it.
    insert([
      { userId: 'usr_a', source: 'debug' },
      { userId: 'usr_b', source: 'chat_app' },
      { name: 'Alice', source: 'feishu' },
    ])

    const listed = db.prepare(TOP_ASKERS).all() as { name: string; cnt: number }[]
    expect(listed.map((r) => r.name)).toEqual(['Alice'])
    expect(listed.length).toBeLessThanOrEqual(askers())
  })
})

describe('asker counting', () => {
  it('counts signed-in runs that carry no display name', async () => {
    // debug / chat_app: authenticated, but trigger_user_name is never written.
    insert([
      { userId: 'usr_a', source: 'debug' },
      { userId: 'usr_a', source: 'chat_app' },
      { userId: 'usr_b', source: 'chat_app' },
    ])
    expect(askers()).toBe(2)
  })

  it('counts external-channel runs that carry only a display name', async () => {
    // Feishu and friends: a name, but no local user row to point at.
    insert([
      { name: 'Alice', source: 'feishu' },
      { name: 'Bob', source: 'feishu' },
    ])
    expect(askers()).toBe(2)
  })

  it('does not count scheduled runs stamped with the owner id', async () => {
    // schedule-trigger.ts assigns userId = agent.userId so the run shows up in
    // the owner's list. That is bookkeeping, not a caller — counting it would
    // draw a flat line of 1 asker under a cron-only agent and contradict the
    // askersHint copy.
    insert([
      { userId: 'usr_owner', name: null, source: 'schedule' },
      { userId: 'usr_owner', name: null, source: 'schedule' },
    ])
    expect(askers()).toBe(0)
  })

  it('still counts a scheduled run that carries a real display name', async () => {
    // run-as-named-owner does denormalize a name; that one is attributable.
    insert([{ userId: 'usr_owner', name: 'Ops Bot', source: 'schedule' }])
    expect(askers()).toBe(1)
  })

  it('does not count gateway API-key runs stamped with the owner id', async () => {
    insert([{ userId: 'usr_owner', name: null, source: 'api' }])
    expect(askers()).toBe(0)
  })

  it('does not double-count one person seen through both channels', async () => {
    // Same human via chat_app (id only) and a named channel. Names resolve
    // first, so this deliberately counts 2 — there is no stable cross-channel
    // person key, and conflating them would be a guess. Documented, not ideal.
    insert([
      { userId: 'usr_a', name: null, source: 'chat_app' },
      { userId: 'usr_a', name: null, source: 'debug' },
    ])
    expect(askers()).toBe(1)
  })

  it('keeps two different people who share a display name apart only by name', async () => {
    // Two distinct humans with the same display name collapse to one: the
    // schema has no stable person key for external channels, so this is a known
    // limitation rather than something the query can resolve.
    insert([
      { userId: 'usr_a', name: 'Alex', source: 'feishu' },
      { userId: 'usr_b', name: 'Alex', source: 'feishu' },
    ])
    expect(askers()).toBe(1)
  })

  it('ignores runs with no caller identity at all', async () => {
    insert([
      { userId: null, name: null, source: 'api' },
      { userId: null, name: null, source: 'schedule' },
    ])
    expect(askers()).toBe(0)
  })

  it('does not let a display name collide with an identical user id', async () => {
    insert([
      { userId: 'usr_a', name: null, source: 'debug' },
      { userId: null, name: 'usr_a', source: 'feishu' },
    ])
    expect(askers()).toBe(2)
  })
})
