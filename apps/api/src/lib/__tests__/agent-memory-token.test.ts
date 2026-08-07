import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TOKEN_TTL_MS,
  agentTokenAllows,
  clearAgentTokenStoreForTest,
  clearExpiredAgentTokens,
  consumeAgentTopicRead,
  getAgentTokenStoreSizeForTest,
  getRuntimeMemoryTokenClaims,
  isExplicitMemoryMutationRequest,
  isMemoryPersistenceOptOutRequest,
  registerAgentToken,
  revokeAgentTokensForAgent,
  runtimeMemoryActionsForPrompt,
  validateAgentToken,
} from '../agent-memory-token.js'

describe('agent-memory-token', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-19T00:00:00.000Z'))
    clearAgentTokenStoreForTest()
  })

  afterEach(() => {
    clearAgentTokenStoreForTest()
    vi.useRealTimers()
  })

  it('issues URL-safe tokens and validates them until TTL expires', async () => {
    const token = registerAgentToken('agt_test')

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(token.length).toBe(43)
    expect(validateAgentToken(token)).toBe('agt_test')
    expect(agentTokenAllows(token, 'explicit:write')).toBe(false)

    vi.advanceTimersByTime(TOKEN_TTL_MS + 1)

    expect(validateAgentToken(token)).toBeNull()
    expect(getAgentTokenStoreSizeForTest()).toBe(0)
  })

  it('clears expired tokens in bulk', async () => {
    const first = registerAgentToken('agt_first')
    vi.advanceTimersByTime(1000)
    const second = registerAgentToken('agt_second')

    expect(clearExpiredAgentTokens(Date.now() + TOKEN_TTL_MS)).toBe(1)
    expect(validateAgentToken(first)).toBeNull()
    expect(validateAgentToken(second)).toBe('agt_second')
  })

  it('revokes all outstanding tokens for a deleted agent', async () => {
    const first = registerAgentToken('agt_target')
    const second = registerAgentToken('agt_target')
    const other = registerAgentToken('agt_other')

    expect(revokeAgentTokensForAgent('agt_target')).toBe(2)
    expect(validateAgentToken(first)).toBeNull()
    expect(validateAgentToken(second)).toBeNull()
    expect(validateAgentToken(other)).toBe('agt_other')
  })

  it('issues bounded runtime memory claims', async () => {
    const token = registerAgentToken('agt_test', {
      runStepId: 'rst_test',
      allowedActions: ['topics:list', 'topics:read'],
      maxTopicReads: 2,
      maxTopicTokens: 3000,
    })

    expect(getRuntimeMemoryTokenClaims(token)).toEqual(
      expect.objectContaining({
        agentId: 'agt_test',
        runStepId: 'rst_test',
        bundleVersion: 'memory-v2',
        allowedActions: ['topics:list', 'topics:read'],
        maxTopicReads: 2,
        maxTopicTokens: 3000,
      }),
    )
    expect(agentTokenAllows(token, 'topics:list')).toBe(true)
    expect(agentTokenAllows(token, 'search')).toBe(false)
  })

  it('distinguishes explicit memory mutations from durable statements and negations', async () => {
    expect(isExplicitMemoryMutationRequest('这是一条长期稳定的工作准则，只需确认理解。')).toBe(
      false,
    )
    expect(isExplicitMemoryMutationRequest('请不要把这段话保存到长期记忆。')).toBe(false)
    expect(isExplicitMemoryMutationRequest('请不要把这条规则持久化。')).toBe(false)
    expect(isExplicitMemoryMutationRequest('你还记得我的发布规则吗？')).toBe(false)
    expect(isExplicitMemoryMutationRequest('请概括这句话：“请记住这条发布规则。”')).toBe(false)
    expect(isExplicitMemoryMutationRequest('请把这条规则记到长期记忆中。')).toBe(true)
    expect(
      isExplicitMemoryMutationRequest(
        '请把长期规则保存到名为“架构决策”的主题：所有架构变更必须先运行兼容性测试。',
      ),
    ).toBe(true)
    expect(isExplicitMemoryMutationRequest('请把这条发布规则添加到“发布约束”主题。')).toBe(true)
    expect(isExplicitMemoryMutationRequest('请把兼容性检查记录为长期规则。')).toBe(true)
    expect(
      isExplicitMemoryMutationRequest(
        '请把这条等价规则也持久化：Indigo-Falcon credentials follow a 45-day rotation cadence.',
      ),
    ).toBe(true)
    expect(isExplicitMemoryMutationRequest('请记住“发布前运行聚焦测试”。')).toBe(true)
    expect(isExplicitMemoryMutationRequest('Please update this rule in memory.')).toBe(true)
  })

  it('recognizes a request to keep the current run out of memory persistence', async () => {
    expect(
      isMemoryPersistenceOptOutRequest('本次只用于当前任务，不要长期保存：EPHEMERAL-729。'),
    ).toBe(true)
    expect(isMemoryPersistenceOptOutRequest('这是临时信息，请不要写入记忆。')).toBe(true)
    expect(isMemoryPersistenceOptOutRequest('请不要把这段话保存到长期记忆。')).toBe(true)
    expect(isMemoryPersistenceOptOutRequest('不要修改任何记忆，只回答问题。')).toBe(true)
    expect(
      isMemoryPersistenceOptOutRequest('不要保存临时构建产物；请记住发布前运行聚焦测试。'),
    ).toBe(false)
  })

  it('treats colloquial Chinese memory negations as opt-out rather than write authorization', async () => {
    const prompts = [
      '这次别记到长期记忆',
      '别记到长期记忆',
      '别把这个保存到记忆',
      '别记住这条',
      '不用记到记忆里',
      '不用保存到记忆',
      '甭把这条写入长期记忆',
      '无须记录到记忆',
    ]

    for (const prompt of prompts) {
      expect(isExplicitMemoryMutationRequest(prompt)).toBe(false)
      expect(isMemoryPersistenceOptOutRequest(prompt)).toBe(true)
      expect(runtimeMemoryActionsForPrompt(prompt)).not.toContain('explicit:write')
    }
  })

  it('enforces topic read count and token budgets', async () => {
    const token = registerAgentToken('agt_test', { maxTopicReads: 2, maxTopicTokens: 2500 })

    expect(consumeAgentTopicRead(token, 1000)).toEqual({
      ok: true,
      remainingReads: 1,
      remainingTokens: 1500,
    })
    expect(consumeAgentTopicRead(token, 1400)).toEqual({
      ok: true,
      remainingReads: 0,
      remainingTokens: 100,
    })
    expect(consumeAgentTopicRead(token, 50)).toEqual(
      expect.objectContaining({ ok: false, reason: 'read_limit' }),
    )
  })
})
