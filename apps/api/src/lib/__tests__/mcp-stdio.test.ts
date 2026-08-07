import { describe, expect, it } from 'vitest'
import { canNonAdminUseMcp, introducesStdioExecution, resolveUsageScope } from '../mcp-stdio.js'

const inlineStdioGroup = {
  backends: { default: [{ mode: 'inline' as const, type: 'stdio' as const, command: 'x' }] },
} as never
const refOnlyGroup = {
  backends: { default: [{ mode: 'ref' as const, mcpServerId: 'mcp_x' }] },
} as never

describe('introducesStdioExecution', () => {
  it('detects top-level stdio and inline-stdio groups', async () => {
    expect(introducesStdioExecution('stdio', null)).toBe(true)
    expect(introducesStdioExecution('group', inlineStdioGroup)).toBe(true)
  })

  it('is false for sse/http and ref-only groups', async () => {
    expect(introducesStdioExecution('sse', null)).toBe(false)
    expect(introducesStdioExecution('http', null)).toBe(false)
    expect(introducesStdioExecution('group', refOnlyGroup)).toBe(false)
  })
})

describe('resolveUsageScope', () => {
  it('FORCES admin-only for stdio-capable servers, ignoring the submitted scope', async () => {
    expect(
      resolveUsageScope({
        type: 'stdio',
        groupConfig: null,
        requested: 'all-users', // admin tried to widen it — must be ignored
        isAdmin: true,
        fallback: 'all-users',
      }),
    ).toBe('admin-only')
    expect(
      resolveUsageScope({
        type: 'group',
        groupConfig: inlineStdioGroup,
        requested: 'all-users',
        isAdmin: true,
        fallback: 'all-users',
      }),
    ).toBe('admin-only')
  })

  it('honors an admin-submitted scope for a non-stdio server', async () => {
    expect(
      resolveUsageScope({
        type: 'sse',
        groupConfig: null,
        requested: 'all-users',
        isAdmin: true,
        fallback: 'admin-only',
      }),
    ).toBe('all-users')
  })

  it('ignores a non-admin-submitted scope, using the fallback', async () => {
    expect(
      resolveUsageScope({
        type: 'sse',
        groupConfig: null,
        requested: 'all-users', // non-admin cannot widen
        isAdmin: false,
        fallback: 'admin-only',
      }),
    ).toBe('admin-only')
  })

  it('uses the fallback when no scope is submitted', async () => {
    expect(
      resolveUsageScope({
        type: 'http',
        groupConfig: null,
        requested: undefined,
        isAdmin: true,
        fallback: 'all-users',
      }),
    ).toBe('all-users')
  })

  it("a non-admin's non-stdio create uses the all-users fallback (self-service parity)", async () => {
    // Regression: the create path must pass fallback 'all-users' so a non-admin's
    // own sse/http/non-stdio-group server stays bindable by them — parity with the
    // old adminOnly=false default. A non-admin submits no scope (or one that's
    // ignored); the fallback decides.
    expect(
      resolveUsageScope({
        type: 'sse',
        groupConfig: null,
        requested: undefined,
        isAdmin: false,
        fallback: 'all-users',
      }),
    ).toBe('all-users')
    // A ref-only group (no inline stdio) is non-stdio → same self-service default.
    expect(
      resolveUsageScope({
        type: 'group',
        groupConfig: { backends: { default: [{ mode: 'ref', mcpServerId: 'mcp_x' }] } } as never,
        requested: undefined,
        isAdmin: false,
        fallback: 'all-users',
      }),
    ).toBe('all-users')
  })
})

describe('canNonAdminUseMcp (three-state, pure read)', () => {
  const base = { type: 'sse', groupConfig: null, userId: 'usr_me' }

  it("all-users is bindable by ANYONE (it's an explicit share, admin-set)", async () => {
    expect(canNonAdminUseMcp({ ...base, usageScope: 'all-users' }, 'usr_me')).toBe(true)
    expect(canNonAdminUseMcp({ ...base, usageScope: 'all-users' }, 'usr_other')).toBe(true)
    // even a builtin
    expect(canNonAdminUseMcp({ ...base, usageScope: 'all-users', userId: null }, 'usr_x')).toBe(
      true,
    )
  })

  it('private is bindable ONLY by its owner', async () => {
    expect(canNonAdminUseMcp({ ...base, usageScope: 'private' }, 'usr_me')).toBe(true)
    expect(canNonAdminUseMcp({ ...base, usageScope: 'private' }, 'usr_other')).toBe(false)
    // a private builtin (userId null) is nobody's own → not bindable by a non-admin
    expect(canNonAdminUseMcp({ ...base, usageScope: 'private', userId: null }, 'usr_me')).toBe(
      false,
    )
  })

  it('admin-only is NEVER bindable by a non-admin (incl. the owner)', async () => {
    expect(canNonAdminUseMcp({ ...base, usageScope: 'admin-only' }, 'usr_me')).toBe(false)
    expect(canNonAdminUseMcp({ ...base, usageScope: 'admin-only' }, 'usr_other')).toBe(false)
  })

  it('reads only the persisted scope + ownership — never the owner role', async () => {
    // Sharing does not depend on who owns it: an all-users row is usable whether
    // owned by an admin, a normal user, or nobody. (The three-state model makes
    // sharing an explicit persisted decision, so no role lookup is needed.)
    expect(
      canNonAdminUseMcp({ ...base, usageScope: 'all-users', userId: 'usr_alice' }, 'usr_me'),
    ).toBe(true)
  })
})
