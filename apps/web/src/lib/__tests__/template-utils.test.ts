import { describe, expect, it } from 'vitest'
import { extractTemplateVariables, findUndefinedVariables } from '../template-utils'

// ============================================================
// extractTemplateVariables
// ============================================================

describe('extractTemplateVariables', () => {
  it('extracts single variable', () => {
    expect(extractTemplateVariables('Hello {{name}}')).toEqual(['name'])
  })

  it('extracts multiple variables', () => {
    const vars = extractTemplateVariables('{{message}} and {{context}} and {{FEISHU_APP_ID}}')
    expect(vars).toEqual(['message', 'context', 'FEISHU_APP_ID'])
  })

  it('deduplicates repeated variables', () => {
    expect(extractTemplateVariables('{{a}} {{a}} {{b}}')).toEqual(['a', 'b'])
  })

  it('returns empty array for plain text', () => {
    expect(extractTemplateVariables('no variables')).toEqual([])
  })

  it('returns empty array for empty string', () => {
    expect(extractTemplateVariables('')).toEqual([])
  })

  it('ignores single braces', () => {
    expect(extractTemplateVariables('{notAVar}')).toEqual([])
  })

  it('handles variables with underscores and numbers', () => {
    expect(extractTemplateVariables('{{MY_VAR_123}}')).toEqual(['MY_VAR_123'])
  })

  it('trims whitespace inside braces', () => {
    expect(extractTemplateVariables('{{ message }}')).toEqual(['message'])
  })
})

// ============================================================
// findUndefinedVariables
// ============================================================

describe('findUndefinedVariables', () => {
  it('returns variables not in envKeys and not built-in', () => {
    const result = findUndefinedVariables('{{message}} {{UNKNOWN}}', [])
    expect(result).toEqual(['UNKNOWN'])
  })

  it('does not flag built-in variables (message, context, model, agent_provider)', () => {
    const result = findUndefinedVariables(
      '{{message}} {{context}} {{model}} {{agent_provider}}',
      [],
    )
    expect(result).toEqual([])
  })

  it('does not flag env keys', () => {
    const result = findUndefinedVariables('{{FEISHU_APP_ID}}', ['FEISHU_APP_ID'])
    expect(result).toEqual([])
  })

  it('returns all undefined variables', () => {
    const result = findUndefinedVariables('{{A}} {{B}} {{message}}', ['A'])
    expect(result).toEqual(['B'])
  })

  it('returns empty array when all variables are defined', () => {
    const result = findUndefinedVariables('{{message}} {{MY_KEY}}', ['MY_KEY'])
    expect(result).toEqual([])
  })

  it('returns empty array for plain text', () => {
    expect(findUndefinedVariables('no vars', [])).toEqual([])
  })
})
