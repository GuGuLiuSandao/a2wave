import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { describe, expect, it } from 'vitest'
import { getCurrentUserId, getOwnerFilter } from '../owner-filter.js'

function mockCtx(values: Record<string, unknown>): Context {
  return {
    get: (key: string) => values[key],
  } as unknown as Context
}

const fakeColumn = { name: 'user_id' } as never

describe('getOwnerFilter', () => {
  it('returns undefined for admin (no filter applied)', async () => {
    const ctx = mockCtx({ userRole: 'admin', userId: 'u1' })
    expect(getOwnerFilter(ctx, fakeColumn)).toBeUndefined()
  })

  it('returns eq() filter for non-admin user', async () => {
    const ctx = mockCtx({ userRole: 'user', userId: 'usr_42' })
    const expected = eq(fakeColumn, 'usr_42')
    expect(getOwnerFilter(ctx, fakeColumn)).toStrictEqual(expected)
  })

  it('treats missing role as non-admin', async () => {
    const ctx = mockCtx({ userId: 'usr_42' })
    expect(getOwnerFilter(ctx, fakeColumn)).not.toBeUndefined()
  })
})

describe('getCurrentUserId', () => {
  it('returns the userId from the context', async () => {
    const ctx = mockCtx({ userId: 'usr_999' })
    expect(getCurrentUserId(ctx)).toBe('usr_999')
  })
})
