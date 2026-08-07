import Database from 'better-sqlite3'
import type { Context } from 'hono'
import { describe, expect, it } from 'vitest'
import { skills } from '../../db/schema.js'
import {
  canAgentOwnerUseSkill,
  canNonAdminUseSkill,
  getSkillVisibilityFilter,
} from '../skill-access.js'

function mockCtx(values: Record<string, unknown>): Context {
  return {
    get: (key: string) => values[key],
  } as unknown as Context
}

describe('canNonAdminUseSkill', () => {
  it('allows the owner to use a private Skill', () => {
    expect(canNonAdminUseSkill({ visibility: 'private', userId: 'usr_owner' }, 'usr_owner')).toBe(
      true,
    )
  })

  it('rejects another user from a private Skill', () => {
    expect(canNonAdminUseSkill({ visibility: 'private', userId: 'usr_owner' }, 'usr_other')).toBe(
      false,
    )
  })

  it('allows every signed-in user to use an all-users Skill', () => {
    expect(canNonAdminUseSkill({ visibility: 'all-users', userId: 'usr_admin' }, 'usr_other')).toBe(
      true,
    )
  })

  it('does not treat a system-owned private row as public', () => {
    expect(canNonAdminUseSkill({ visibility: 'private', userId: null }, 'usr_other')).toBe(false)
  })

  it('allows a system-owned row only when its persisted visibility is all-users', () => {
    expect(canNonAdminUseSkill({ visibility: 'all-users', userId: null }, 'usr_other')).toBe(true)
  })
})

describe('canAgentOwnerUseSkill', () => {
  it('matches runtime owner semantics for private, shared, and active-admin access', () => {
    const privateSkill = { visibility: 'private' as const, userId: 'usr_editor' }
    const sharedSkill = { visibility: 'all-users' as const, userId: 'usr_admin' }

    expect(canAgentOwnerUseSkill(privateSkill, 'usr_owner', false)).toBe(false)
    expect(canAgentOwnerUseSkill(privateSkill, 'usr_editor', false)).toBe(true)
    expect(canAgentOwnerUseSkill(sharedSkill, 'usr_owner', false)).toBe(true)
    expect(canAgentOwnerUseSkill(privateSkill, 'usr_owner', true)).toBe(true)
  })
})

describe('getSkillVisibilityFilter', () => {
  async function visibleSkillIds(values: Record<string, unknown>): Promise<string[]> {
    const { SQLiteSyncDialect } = await import('drizzle-orm/sqlite-core')
    const sqlite = new Database(':memory:')
    try {
      sqlite.exec(`
        CREATE TABLE skills (id TEXT PRIMARY KEY, user_id TEXT, visibility TEXT NOT NULL);
        INSERT INTO skills VALUES
          ('skl_owned_private', 'usr_alice', 'private'),
          ('skl_foreign_private', 'usr_bob', 'private'),
          ('skl_shared', 'usr_admin', 'all-users'),
          ('skl_system_shared', NULL, 'all-users'),
          ('skl_system_private', NULL, 'private');
      `)

      const filter = getSkillVisibilityFilter(mockCtx(values), skills.userId, skills.visibility)
      if (!filter) {
        return sqlite
          .prepare('SELECT id FROM skills ORDER BY id')
          .all()
          .map((row) => (row as { id: string }).id)
      }

      const query = new SQLiteSyncDialect().sqlToQuery(filter)
      return sqlite
        .prepare(`SELECT id FROM skills WHERE ${query.sql} ORDER BY id`)
        .all(...(query.params as string[]))
        .map((row) => (row as { id: string }).id)
    } finally {
      sqlite.close()
    }
  }

  it('lets an admin see every Skill row', async () => {
    await expect(visibleSkillIds({ userRole: 'admin', userId: 'usr_admin' })).resolves.toEqual([
      'skl_foreign_private',
      'skl_owned_private',
      'skl_shared',
      'skl_system_private',
      'skl_system_shared',
    ])
  })

  it('lets a non-admin see owned private and all-users Skills only', async () => {
    await expect(visibleSkillIds({ userRole: 'user', userId: 'usr_alice' })).resolves.toEqual([
      'skl_owned_private',
      'skl_shared',
      'skl_system_shared',
    ])
  })

  it('fails closed to all-users rows when the authenticated user id is absent', async () => {
    await expect(visibleSkillIds({ userRole: 'user' })).resolves.toEqual([
      'skl_shared',
      'skl_system_shared',
    ])
  })
})
