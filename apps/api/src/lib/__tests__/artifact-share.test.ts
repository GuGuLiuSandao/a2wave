/**
 * Unit tests for lib/artifact-share.ts
 * 用真实 in-memory SQLite（drizzle）跑，验证过期/撤销/豁免的 SQL 语义。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db/client.js', async () => {
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const Database = (await import('better-sqlite3')).default
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE artifact_shares (
      id text PRIMARY KEY NOT NULL,
      artifact_id text NOT NULL,
      created_by text,
      access_level text NOT NULL,
      password_hash text,
      expires_at integer NOT NULL,
      revoked_at integer,
      view_count integer DEFAULT 0 NOT NULL,
      last_viewed_at integer,
      created_at integer
    );
  `)
  return { db: drizzle(sqlite) }
})

vi.mock('../auth.js', () => ({
  hashPassword: vi.fn(async (p: string) => `hashed:${p}`),
  verifyPassword: vi.fn(async (h: string, p: string) => h === `hashed:${p}`),
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { db } from '../../db/client.js'
import { artifactShares } from '../../db/schema.js'
import {
  createArtifactShare,
  deleteStaleShares,
  getActiveShare,
  hasActiveShare,
  listSharesForArtifact,
  recordShareView,
  revokeShare,
} from '../artifact-share.js'

beforeEach(() => {
  db.delete(artifactShares).run()
})

describe('createArtifactShare', () => {
  it('creates a public share with default expiry (7 days)', async () => {
    const share = await createArtifactShare({
      artifactId: 'art_1',
      createdBy: 'usr_1',
      accessLevel: 'public',
    })
    expect(share.id).toMatch(/^shr_/)
    expect(share.accessLevel).toBe('public')
    expect(share.passwordHash).toBeNull()
    const expectedMs = Date.now() + 7 * 24 * 60 * 60 * 1000
    expect(Math.abs(share.expiresAt.getTime() - expectedMs)).toBeLessThan(5000)
  })

  it('hashes password for password shares', async () => {
    const share = await createArtifactShare({
      artifactId: 'art_1',
      createdBy: 'usr_1',
      accessLevel: 'password',
      password: 'secret',
    })
    expect(share.passwordHash).toBe('hashed:secret')
  })

  it('rejects password share without password', async () => {
    await expect(
      createArtifactShare({
        artifactId: 'art_1',
        createdBy: 'usr_1',
        accessLevel: 'password',
      }),
    ).rejects.toThrow(/password/i)
  })

  it('rejects out-of-range expiryDays', async () => {
    await expect(
      createArtifactShare({
        artifactId: 'art_1',
        createdBy: 'usr_1',
        accessLevel: 'public',
        expiryDays: 9999,
      }),
    ).rejects.toThrow(/expiryDays/)
  })
})

describe('getActiveShare', () => {
  it('returns null for unknown id', async () => {
    expect(await getActiveShare('shr_nope')).toBeNull()
  })

  it('returns null for revoked share', async () => {
    const share = await createArtifactShare({
      artifactId: 'art_1',
      createdBy: 'usr_1',
      accessLevel: 'public',
    })
    await revokeShare(share.id)
    expect(await getActiveShare(share.id)).toBeNull()
  })

  it('returns null for expired share', async () => {
    const share = await createArtifactShare({
      artifactId: 'art_1',
      createdBy: 'usr_1',
      accessLevel: 'public',
    })
    db.update(artifactShares)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .run()
    expect(await getActiveShare(share.id)).toBeNull()
  })

  it('returns active share', async () => {
    const share = await createArtifactShare({
      artifactId: 'art_1',
      createdBy: 'usr_1',
      accessLevel: 'public',
    })
    expect((await getActiveShare(share.id))?.id).toBe(share.id)
  })
})

describe('hasActiveShare / deleteStaleShares', () => {
  it('reflects active share lifecycle', async () => {
    expect(await hasActiveShare('art_1')).toBe(false)
    const share = await createArtifactShare({
      artifactId: 'art_1',
      createdBy: 'usr_1',
      accessLevel: 'public',
    })
    expect(await hasActiveShare('art_1')).toBe(true)
    await revokeShare(share.id)
    expect(await hasActiveShare('art_1')).toBe(false)
  })

  it('deleteStaleShares removes expired and revoked rows, keeps active', async () => {
    const active = await createArtifactShare({
      artifactId: 'art_a',
      createdBy: 'usr_1',
      accessLevel: 'public',
    })
    const revoked = await createArtifactShare({
      artifactId: 'art_b',
      createdBy: 'usr_1',
      accessLevel: 'public',
    })
    await revokeShare(revoked.id)
    const expired = await createArtifactShare({
      artifactId: 'art_c',
      createdBy: 'usr_1',
      accessLevel: 'public',
    })
    db.update(artifactShares)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where((await import('drizzle-orm')).eq(artifactShares.id, expired.id))
      .run()

    await deleteStaleShares()

    const remaining = db.select().from(artifactShares).all()
    expect(remaining.map((r) => r.id)).toEqual([active.id])
  })
})

describe('recordShareView', () => {
  it('increments viewCount and sets lastViewedAt', async () => {
    const share = await createArtifactShare({
      artifactId: 'art_1',
      createdBy: 'usr_1',
      accessLevel: 'public',
    })
    expect(share.viewCount).toBe(0)
    await recordShareView(share.id)
    await recordShareView(share.id)
    const rows = await listSharesForArtifact('art_1')
    expect(rows[0].viewCount).toBe(2)
    expect(rows[0].lastViewedAt).not.toBeNull()
  })
})
