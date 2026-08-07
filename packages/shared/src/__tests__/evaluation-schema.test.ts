import { describe, expect, it } from 'vitest'
import {
  createEvaluationCaseInput,
  createEvaluationSetInput,
  createEvaluationTaskInput,
  evaluationConfigSnapshotSchema,
  evaluationReviewSchema,
  evaluationTurnSchema,
  reviewEvaluationResultInput,
  updateEvaluationCaseInput,
} from '../schemas/evaluation.js'

describe('evaluationTurnSchema', () => {
  it('accepts a request + expected response pair', () => {
    const parsed = evaluationTurnSchema.parse({
      request: 'I want a refund for order #123',
      expectedResponse: 'Ask for the order date before deciding.',
    })
    expect(parsed.request).toBe('I want a refund for order #123')
  })

  it('rejects an empty request', () => {
    expect(() =>
      evaluationTurnSchema.parse({ request: '', expectedResponse: 'something' }),
    ).toThrow()
  })

  it('allows an empty expected response (free-form exploration)', () => {
    expect(() => evaluationTurnSchema.parse({ request: 'hi', expectedResponse: '' })).not.toThrow()
  })
})

describe('createEvaluationCaseInput', () => {
  it('requires at least one turn', () => {
    expect(() => createEvaluationCaseInput.parse({ name: 'case', turns: [] })).toThrow()
  })

  it('accepts a single-turn case (the common shape)', () => {
    const parsed = createEvaluationCaseInput.parse({
      name: 'greeting',
      turns: [{ request: 'hello', expectedResponse: 'a friendly greeting' }],
    })
    expect(parsed.turns).toHaveLength(1)
    expect(parsed.sortOrder).toBe(0)
  })

  it('accepts a multi-turn case preserving order', () => {
    const parsed = createEvaluationCaseInput.parse({
      name: 'escalation',
      turns: [
        { request: 'refund please', expectedResponse: 'ask for date' },
        { request: '40 days ago', expectedResponse: 'decline, offer credit' },
      ],
    })
    expect(parsed.turns.map((t) => t.request)).toEqual(['refund please', '40 days ago'])
  })

  it('rejects a blank name', () => {
    expect(() =>
      createEvaluationCaseInput.parse({
        name: '',
        turns: [{ request: 'hi', expectedResponse: '' }],
      }),
    ).toThrow()
  })
})

describe('updateEvaluationCaseInput', () => {
  it('is a partial of create, so a rename alone is valid', () => {
    const parsed = updateEvaluationCaseInput.parse({ name: 'renamed' })
    expect(parsed.name).toBe('renamed')
    expect(parsed.turns).toBeUndefined()
  })

  it('still enforces the non-empty turns rule when turns are supplied', () => {
    expect(() => updateEvaluationCaseInput.parse({ turns: [] })).toThrow()
  })
})

describe('createEvaluationSetInput', () => {
  it('requires a name', () => {
    expect(() => createEvaluationSetInput.parse({})).toThrow()
  })

  it('accepts name + optional description', () => {
    const parsed = createEvaluationSetInput.parse({ name: 'customer service' })
    expect(parsed.name).toBe('customer service')
  })
})

describe('createEvaluationTaskInput', () => {
  it('requires a setId', () => {
    expect(() => createEvaluationTaskInput.parse({})).toThrow()
  })

  it('accepts a setId with an optional task name', () => {
    const parsed = createEvaluationTaskInput.parse({ setId: 'evs_abc', name: 'baseline' })
    expect(parsed.setId).toBe('evs_abc')
  })
})

describe('evaluationConfigSnapshotSchema', () => {
  it('captures provider, model and prompt', () => {
    const parsed = evaluationConfigSnapshotSchema.parse({
      providerId: 'prv_1',
      providerName: 'Claude Code',
      model: 'claude-opus-4-8',
      systemPrompt: 'You are a support agent.',
      capturedAt: '2026-07-20T00:00:00.000Z',
    })
    expect(parsed.model).toBe('claude-opus-4-8')
    expect(parsed.capturedAt).toBeInstanceOf(Date)
  })

  it('strips unknown keys, so credentials cannot ride along', () => {
    const parsed = evaluationConfigSnapshotSchema.parse({
      providerId: 'prv_1',
      providerName: 'Claude Code',
      model: 'm',
      systemPrompt: '',
      capturedAt: new Date(),
      providerApiKey: 'sk-should-not-survive',
      providerOauthToken: 'oauth-should-not-survive',
      providerBaseUrl: 'https://internal.example.com',
    })
    expect(parsed).not.toHaveProperty('providerApiKey')
    expect(parsed).not.toHaveProperty('providerOauthToken')
    expect(parsed).not.toHaveProperty('providerBaseUrl')
  })

  it('tolerates a null provider (agent never had one bound)', () => {
    const parsed = evaluationConfigSnapshotSchema.parse({
      providerId: null,
      providerName: null,
      model: null,
      systemPrompt: '',
      capturedAt: new Date(),
    })
    expect(parsed.providerId).toBeNull()
  })
})

describe('evaluationReviewSchema', () => {
  it('accepts a pass verdict with a note', () => {
    const parsed = evaluationReviewSchema.parse({
      verdict: 'pass',
      note: 'handled the edge case well',
      reviewedBy: 'usr_1',
      reviewedAt: new Date(),
    })
    expect(parsed.verdict).toBe('pass')
  })

  it('rejects an unknown verdict', () => {
    expect(() =>
      evaluationReviewSchema.parse({
        verdict: 'maybe',
        reviewedBy: 'usr_1',
        reviewedAt: new Date(),
      }),
    ).toThrow()
  })
})

describe('reviewEvaluationResultInput', () => {
  it('accepts pass/fail/unreviewed', () => {
    for (const verdict of ['pass', 'fail', 'unreviewed'] as const) {
      expect(reviewEvaluationResultInput.parse({ verdict }).verdict).toBe(verdict)
    }
  })

  it('does not let the caller forge reviewer identity', () => {
    const parsed = reviewEvaluationResultInput.parse({
      verdict: 'pass',
      reviewedBy: 'usr_someone_else',
    })
    expect(parsed).not.toHaveProperty('reviewedBy')
  })
})
