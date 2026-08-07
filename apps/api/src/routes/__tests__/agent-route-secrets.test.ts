import { describe, expect, it } from 'vitest'
import { preserveA2ARouteTargetSecrets } from '../agent-route-secrets.js'

describe('A2A route target credential preservation', () => {
  it('restores a masked legacy direct-route key after the UI adds explicit 0.3 defaults', () => {
    const result = preserveA2ARouteTargetSecrets(
      [
        {
          type: 'remote',
          name: 'legacy',
          url: 'https://legacy.example.com/a2a',
          connectionMode: 'direct',
          protocolVersion: '0.3',
          apiKey: '********',
        },
      ],
      [
        {
          type: 'remote',
          name: 'legacy',
          url: 'https://legacy.example.com/a2a',
          apiKey: 'stored-secret',
        },
      ],
    )

    expect(result).toEqual({
      ok: true,
      value: [
        {
          type: 'remote',
          name: 'legacy',
          url: 'https://legacy.example.com/a2a',
          connectionMode: 'direct',
          protocolVersion: '0.3',
          apiKey: 'stored-secret',
        },
      ],
    })
  })

  it('preserves a masked key when only the remote target display name changes', () => {
    const result = preserveA2ARouteTargetSecrets(
      [
        {
          type: 'remote',
          name: 'new-display-name',
          url: 'https://agents.example.com/.well-known/agent-card.json',
          connectionMode: 'agent_card',
          apiKey: '********',
        },
      ],
      [
        {
          type: 'remote',
          name: 'old-display-name',
          url: 'https://agents.example.com/.well-known/agent-card.json',
          connectionMode: 'agent_card',
          apiKey: 'stored-secret',
        },
      ],
    )

    expect(result).toEqual({
      ok: true,
      value: [
        {
          type: 'remote',
          name: 'new-display-name',
          url: 'https://agents.example.com/.well-known/agent-card.json',
          connectionMode: 'agent_card',
          apiKey: 'stored-secret',
        },
      ],
    })
  })

  it('refuses to carry a masked key to a changed endpoint or discovery mode', () => {
    const result = preserveA2ARouteTargetSecrets(
      [
        {
          type: 'remote',
          name: 'service',
          url: 'https://new.example.com/.well-known/agent-card.json',
          connectionMode: 'agent_card',
          apiKey: '********',
        },
      ],
      [
        {
          type: 'remote',
          name: 'service',
          url: 'https://old.example.com/a2a',
          apiKey: 'stored-secret',
        },
      ],
    )

    expect(result).toEqual({ ok: false, targetName: 'service' })
  })

  it('refuses to carry a masked key to a changed direct protocol version', () => {
    const result = preserveA2ARouteTargetSecrets(
      [
        {
          type: 'remote',
          name: 'service',
          url: 'https://agents.example.com/a2a',
          connectionMode: 'direct',
          protocolVersion: '1.0',
          apiKey: '********',
        },
      ],
      [
        {
          type: 'remote',
          name: 'service',
          url: 'https://agents.example.com/a2a',
          connectionMode: 'direct',
          protocolVersion: '0.3',
          apiKey: 'stored-secret',
        },
      ],
    )

    expect(result).toEqual({ ok: false, targetName: 'service' })
  })

  it('does not reuse one stored key for two masked targets at the same endpoint', () => {
    const result = preserveA2ARouteTargetSecrets(
      [
        {
          type: 'remote',
          name: 'renamed-one',
          url: 'https://agents.example.com/a2a',
          connectionMode: 'direct',
          protocolVersion: '0.3',
          apiKey: '********',
        },
        {
          type: 'remote',
          name: 'renamed-two',
          url: 'https://agents.example.com/a2a',
          connectionMode: 'direct',
          protocolVersion: '0.3',
          apiKey: '********',
        },
      ],
      [
        {
          type: 'remote',
          name: 'original',
          url: 'https://agents.example.com/a2a',
          connectionMode: 'direct',
          protocolVersion: '0.3',
          apiKey: 'stored-secret',
        },
      ],
    )

    expect(result).toEqual({ ok: false, targetName: 'renamed-two' })
  })
})
