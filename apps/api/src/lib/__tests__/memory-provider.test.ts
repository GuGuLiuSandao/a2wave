import { describe, expect, it } from 'vitest'

import { isConfigDisabled, resolveNumericConfig } from '../memory-provider.js'

describe('isConfigDisabled', () => {
  it('treats only explicit false and "false" as disabled', () => {
    expect(isConfigDisabled(false)).toBe(true)
    expect(isConfigDisabled('false')).toBe(true)
    expect(isConfigDisabled(true)).toBe(false)
    expect(isConfigDisabled('true')).toBe(false)
    expect(isConfigDisabled(undefined)).toBe(false)
    expect(isConfigDisabled(0)).toBe(false)
  })
})

describe('resolveNumericConfig', () => {
  it('preserves 0, which a `Number(x) || fallback` coercion would discard', () => {
    // mmrLambda=0 means pure-diversity MMR and halfLife=0 means no temporal
    // decay — both are first-class values, not "unset".
    expect(resolveNumericConfig(0, 0.7)).toBe(0)
    expect(resolveNumericConfig('0', 0.7)).toBe(0)
    expect(resolveNumericConfig(0, 14)).toBe(0)
  })

  it('falls back when the value is unset', () => {
    expect(resolveNumericConfig(undefined, 0.7)).toBe(0.7)
    expect(resolveNumericConfig(null, 14)).toBe(14)
    expect(resolveNumericConfig('', 14)).toBe(14)
    expect(resolveNumericConfig('   ', 14)).toBe(14)
  })

  it('falls back when the value is not a finite number', () => {
    expect(resolveNumericConfig('abc', 0.7)).toBe(0.7)
    expect(resolveNumericConfig(Number.NaN, 14)).toBe(14)
    expect(resolveNumericConfig(Number.POSITIVE_INFINITY, 14)).toBe(14)
    expect(resolveNumericConfig({}, 14)).toBe(14)
    expect(resolveNumericConfig([], 14)).toBe(14)
  })

  it('accepts numeric strings, which is how the web UI submits these fields', () => {
    expect(resolveNumericConfig('30', 14)).toBe(30)
    expect(resolveNumericConfig('0.35', 0.7)).toBe(0.35)
    expect(resolveNumericConfig(' 30 ', 14)).toBe(30)
  })

  it('passes ordinary numbers through unchanged', () => {
    expect(resolveNumericConfig(30, 14)).toBe(30)
    expect(resolveNumericConfig(1, 0.7)).toBe(1)
    expect(resolveNumericConfig(-5, 14)).toBe(-5)
  })
})
