import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db/client.js', () => ({
  db: {},
}))

vi.mock('../../db/schema.js', () => ({
  runs: {},
}))

import type { GatewayCaller } from '../../middleware/gateway-auth.js'
import { buildOAuthTriggerSessionId } from '../oauth-session.js'

function caller(input: { issuer: string; sub: string }): GatewayCaller {
  return {
    kind: 'idaas_user',
    userInfo: {
      issuer: input.issuer,
      sub: input.sub,
    },
  } as GatewayCaller
}

describe('oauth-session', () => {
  it('isolates the same client session id by agent and OAuth user', async () => {
    const base = buildOAuthTriggerSessionId({
      agentId: 'agt_1',
      caller: caller({ issuer: 'https://idaas.example.com/', sub: 'user_1' }),
      sessionId: 'sess_shared',
    })

    expect(base).toMatch(/^oauth:[a-f0-9]{32}$/)
    expect(
      buildOAuthTriggerSessionId({
        agentId: 'agt_2',
        caller: caller({ issuer: 'https://idaas.example.com/', sub: 'user_1' }),
        sessionId: 'sess_shared',
      }),
    ).not.toBe(base)
    expect(
      buildOAuthTriggerSessionId({
        agentId: 'agt_1',
        caller: caller({ issuer: 'https://idaas.example.com/', sub: 'user_2' }),
        sessionId: 'sess_shared',
      }),
    ).not.toBe(base)
    expect(
      buildOAuthTriggerSessionId({
        agentId: 'agt_1',
        caller: caller({ issuer: 'https://other-issuer.example.com/', sub: 'user_1' }),
        sessionId: 'sess_shared',
      }),
    ).not.toBe(base)
  })
})
