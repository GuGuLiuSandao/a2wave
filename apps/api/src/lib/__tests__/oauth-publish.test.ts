import { describe, expect, it } from 'vitest'
import { isOauthAllowlistMissing, resolveOauthAllowedEmailsUpdate } from '../oauth-publish.js'

describe('resolveOauthAllowedEmailsUpdate', () => {
  it('writes the submitted list under specified_users', () => {
    expect(resolveOauthAllowedEmailsUpdate('specified_users', ['a@b.co'])).toEqual(['a@b.co'])
  })

  it('leaves the stored list untouched when the client sends nothing', () => {
    expect(resolveOauthAllowedEmailsUpdate('specified_users', undefined)).toBeUndefined()
  })

  /**
   * Nulled, not merely skipped. A stale list left behind would silently re-restrict the Agent
   * the moment someone switched the mode back — using addresses nobody had reviewed since.
   */
  it('nulls the column under all_idaas_users, even when a list is submitted', () => {
    expect(resolveOauthAllowedEmailsUpdate('all_idaas_users', ['a@b.co'])).toBeNull()
    expect(resolveOauthAllowedEmailsUpdate('all_idaas_users', undefined)).toBeNull()
  })
})

describe('isOauthAllowlistMissing', () => {
  const base = { channels: ['api', 'oauth'], mode: 'specified_users' as const }

  it('flags an explicitly empty list', () => {
    expect(isOauthAllowlistMissing({ ...base, update: [], stored: null })).toBe(true)
  })

  // The migrated-Agent case: nothing submitted and nothing stored.
  it('flags an omitted list with nothing stored', () => {
    expect(isOauthAllowlistMissing({ ...base, update: undefined, stored: null })).toBe(true)
  })

  it('passes when the stored list carries the addresses', () => {
    expect(isOauthAllowlistMissing({ ...base, update: undefined, stored: ['a@b.co'] })).toBe(false)
  })

  // An explicit empty list must not be rescued by what happens to be stored.
  it('flags an emptied list even when addresses are stored', () => {
    expect(isOauthAllowlistMissing({ ...base, update: [], stored: ['a@b.co'] })).toBe(true)
  })

  it('ignores agents that do not publish the oauth channel', () => {
    expect(isOauthAllowlistMissing({ ...base, channels: ['api'], update: [], stored: null })).toBe(
      false,
    )
  })

  it('ignores the open access mode', () => {
    expect(
      isOauthAllowlistMissing({ ...base, mode: 'all_idaas_users', update: null, stored: null }),
    ).toBe(false)
  })
})
