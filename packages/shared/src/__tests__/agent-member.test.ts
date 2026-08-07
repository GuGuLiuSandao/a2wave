import { describe, expect, it } from 'vitest'
import {
  addAgentMemberInput,
  agentMemberRoleEnum,
  updateAgentMemberInput,
} from '../schemas/agent.js'

describe('agentMemberRoleEnum', () => {
  it('accepts viewer role', () => {
    expect(agentMemberRoleEnum.parse('viewer')).toBe('viewer')
  })

  it('accepts editor role', () => {
    expect(agentMemberRoleEnum.parse('editor')).toBe('editor')
  })

  it('rejects owner (owner is not assignable as member role)', () => {
    expect(agentMemberRoleEnum.safeParse('owner').success).toBe(false)
  })

  it('rejects unknown roles', () => {
    expect(agentMemberRoleEnum.safeParse('admin').success).toBe(false)
    expect(agentMemberRoleEnum.safeParse('random').success).toBe(false)
    expect(agentMemberRoleEnum.safeParse('').success).toBe(false)
  })
})

describe('addAgentMemberInput', () => {
  it('parses a valid viewer payload', () => {
    expect(addAgentMemberInput.parse({ userId: 'user_1', role: 'viewer' })).toEqual({
      userId: 'user_1',
      role: 'viewer',
    })
  })

  it('parses a valid editor payload', () => {
    expect(addAgentMemberInput.parse({ userId: 'user_2', role: 'editor' })).toEqual({
      userId: 'user_2',
      role: 'editor',
    })
  })

  it('rejects empty userId', () => {
    expect(addAgentMemberInput.safeParse({ userId: '', role: 'viewer' }).success).toBe(false)
  })

  it('rejects missing userId', () => {
    expect(addAgentMemberInput.safeParse({ role: 'viewer' }).success).toBe(false)
  })

  it('rejects invalid role', () => {
    expect(addAgentMemberInput.safeParse({ userId: 'user_1', role: 'owner' }).success).toBe(false)
  })
})

describe('updateAgentMemberInput', () => {
  it('parses a valid editor payload', () => {
    expect(updateAgentMemberInput.parse({ role: 'editor' })).toEqual({ role: 'editor' })
  })

  it('rejects missing role', () => {
    expect(updateAgentMemberInput.safeParse({}).success).toBe(false)
  })

  it('rejects invalid role string', () => {
    expect(updateAgentMemberInput.safeParse({ role: 'random' }).success).toBe(false)
  })
})
