import { describe, expect, it } from 'vitest'
import { slugify } from '../slug.js'

describe('slugify', () => {
  it('converts ASCII name to lowercase slug', async () => {
    expect(slugify('Hello World')).toBe('hello-world')
  })

  it('replaces multiple special characters with single hyphen', async () => {
    expect(slugify('foo---bar')).toBe('foo-bar')
    expect(slugify('a @ b # c')).toBe('a-b-c')
  })

  it('trims leading and trailing hyphens', async () => {
    expect(slugify('  hello  ')).toBe('hello')
    expect(slugify('---hello---')).toBe('hello')
  })

  it('handles alphanumeric names', async () => {
    expect(slugify('agent42')).toBe('agent42')
  })

  it('preserves CJK characters', async () => {
    const result = slugify('代码审查')
    expect(result).toBe('代码审查')
  })

  it('handles mixed CJK and ASCII', async () => {
    const result = slugify('Code 审查 Agent')
    expect(result).toBe('code-审查-agent')
  })

  it('preserves Japanese kana', async () => {
    expect(slugify('テスト')).toBe('テスト')
  })

  it('preserves Korean hangul', async () => {
    expect(slugify('에이전트')).toBe('에이전트')
  })

  it('falls back to hex hash for pure symbols', async () => {
    const result = slugify('!@#$%')
    expect(result).toMatch(/^id-[0-9a-f]+$/)
  })

  it('falls back to hex hash for empty string', async () => {
    const result = slugify('')
    expect(result).toMatch(/^id-[0-9a-f]+$/)
  })

  it('produces deterministic fallback hash', async () => {
    expect(slugify('!!!')).toBe(slugify('!!!'))
  })

  it('handles single character', async () => {
    expect(slugify('a')).toBe('a')
  })

  it('handles already slugified input', async () => {
    expect(slugify('my-agent-42')).toBe('my-agent-42')
  })
})
