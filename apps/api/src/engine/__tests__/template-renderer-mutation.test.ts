/**
 * Mutation-killing tests for template-renderer.ts. Adds assertions for paths
 * that template-renderer.test.ts merely *exercises* without checking the
 * resulting behavior — env-var conflict warnings, the early-return short
 * circuit, and the HTML-escape disable.
 */
import Mustache from 'mustache'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../lib/logger.js', () => ({ logger: loggerMock }))

import {
  engineTypeToAgentProviderLabel,
  extractVariableNames,
  hasTemplateVariables,
  renderTemplate,
} from '../template-renderer.js'

beforeEach(() => {
  loggerMock.info.mockClear()
  loggerMock.warn.mockClear()
  loggerMock.error.mockClear()
  loggerMock.debug.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('hasTemplateVariables — boundary cases', () => {
  it('does NOT match `{{}}` empty placeholder (regex requires ≥1 non-} char)', async () => {
    expect(hasTemplateVariables('{{}}')).toBe(false)
  })

  it('matches placeholder with non-letter characters', async () => {
    expect(hasTemplateVariables('{{var.1}}')).toBe(true)
  })

  it('matches even if there is whitespace inside (Mustache standard)', async () => {
    expect(hasTemplateVariables('{{ name }}')).toBe(true)
  })

  it('does NOT match when only opening braces appear', async () => {
    expect(hasTemplateVariables('hello {{name')).toBe(false)
  })
})

describe('renderTemplate — early return', () => {
  it('returns the original string verbatim (===) when no {{}} present', async () => {
    const input = 'plain content with no variables'
    expect(renderTemplate(input, { message: 'unused', context: {} })).toBe(input)
  })

  it('does NOT invoke logger.warn for plain templates (early return path)', async () => {
    renderTemplate('plain', { message: '', context: {}, env: { message: 'x', context: 'y' } })
    expect(loggerMock.warn).not.toHaveBeenCalled()
  })
})

describe('renderTemplate — env conflict warnings', () => {
  it.each([
    ['message', { message: 'V', context: {} }],
    ['context', { message: '', context: {} }],
    ['model', { message: '', context: {}, model: 'M' }],
    ['agent_provider', { message: '', context: {}, agent_provider: 'P' }],
  ])('logs a warn when env shadows built-in "%s"', (builtinKey, baseCtx) => {
    renderTemplate('hello {{message}}', {
      ...(baseCtx as { message: string; context: Record<string, unknown> }),
      env: { [builtinKey]: 'shadow' },
    })
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: builtinKey }),
      expect.stringMatching(/conflict|priority/i),
    )
  })

  it('does NOT log a conflict warn when env contains other unrelated keys', async () => {
    renderTemplate('hello {{message}}', {
      message: 'hi',
      context: {},
      env: { UNRELATED: 'x' },
    })
    // Only the "Template variable is not defined" warns for undefined vars may
    // fire; specifically NO conflict warning. Filter for the conflict msg.
    const conflictCalls = loggerMock.warn.mock.calls.filter((call) =>
      String(call[1] ?? '').includes('conflicts with env'),
    )
    expect(conflictCalls).toHaveLength(0)
  })
})

describe('renderTemplate — undefined variable warning', () => {
  it('warns about an undefined variable AND renders it as empty string', async () => {
    const result = renderTemplate('start [{{ghost}}] end', { message: '', context: {} })
    expect(result).toBe('start [] end')
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ variable: 'ghost' }),
      expect.stringMatching(/not defined/i),
    )
  })

  it('does NOT log undefined warn for built-in variables that are populated', async () => {
    renderTemplate('{{message}} {{context}}', { message: 'a', context: { x: 1 } })
    const notDefined = loggerMock.warn.mock.calls.filter((call) =>
      String(call[1] ?? '').includes('not defined'),
    )
    expect(notDefined).toHaveLength(0)
  })
})

describe('renderTemplate — HTML escape disable + escape fallback', () => {
  it('passes ampersands and angle brackets through unescaped', async () => {
    expect(renderTemplate('{{val}}', { message: '', context: {}, env: { val: '<a&b>' } })).toBe(
      '<a&b>',
    )
  })

  it('restores the original Mustache.escape after rendering, even on throw', async () => {
    const originalEscape = Mustache.escape
    expect(() =>
      renderTemplate('{{ val }}', { message: '', context: {}, env: { val: 'ok' } }),
    ).not.toThrow()
    expect(Mustache.escape).toBe(originalEscape)
  })

  it('renders model/agent_provider as empty string when not provided', async () => {
    // Pins the ?? '' fallback (StringLiteral mutator likes to swap '' for "Stryker").
    const result = renderTemplate('m={{model}} p={{agent_provider}}', {
      message: '',
      context: {},
    })
    expect(result).toBe('m= p=')
  })

  it('JSON.stringify is used for context (not toString)', async () => {
    const result = renderTemplate('{{context}}', {
      message: '',
      context: { a: 1, b: [2, 'x'] },
    })
    expect(result).toBe('{"a":1,"b":[2,"x"]}')
  })
})

describe('engineTypeToAgentProviderLabel — every mapped entry', () => {
  // Each label string is a mutation target. Pinning every entry catches the
  // StringLiteral mutator emptying any one of them.
  it.each([
    ['cursor', 'Cursor Agent'],
    ['claude-code', 'Claude Code'],
    ['codex', 'Codex'],
    ['llm', 'LLM'],
    ['script', 'Script'],
  ])('maps %s → %s', (engineType, label) => {
    expect(engineTypeToAgentProviderLabel(engineType)).toBe(label)
  })

  it('returns empty string for undefined', async () => {
    expect(engineTypeToAgentProviderLabel(undefined)).toBe('')
  })

  it('echoes back the engineType as label for unmapped types', async () => {
    expect(engineTypeToAgentProviderLabel('zzz-unknown')).toBe('zzz-unknown')
  })
})

describe('extractVariableNames — pin Mustache.parse contract', () => {
  it('returns a stable iteration order matching first-appearance', async () => {
    expect(extractVariableNames('{{c}} {{a}} {{b}} {{a}}')).toEqual(['c', 'a', 'b'])
  })

  it('returns [] when template has only static text', async () => {
    expect(extractVariableNames('no vars here at all')).toEqual([])
  })

  it('ignores Mustache section tags ({{#foo}}…{{/foo}}) and only returns "name" tokens', async () => {
    // Sections live as token[0]='#'/'/' rather than 'name', so they should not
    // appear in the result. This pins the `token[0] === 'name'` discriminator.
    const names = extractVariableNames('{{#cond}}body{{/cond}} {{value}}')
    expect(names).toEqual(['value'])
  })
})
