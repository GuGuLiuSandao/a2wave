import { describe, expect, it } from 'vitest'
import { idSuffix } from '../id-suffix'

describe('idSuffix', () => {
  it('strips the prefix before the first underscore', () => {
    expect(idSuffix('scm_abc123')).toBe('abc123')
  })

  it('preserves underscores in the random suffix (no split/pop collision)', () => {
    // base64url 允许 '_'，后缀可以含多个下划线
    expect(idSuffix('scm_ABC_XYZ')).toBe('ABC_XYZ')
    expect(idSuffix('scm_DEF_XYZ')).toBe('DEF_XYZ')
  })

  it('returns empty string for null/undefined/empty', () => {
    expect(idSuffix(null)).toBe('')
    expect(idSuffix(undefined)).toBe('')
    expect(idSuffix('')).toBe('')
  })

  it('returns the full id when no underscore', () => {
    expect(idSuffix('plainid')).toBe('plainid')
  })
})
