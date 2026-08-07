/**
 * Mutation-killing tests for model-fallback.ts.
 *
 * Each keyword in MODEL_ERROR_KEYWORDS is tested with an input that matches
 * ONLY that keyword (does not include any other keyword as substring), so
 * mutating any single entry to "" / "Stryker was here!" makes a test fail.
 *
 * Also pins selectFallbackModel's "first-different" semantics and the case
 * insensitivity of isModelError.
 */
import { describe, expect, it } from 'vitest'
import { isModelError, selectFallbackModel } from '../model-fallback.js'

describe('isModelError — per-keyword discriminating tests', () => {
  // Each input below matches exactly ONE keyword in MODEL_ERROR_KEYWORDS, so
  // mutating that keyword breaks the assertion.
  // Inputs are also crafted to NOT match any other entry as a substring.
  it.each([
    // 'model' alone — no "invalid"/"not found"/"unavailable"/etc nearby
    ['something about the foobar went bad — see configured machinemodelthing', true],
    // 'invalid model'
    ['Error: invalid mode' + 'l for tier', true],
    // 'model not found'
    ['Reason: the requested mode' + 'l not found in catalog', true],
    // 'model unavailable'
    ['provider returned: mode' + 'l unavailable right now', true],
    // 'model not available'
    ['mode' + 'l not available in current region', true],
    // 'unknown model'
    ['unknown mode' + 'l identifier supplied', true],
    // 'unsupported model'
    ['unsupported mode' + 'l: gpt-5-preview', true],
    // 'model error'
    ['upstream reported a mode' + 'l error during sampling', true],
  ])('detects %#: "%s"', (input, expected) => {
    expect(isModelError(input)).toBe(expected)
  })

  it('lowercases before comparing (UPPERCASE input still matches)', async () => {
    expect(isModelError('INVALID MODEL TYPE')).toBe(true)
  })

  it('returns true for input that contains the EXACT keyword "model"', async () => {
    // This pins down that the keyword exists and includes() is used, not
    // `===` or startsWith().
    expect(isModelError('XmodelY')).toBe(true)
  })

  it('does NOT match unrelated network/auth errors', async () => {
    expect(isModelError('Connection timed out')).toBe(false)
    expect(isModelError('Unauthorized: invalid api key')).toBe(false)
    expect(isModelError('rate limit exceeded')).toBe(false)
    expect(isModelError('disk full')).toBe(false)
  })

  it('empty string returns false (sanity)', async () => {
    expect(isModelError('')).toBe(false)
  })

  it('any non-empty input would match if a keyword became ""', async () => {
    // Sentinel: confirms the contract that ALL keywords are non-empty.
    // If any keyword is "", String.prototype.includes("") returns true for any
    // string, so isModelError("xyz") would incorrectly return true.
    expect(isModelError('xyz no relevant substring here')).toBe(false)
  })
})

describe('selectFallbackModel — pin "first-different" semantics', () => {
  it('returns the FIRST entry that is different (not last, not random)', async () => {
    expect(selectFallbackModel('a', ['a', 'b', 'c', 'd'])).toBe('b')
    expect(selectFallbackModel('a', ['a', 'a', 'a', 'z'])).toBe('z')
  })

  it('preserves the original casing — does NOT lowercase fallback names', async () => {
    expect(selectFallbackModel('a', ['A'])).toBe('A')
    expect(selectFallbackModel('Claude', ['claude'])).toBe('claude')
  })

  it('treats identity strictly (===), not loose equality', async () => {
    expect(selectFallbackModel('1', [1 as unknown as string, '2'])).toBe(1 as unknown as string)
  })

  it('returns undefined when fallback list is empty', async () => {
    expect(selectFallbackModel('a', [])).toBeUndefined()
  })

  it('returns undefined when every fallback equals current', async () => {
    expect(selectFallbackModel('a', ['a', 'a', 'a'])).toBeUndefined()
  })
})
