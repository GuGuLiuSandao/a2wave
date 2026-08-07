import { describe, expect, it } from 'vitest'
import { selectFilterOption, selectOptionSearchText } from '../select-filter'

describe('select filter helpers', () => {
  it('normalizes searchable option labels without assuming every label is a string', () => {
    expect(selectOptionSearchText('lark-im')).toBe('lark-im')
    expect(selectOptionSearchText(123)).toBe('123')
    expect(selectOptionSearchText(<span>Skill Groups</span>)).toBe('')
    expect(selectOptionSearchText(null)).toBe('')
  })

  it('matches string and numeric labels case-insensitively', () => {
    expect(selectFilterOption('LARK', { label: 'lark-im' })).toBe(true)
    expect(selectFilterOption('ark-i', { label: 'lark-im' })).toBe(true)
    expect(selectFilterOption('missing', { label: 'lark-im' })).toBe(false)
    expect(selectFilterOption('23', { label: 123 })).toBe(true)
  })

  it('treats non-searchable labels and missing options as empty text', () => {
    expect(selectFilterOption('', { label: <span>Skill Groups</span> })).toBe(true)
    expect(selectFilterOption('skill', { label: <span>Skill Groups</span> })).toBe(false)
    expect(selectFilterOption('anything')).toBe(false)
  })
})
