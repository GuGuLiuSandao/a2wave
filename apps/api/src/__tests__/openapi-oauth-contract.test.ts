import { GatewayErrorCode } from '@a2wave/shared'
import { describe, expect, it } from 'vitest'
import { openApiSpec } from '../openapi.js'

describe('OAuth OpenAPI error contract', () => {
  it('publishes OAuth invoke, poll, and cancel paths from the /api base', async () => {
    expect(openApiSpec.servers).toContainEqual({
      url: '/api',
      description: 'a2wave API base path',
    })
    expect(openApiSpec.paths).toHaveProperty('/oauth/{agentId}/invoke')
    expect(openApiSpec.paths).toHaveProperty('/oauth/{agentId}/runs/{runId}')
    expect(openApiSpec.paths).toHaveProperty('/oauth/{agentId}/runs/{runId}/cancel')
  })

  it('documents caller OAuth separately from agent provider authentication', async () => {
    const operation = openApiSpec.paths['/oauth/{agentId}/invoke']?.post
    expect(operation?.security).toEqual([{ ssoJwt: [] }])
    expect(operation?.responses).toHaveProperty('401')
    expect(operation?.responses).toHaveProperty('424')
    expect(operation?.description).toContain('Caller authentication errors use HTTP 401')
    expect(operation?.description).toContain('PROVIDER_*')
  })

  it('publishes a strict OAuth error envelope without changing the legacy gateway contract', async () => {
    const oauthGatewayError = openApiSpec.components?.schemas?.OAuthGatewayError as {
      properties?: {
        error?: { required?: string[]; properties?: { code?: { enum?: unknown[] } } }
      }
    }
    const oauthError = oauthGatewayError.properties?.error
    const documentedCodes = oauthError?.properties?.code?.enum

    expect(documentedCodes).toEqual(Object.values(GatewayErrorCode))
    expect(oauthError?.required).toEqual(['code', 'message', 'source', 'action', 'retryable'])

    const gatewayPoll = openApiSpec.paths['/gateway/{agentId}/runs/{runId}']?.get?.responses[
      '200'
    ] as { content?: { 'application/json'?: { schema?: { $ref?: string } } } }
    const oauthPoll = openApiSpec.paths['/oauth/{agentId}/runs/{runId}']?.get?.responses[200] as {
      content?: { 'application/json'?: { schema?: { $ref?: string } } }
    }
    expect(gatewayPoll.content?.['application/json']?.schema?.$ref).toBe(
      '#/components/schemas/GatewayRunStatusResponse',
    )
    expect(oauthPoll.content?.['application/json']?.schema?.$ref).toBe(
      '#/components/schemas/OAuthRunStatusResponse',
    )
  })

  it('documents OAuth async and stream precedence exactly as implemented', async () => {
    const request = openApiSpec.components?.schemas?.OAuthInvokeRequest as {
      properties?: {
        async?: { default?: unknown }
        stream?: { description?: string }
      }
    }

    expect(request.properties?.async?.default).toBe(true)
    expect(request.properties?.stream?.description).toContain('takes precedence over async')
  })
})
