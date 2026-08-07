import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn() },
}))

vi.mock('../../db/schema.js', () => ({
  users: {
    isActive: 'is_active',
    email: 'email',
    idaasSub: 'idaas_sub',
    idaasIssuer: 'idaas_issuer',
  },
}))

import { db } from '../../db/client.js'
import { isSsoAccountDisabled } from '../user-status.js'

import { asyncQuery } from '../../test/async-query.js'

/** Queue up the rows returned by successive db.select().from().where().get() calls. */
function selectSequence(...rows: unknown[]) {
  const chain = (value: unknown) => ({
    from: () => ({ where: () => asyncQuery({ get: () => value }) }),
  })
  const mock = db.select as Mock
  for (const row of rows) mock.mockReturnValueOnce(chain(row))
}

const IDENTITY = {
  issuer: 'https://idaas.example.test/',
  sub: 'sub-1',
  email: 'alice@example.com',
}

describe('isSsoAccountDisabled', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reports a disabled account matched by (issuer, sub)', async () => {
    selectSequence({ isActive: false })
    expect(await isSsoAccountDisabled(IDENTITY)).toBe(true)
  })

  it('reports an active account matched by (issuer, sub) as enabled', async () => {
    selectSequence({ isActive: true })
    expect(await isSsoAccountDisabled(IDENTITY)).toBe(false)
    // Identity hit short-circuits — no email fallback query.
    expect(db.select).toHaveBeenCalledTimes(1)
  })

  it('falls back to email for an SSO account whose sub differs but email matches', async () => {
    selectSequence(undefined, undefined, { isActive: false, idaasSub: 'other-sub' })
    expect(await isSsoAccountDisabled(IDENTITY)).toBe(true)
  })

  it('ignores a local password account that merely shares the email', async () => {
    // idaasSub null = local account, a different principal; must not be matched.
    selectSequence(undefined, undefined, { isActive: false, idaasSub: null })
    expect(await isSsoAccountDisabled(IDENTITY)).toBe(false)
  })

  it('treats an unprovisioned external IdP user as not disabled', async () => {
    selectSequence(undefined, undefined, undefined)
    expect(await isSsoAccountDisabled(IDENTITY)).toBe(false)
  })

  it('catches a legacy NULL-issuer account when the token carries no email', async () => {
    // Accounts provisioned before idaas_issuer was recorded have issuer NULL, and in
    // SQLite NULL never equals anything — so the (issuer, sub) predicate misses them.
    // With no email claim there is no fallback either, which left a disabled legacy
    // account able to keep invoking Agents in all_idaas_users mode.
    selectSequence(undefined, { isActive: false })
    expect(await isSsoAccountDisabled({ issuer: IDENTITY.issuer, sub: IDENTITY.sub })).toBe(true)
  })

  it('treats an active legacy NULL-issuer account as enabled', async () => {
    selectSequence(undefined, { isActive: true })
    expect(await isSsoAccountDisabled({ issuer: IDENTITY.issuer, sub: IDENTITY.sub })).toBe(false)
  })

  it('does not fall back to a bare sub match when the issuer is bound and differs', async () => {
    // A different IdP's identically-named subject is a different person; the sub-only
    // fallback must be restricted to rows whose issuer was never recorded.
    selectSequence(undefined, undefined, undefined)
    expect(await isSsoAccountDisabled({ issuer: 'https://other.example/', sub: 'sub-1' })).toBe(
      false,
    )
  })
})
