import { describe, expect, it } from 'vitest'
import { extractVersionToken, isVersionAtLeast } from '../version-utils.js'

describe('extractVersionToken', () => {
  it('extracts a plain semver', () => {
    expect(extractVersionToken('1.0.48')).toBe('1.0.48')
  })

  it('extracts from prefixed CLI output', () => {
    expect(extractVersionToken('trae-cli version 0.120.42\nbuild date: x')).toBe('0.120.42')
  })

  it('extracts from suffixed CLI output', () => {
    expect(extractVersionToken('2.1.212 (Claude Code)')).toBe('2.1.212')
  })

  it('extracts date-style versions (cursor-agent)', () => {
    expect(extractVersionToken('2026.03.30-a5d3e17')).toBe('2026.03.30')
  })

  it('returns null when no version token present', () => {
    expect(extractVersionToken('not logged in')).toBeNull()
    expect(extractVersionToken('')).toBeNull()
    // A bare single number in unrelated output is NOT a version (exit code / count)
    expect(extractVersionToken('exit 137')).toBeNull()
    expect(extractVersionToken('42')).toBeNull()
  })

  it('accepts a single-segment major only when clearly a version', () => {
    // v-prefixed or preceded by the word "version"
    expect(extractVersionToken('v2')).toBe('2')
    expect(extractVersionToken('mycli version 2')).toBe('2')
    expect(extractVersionToken('trae-cli version v3 (build x)')).toBe('3')
    // a multi-segment token anywhere takes precedence over a single-segment one
    expect(extractVersionToken('v2 core, engine 1.4.0')).toBe('1.4.0')
  })
})

describe('isVersionAtLeast', () => {
  it('compares numeric segments (not lexicographic)', () => {
    expect(isVersionAtLeast('1.0.48', '1.0.0')).toBe(true)
    expect(isVersionAtLeast('0.2.8', '1.0.0')).toBe(false)
    expect(isVersionAtLeast('0.120.42', '0.120.0')).toBe(true)
    expect(isVersionAtLeast('0.99.0', '0.120.0')).toBe(false)
  })

  it('treats missing segments as zero', () => {
    expect(isVersionAtLeast('1.0', '1.0.0')).toBe(true)
    expect(isVersionAtLeast('1.0.0', '1.0')).toBe(true)
    expect(isVersionAtLeast('1.0', '1.0.1')).toBe(false)
  })

  it('accepts equal versions', () => {
    expect(isVersionAtLeast('1.2.3', '1.2.3')).toBe(true)
  })

  it('tolerates prefixed/suffixed raw output on either side', () => {
    expect(isVersionAtLeast('trae-cli version 0.120.42', '0.120.0')).toBe(true)
    expect(isVersionAtLeast('2.1.212 (Claude Code)', '1.0.0')).toBe(true)
  })

  it('returns null when either side is unparsable', () => {
    expect(isVersionAtLeast('unknown', '1.0.0')).toBeNull()
    expect(isVersionAtLeast('1.0.0', '')).toBeNull()
  })

  it('gates correctly on a single-segment CLI version (no longer silently skipped)', () => {
    // A CLI reporting `v2` against a `1.0.0` floor must pass the gate, not skip it
    expect(isVersionAtLeast('v2', '1.0.0')).toBe(true)
    expect(isVersionAtLeast('mycli version 1', '2.0.0')).toBe(false)
  })
})
