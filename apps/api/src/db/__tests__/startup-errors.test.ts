import { describe, expect, it } from 'vitest'
import { describeDbStartupError } from '../startup-errors.js'

const DB_PATH = '/repo/apps/api/data/a2wave.db'

describe('describeDbStartupError', () => {
  it('maps the missing better-sqlite3 bindings error to a rebuild hint', async () => {
    const err = new Error(
      'Could not locate the bindings file. Tried:\n → /x/build/better_sqlite3.node',
    )
    const msg = describeDbStartupError(err, DB_PATH)
    expect(msg).toContain('better-sqlite3 native addon is missing')
    expect(msg).toContain('pnpm install')
    // The unreadable path list must not leak through.
    expect(msg).not.toContain('Tried:')
  })

  it('maps SQLITE_CANTOPEN to a path/permission hint including the resolved path', async () => {
    const err = Object.assign(new Error('unable to open database file'), {
      code: 'SQLITE_CANTOPEN',
    })
    const msg = describeDbStartupError(err, DB_PATH)
    expect(msg).toContain(DB_PATH)
    expect(msg).toContain('writable')
  })

  it('maps SQLITE_NOTADB (corrupt file) to a restore/delete hint', async () => {
    const err = Object.assign(new Error('file is not a database'), {
      code: 'SQLITE_NOTADB',
    })
    const msg = describeDbStartupError(err, DB_PATH)
    expect(msg).toContain(DB_PATH)
    expect(msg).toMatch(/restore|delete/i)
  })

  it('maps EACCES/EPERM (typical Docker volume ownership) to a permissions hint', async () => {
    for (const code of ['EACCES', 'EPERM']) {
      const err = Object.assign(new Error('permission denied'), { code })
      const msg = describeDbStartupError(err, DB_PATH)
      expect(msg).toContain(DB_PATH)
      expect(msg).toMatch(/permission|ownership/i)
    }
  })

  it('returns null for unrelated errors so they propagate untouched', async () => {
    expect(describeDbStartupError(new Error('boom'), DB_PATH)).toBeNull()
  })

  // A misconfigured PostgreSQL connection is the most likely first-run failure
  // for an operator opting into the new backend. Without translation these
  // surface as a bare driver stack that never names DATABASE_URL.
  describe('postgres', () => {
    const PG_URL = 'postgres://a2wave@db.internal:5432/a2wave'

    it('maps ECONNREFUSED to a server-reachability hint', async () => {
      const err = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), {
        code: 'ECONNREFUSED',
      })
      const msg = describeDbStartupError(err, PG_URL)
      expect(msg).toMatch(/not accepting connections|refused/i)
      expect(msg).toContain('DATABASE_URL')
    })

    it('maps ENOTFOUND to a hostname hint', async () => {
      const err = Object.assign(new Error('getaddrinfo ENOTFOUND db.internal'), {
        code: 'ENOTFOUND',
      })
      const msg = describeDbStartupError(err, PG_URL)
      expect(msg).toMatch(/host|resolve/i)
    })

    it('maps SQLSTATE 28P01 to an authentication hint', async () => {
      const err = Object.assign(new Error('password authentication failed'), { code: '28P01' })
      const msg = describeDbStartupError(err, PG_URL)
      expect(msg).toMatch(/authentication|password/i)
    })

    it('maps SQLSTATE 3D000 to a missing-database hint that names createdb', async () => {
      const err = Object.assign(new Error('database "a2wave" does not exist'), { code: '3D000' })
      const msg = describeDbStartupError(err, PG_URL)
      expect(msg).toMatch(/does not exist/i)
      expect(msg).toContain('createdb')
    })

    it('maps SQLSTATE 53300 to a connection-limit hint', async () => {
      const err = Object.assign(new Error('too many clients already'), { code: '53300' })
      const msg = describeDbStartupError(err, PG_URL)
      expect(msg).toMatch(/too many|connection limit|max_connections/i)
    })

    it('never echoes the connection string, which carries the password', async () => {
      const secret = 'postgres://a2wave:hunter2@db.internal:5432/a2wave'
      for (const code of ['ECONNREFUSED', 'ENOTFOUND', '28P01', '3D000', '53300']) {
        const msg = describeDbStartupError(Object.assign(new Error('x'), { code }), secret)
        expect(msg).not.toContain('hunter2')
      }
    })
  })

  it('returns null for non-Error inputs', async () => {
    expect(describeDbStartupError('string error', DB_PATH)).toBeNull()
    expect(describeDbStartupError(undefined, DB_PATH)).toBeNull()
    expect(describeDbStartupError({ code: 'SQLITE_CANTOPEN' }, DB_PATH)).toBeNull()
  })
})
