import { LegacyJsonRpcTransportHandler } from '@a2a-js/sdk/compat/v0_3/server'
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
} from '@a2a-js/sdk/server'
import { describe, expect, it, vi } from 'vitest'
import { buildAgentCard } from '../agent-card.js'
import { A2waveAgentExecutor, type ExecuteFn } from '../executor.js'

function createProtocolHarness() {
  const executeFn = vi.fn<ExecuteFn>().mockResolvedValue({
    success: true,
    output: 'standard response',
    durationMs: 1,
  })
  const executor = new A2waveAgentExecutor(
    { agentConfig: {}, workDir: '/tmp/a2a-protocol-test' },
    executeFn,
  )
  const card = buildAgentCard(
    {
      id: 'agt_protocol',
      name: 'Protocol Agent',
      description: 'Protocol test',
      publishDescription: null,
      a2aAuthType: 'none',
      a2aSkills: [],
    },
    'https://example.com',
  )
  const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor)
  const context = (version: string) =>
    new ServerCallContext({
      requestedVersion: version,
      tenant: 'agt_protocol',
      user: { isAuthenticated: true, userName: 'protocol-test' },
    })
  return {
    executeFn,
    v1: new JsonRpcTransportHandler(requestHandler),
    legacy: new LegacyJsonRpcTransportHandler(requestHandler),
    context,
  }
}

describe('A2A JSON-RPC protocol compatibility', () => {
  it('accepts a standard v1.0 SendMessage request and returns the v1 task envelope', async () => {
    const harness = createProtocolHarness()

    const response = await harness.v1.handle(
      {
        jsonrpc: '2.0',
        id: 'v1-request',
        method: 'SendMessage',
        params: {
          tenant: '',
          message: {
            messageId: 'msg-v1',
            role: 'ROLE_USER',
            parts: [{ text: 'hello v1', mediaType: 'text/plain' }],
          },
        },
      },
      harness.context('1.0'),
    )

    expect(Symbol.asyncIterator in response).toBe(false)
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 'v1-request',
      result: {
        task: {
          status: { state: 'TASK_STATE_COMPLETED' },
          artifacts: [{ parts: [{ text: 'standard response' }] }],
        },
      },
    })
    expect(harness.executeFn.mock.calls[0][1].prompt).toBe('hello v1')
  })

  it('accepts a v0.3 message/send request through the compatibility transport', async () => {
    const harness = createProtocolHarness()

    const response = await harness.legacy.handle(
      {
        jsonrpc: '2.0',
        id: 'legacy-request',
        method: 'message/send',
        params: {
          message: {
            kind: 'message',
            messageId: 'msg-legacy',
            role: 'user',
            parts: [{ kind: 'text', text: 'hello legacy' }],
          },
        },
      },
      harness.context('0.3'),
    )

    expect(Symbol.asyncIterator in response).toBe(false)
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 'legacy-request',
      result: {
        kind: 'task',
        status: { state: 'completed' },
        artifacts: [{ parts: [{ kind: 'text', text: 'standard response' }] }],
      },
    })
    expect(harness.executeFn.mock.calls[0][1].prompt).toBe('hello legacy')
  })
})
