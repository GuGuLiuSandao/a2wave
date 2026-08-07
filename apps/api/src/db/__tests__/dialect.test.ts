import { describe, expect, it } from 'vitest'
import { isPostgresUrl, resolveDialect } from '../dialect.js'

describe('isPostgresUrl', () => {
  it('recognises the postgres:// scheme', async () => {
    expect(isPostgresUrl('postgres://user:pw@localhost:5432/a2wave')).toBe(true)
  })

  it('recognises the postgresql:// scheme', async () => {
    expect(isPostgresUrl('postgresql://user:pw@localhost:5432/a2wave')).toBe(true)
  })

  it('is case-insensitive on the scheme', async () => {
    expect(isPostgresUrl('POSTGRES://user@host/db')).toBe(true)
    expect(isPostgresUrl('PostgreSQL://user@host/db')).toBe(true)
  })

  it('tolerates surrounding whitespace from .env files', async () => {
    expect(isPostgresUrl('  postgres://user@host/db  ')).toBe(true)
  })

  it('treats a bare filesystem path as not-postgres', async () => {
    expect(isPostgresUrl('./data/a2wave.db')).toBe(false)
    expect(isPostgresUrl('/app/data/a2wave.db')).toBe(false)
  })

  it('does not match a path that merely contains the word postgres', async () => {
    expect(isPostgresUrl('./data/postgres-backup.db')).toBe(false)
  })

  it('does not match the sqlite file: scheme', async () => {
    expect(isPostgresUrl('file:./data/a2wave.db')).toBe(false)
  })
})

describe('resolveDialect', () => {
  it('defaults to sqlite so an unset DATABASE_URL keeps the zero-dependency path', async () => {
    expect(resolveDialect(undefined)).toBe('sqlite')
    expect(resolveDialect('')).toBe('sqlite')
  })

  it('selects postgres for a postgres connection string', async () => {
    expect(resolveDialect('postgres://user@host/db')).toBe('postgres')
  })

  it('selects sqlite for a file path', async () => {
    expect(resolveDialect('./data/a2wave.db')).toBe('sqlite')
  })
})
