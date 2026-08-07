import { describe, expect, it } from 'vitest'
import { isModelError, selectFallbackModel } from '../model-fallback.js'

describe('isModelError', () => {
  it('returns true for "model not found" messages', async () => {
    expect(isModelError('Error: model not found')).toBe(true)
  })

  it('returns true for "invalid model" messages', async () => {
    expect(isModelError('invalid model specified')).toBe(true)
  })

  it('returns true for "model unavailable" messages', async () => {
    expect(isModelError('The model unavailable right now')).toBe(true)
  })

  it('returns true for "unsupported model" messages', async () => {
    expect(isModelError('unsupported model: gpt-5')).toBe(true)
  })

  it('returns true for "model error" messages', async () => {
    expect(isModelError('A model error occurred')).toBe(true)
  })

  it('returns true for "unknown model" messages', async () => {
    expect(isModelError('Unknown model id')).toBe(true)
  })

  it('returns true for "model not available" messages', async () => {
    expect(isModelError('model not available in this region')).toBe(true)
  })

  it('returns false for non-model-related errors', async () => {
    expect(isModelError('Connection timeout')).toBe(false)
  })

  it('returns false for empty string', async () => {
    expect(isModelError('')).toBe(false)
  })

  it('is case-insensitive', async () => {
    expect(isModelError('MODEL NOT FOUND')).toBe(true)
  })

  it('matches keyword "model" alone', async () => {
    expect(isModelError('Something about the model went wrong')).toBe(true)
  })
})

describe('selectFallbackModel', () => {
  it('returns the first model different from current', async () => {
    expect(selectFallbackModel('claude-sonnet', ['claude-sonnet', 'gpt-4o'])).toBe('gpt-4o')
  })

  it('returns undefined when all fallbacks are the same as current', async () => {
    expect(selectFallbackModel('claude-sonnet', ['claude-sonnet'])).toBeUndefined()
  })

  it('returns undefined when fallback list is empty', async () => {
    expect(selectFallbackModel('claude-sonnet', [])).toBeUndefined()
  })

  it('returns the first different model (skips same)', async () => {
    expect(selectFallbackModel('a', ['a', 'a', 'b', 'c'])).toBe('b')
  })

  it('returns the first model when it is already different', async () => {
    expect(selectFallbackModel('x', ['y', 'z'])).toBe('y')
  })
})
