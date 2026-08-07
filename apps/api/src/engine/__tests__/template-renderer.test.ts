import { describe, expect, it, vi } from 'vitest'
import {
  engineTypeToAgentProviderLabel,
  extractVariableNames,
  hasTemplateVariables,
  renderTemplate,
} from '../template-renderer.js'

// ============================================================
// hasTemplateVariables
// ============================================================

describe('hasTemplateVariables', () => {
  it('returns true when template contains {{variable}}', async () => {
    expect(hasTemplateVariables('Hello {{name}}')).toBe(true)
  })

  it('returns true for multiple variables', async () => {
    expect(hasTemplateVariables('{{message}} and {{context}}')).toBe(true)
  })

  it('returns false for plain text', async () => {
    expect(hasTemplateVariables('Hello world')).toBe(false)
  })

  it('returns false for empty string', async () => {
    expect(hasTemplateVariables('')).toBe(false)
  })

  it('returns false for single braces', async () => {
    expect(hasTemplateVariables('{name}')).toBe(false)
  })

  it('returns true for triple braces (Mustache unescaped)', async () => {
    expect(hasTemplateVariables('{{{name}}}')).toBe(true)
  })
})

// ============================================================
// extractVariableNames
// ============================================================

describe('extractVariableNames', () => {
  it('extracts single variable', async () => {
    expect(extractVariableNames('Hello {{name}}')).toEqual(['name'])
  })

  it('extracts multiple variables', async () => {
    const names = extractVariableNames('{{message}} with {{context}} and {{FEISHU_APP_ID}}')
    expect(names).toEqual(['message', 'context', 'FEISHU_APP_ID'])
  })

  it('deduplicates repeated variables', async () => {
    const names = extractVariableNames('{{name}} is {{name}}')
    expect(names).toEqual(['name'])
  })

  it('returns empty array for plain text', async () => {
    expect(extractVariableNames('Hello world')).toEqual([])
  })

  it('returns empty array for empty string', async () => {
    expect(extractVariableNames('')).toEqual([])
  })
})

// ============================================================
// renderTemplate
// ============================================================

describe('renderTemplate', () => {
  it('replaces message and context variables', async () => {
    const result = renderTemplate('User said: {{message}}, context: {{context}}', {
      message: 'hello',
      context: { info: 'test context' },
    })
    expect(result).toBe('User said: hello, context: {"info":"test context"}')
  })

  it('replaces env variables', async () => {
    const result = renderTemplate('App ID: {{FEISHU_APP_ID}}', {
      message: '',
      context: {},
      env: { FEISHU_APP_ID: 'cli_abc123' },
    })
    expect(result).toBe('App ID: cli_abc123')
  })

  it('built-in variables override same-name env vars', async () => {
    const result = renderTemplate('{{message}}', {
      message: 'user input',
      context: {},
      env: { message: 'env value' },
    })
    expect(result).toBe('user input')
  })

  it('renders undefined variables as empty string', async () => {
    const result = renderTemplate('Hello {{unknown}}!', {
      message: '',
      context: {},
    })
    expect(result).toBe('Hello !')
  })

  it('does NOT escape HTML (disables Mustache default escaping)', async () => {
    const result = renderTemplate('{{message}}', {
      message: '<b>bold</b> & "quoted"',
      context: {},
    })
    expect(result).toBe('<b>bold</b> & "quoted"')
  })

  it('skips rendering and returns template as-is when no {{}} present', async () => {
    const template = 'No variables here'
    const result = renderTemplate(template, { message: 'test', context: {} })
    expect(result).toBe(template)
  })

  it('handles empty template', async () => {
    expect(renderTemplate('', { message: '', context: {} })).toBe('')
  })

  it('renders empty context object as {}', async () => {
    const result = renderTemplate('msg: {{message}}, ctx: {{context}}', {
      message: 'hi',
      context: {},
    })
    expect(result).toBe('msg: hi, ctx: {}')
  })

  it('renders context object with multiple keys as JSON string', async () => {
    const result = renderTemplate('ctx: {{context}}', {
      message: '',
      context: { userId: '123', taskType: 'review' },
    })
    expect(result).toBe('ctx: {"userId":"123","taskType":"review"}')
  })

  it('handles multiple env vars', async () => {
    const result = renderTemplate('{{A}} and {{B}}', {
      message: '',
      context: {},
      env: { A: 'alpha', B: 'beta' },
    })
    expect(result).toBe('alpha and beta')
  })

  it('handles template with only whitespace around variables', async () => {
    const result = renderTemplate('  {{message}}  ', {
      message: 'hi',
      context: {},
    })
    expect(result).toBe('  hi  ')
  })

  it('replaces model and agent_provider built-in variables', async () => {
    const result = renderTemplate('Model: {{model}}, Provider: {{agent_provider}}', {
      message: '',
      context: {},
      model: 'claude-sonnet',
      agent_provider: 'Cursor Agent',
    })
    expect(result).toBe('Model: claude-sonnet, Provider: Cursor Agent')
  })

  it('built-in model and agent_provider override same-name env vars', async () => {
    const result = renderTemplate('{{model}} | {{agent_provider}}', {
      message: '',
      context: {},
      env: { model: 'from-env', agent_provider: 'from-env' },
      model: 'gpt-4o',
      agent_provider: 'Claude Code',
    })
    expect(result).toBe('gpt-4o | Claude Code')
  })

  it('renders model and agent_provider as empty string when not provided', async () => {
    const result = renderTemplate('[{{model}}][{{agent_provider}}]', {
      message: '',
      context: {},
    })
    expect(result).toBe('[][]')
  })
})

// ============================================================
// engineTypeToAgentProviderLabel
// ============================================================

describe('engineTypeToAgentProviderLabel', () => {
  it('maps cursor to Cursor Agent', async () => {
    expect(engineTypeToAgentProviderLabel('cursor')).toBe('Cursor Agent')
  })

  it('maps claude-code to Claude Code', async () => {
    expect(engineTypeToAgentProviderLabel('claude-code')).toBe('Claude Code')
  })

  it('returns empty string for undefined', async () => {
    expect(engineTypeToAgentProviderLabel(undefined)).toBe('')
  })

  it('returns engineType as-is for unknown type', async () => {
    expect(engineTypeToAgentProviderLabel('custom-engine')).toBe('custom-engine')
  })
})
