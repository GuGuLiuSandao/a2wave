/**
 * Mutation-killing tests for prompt-builder.ts. Pins down literals and
 * boundaries that build-full-prompt.test.ts / prompt-security.test.ts only
 * partially assert:
 *   - INJECTION_PATTERNS (every pattern triggers a warn + escaping)
 *   - escapeXml mapping (each of & < > " ' has its own assertion)
 *   - truncateText boundary (≤ vs > maxLength, the "..." suffix)
 *   - AVAILABLE_AGENTS_LIMIT = 15 (the 16th agent doesn't appear, the
 *     overflow notice does)
 *   - AVAILABLE_AGENT_DESCRIPTION_LIMIT = 80 (truncation kicks in at 81)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../lib/logger.js', () => ({ logger: loggerMock }))

import { assembleSystemPrompt, buildPromptParts } from '../prompt-builder.js'

beforeEach(() => {
  loggerMock.info.mockClear()
  loggerMock.warn.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('INJECTION_PATTERNS — every entry triggers a warn', () => {
  it.each([
    '</rules>',
    '</system>',
    '</instructions>',
    '</user_query>',
    '<system_override',
    'system override',
    '忘记上述',
    '忘掉上述',
    '忽略上述',
    '绕过规则',
    'bypass rule',
    'ignore previous',
    'forget previous',
    'system prompt',
    'actual instruction',
    'real instruction',
    '管理员权限',
    'admin override',
  ])('detects "%s" in the user message and logs an injection warn', (pattern) => {
    assembleSystemPrompt({
      agentPrompt: '',
      userMessage: `prefix ${pattern} suffix`,
    })
    const injectionWarns = loggerMock.warn.mock.calls.filter(
      (call) =>
        String(call[1] ?? call[0]).includes('prompt injection') ||
        String(call[1] ?? '').includes('suspicious'),
    )
    expect(injectionWarns.length).toBeGreaterThan(0)
  })

  it('does NOT log an injection warn for a clean user message', async () => {
    assembleSystemPrompt({ agentPrompt: '', userMessage: 'please summarize the report' })
    const injectionWarns = loggerMock.warn.mock.calls.filter((call) =>
      String(call[1] ?? call[0]).includes('prompt injection'),
    )
    expect(injectionWarns).toHaveLength(0)
  })
})

describe('escapeXml — character-by-character', () => {
  it.each([
    ['&', '&amp;'],
    ['<', '&lt;'],
    ['>', '&gt;'],
    ['"', '&quot;'],
    ["'", '&apos;'],
  ])('escapes %s to %s in <user_query>', (raw, escaped) => {
    const out = assembleSystemPrompt({ agentPrompt: '', userMessage: `pre${raw}post` })
    expect(out).toContain(`pre${escaped}post`)
    expect(out).not.toContain(`pre${raw}post`)
  })

  it('escapes & FIRST (so subsequent escaped sequences are not double-escaped)', async () => {
    const out = assembleSystemPrompt({
      agentPrompt: '',
      userMessage: 'a & < b',
    })
    // & must become &amp; — NOT &amp;amp; (which would happen if & was last)
    expect(out).toContain('a &amp; &lt; b')
  })

  it('does NOT escape inside <instructions> (agent prompt is trusted)', async () => {
    const out = assembleSystemPrompt({
      agentPrompt: '<role>system</role>',
      userMessage: '',
    })
    expect(out).toContain('<instructions>\n<role>system</role>\n</instructions>')
    expect(out).not.toContain('&lt;role&gt;')
  })
})

describe('availableAgents — limit + description truncation', () => {
  function agent(i: number, descLen?: number) {
    return {
      id: `agt_${i}`,
      name: `Agent ${i}`,
      description: descLen ? 'x'.repeat(descLen) : `Desc ${i}`,
      source: 'local' as const,
    }
  }

  it('includes all 15 agents when count is exactly 15 (no overflow notice)', async () => {
    const agents = Array.from({ length: 15 }, (_, i) => agent(i + 1))
    const out = assembleSystemPrompt({
      agentPrompt: '',
      userMessage: '',
      availableAgents: agents,
    })
    expect(out).toContain('agt_1')
    expect(out).toContain('agt_15')
    expect(out).not.toContain('list_agents` for the full list')
  })

  it('truncates to 15 and shows overflow notice when count is 16', async () => {
    const agents = Array.from({ length: 16 }, (_, i) => agent(i + 1))
    const out = assembleSystemPrompt({
      agentPrompt: '',
      userMessage: '',
      availableAgents: agents,
    })
    expect(out).toContain('agt_1')
    expect(out).toContain('agt_15')
    expect(out).not.toContain('agt_16')
    expect(out).toContain('list_agents')
  })

  it('omits <available_agents> section entirely when list is empty', async () => {
    const out = assembleSystemPrompt({
      agentPrompt: '',
      userMessage: '',
      availableAgents: [],
    })
    expect(out).not.toContain('<available_agents>')
  })

  it('description ≤ 80 chars is NOT truncated', async () => {
    const description = 'x'.repeat(80)
    const out = assembleSystemPrompt({
      agentPrompt: '',
      userMessage: '',
      availableAgents: [agent(1, 80)],
    })
    expect(out).toContain(description)
    expect(out).not.toContain(`${'x'.repeat(77)}...`)
  })

  it('description > 80 chars gets truncated with "..." suffix at total length 80', async () => {
    const out = assembleSystemPrompt({
      agentPrompt: '',
      userMessage: '',
      availableAgents: [agent(1, 200)],
    })
    // After truncation the line should contain exactly 77 x's + ...
    expect(out).toContain(`${'x'.repeat(77)}...`)
    expect(out).not.toContain('x'.repeat(81))
  })

  it('falls back to "No description provided." when description is empty', async () => {
    const a = { ...agent(1), description: '' }
    const out = assembleSystemPrompt({
      agentPrompt: '',
      userMessage: '',
      availableAgents: [a],
    })
    expect(out).toContain('No description provided.')
  })
})

describe('buildPromptParts — template rendering toggle', () => {
  it('renders template variables ONLY when both context AND {{}} exist', async () => {
    const parts = buildPromptParts(
      'hello',
      { systemPrompt: 'Hi {{name}}' },
      { message: 'hello', context: {}, env: { name: 'world' } },
    )
    expect(parts.agentPrompt).toBe('Hi world')
  })

  it('does NOT touch systemPrompt that has no template variables, even with context provided', async () => {
    const parts = buildPromptParts(
      'hello',
      { systemPrompt: 'Plain prompt' },
      { message: 'hello', context: {} },
    )
    expect(parts.agentPrompt).toBe('Plain prompt')
  })

  it('does NOT render when templateContext is undefined (raw passthrough)', async () => {
    const parts = buildPromptParts('hello', { systemPrompt: 'Hi {{name}}' })
    expect(parts.agentPrompt).toBe('Hi {{name}}')
  })
})
