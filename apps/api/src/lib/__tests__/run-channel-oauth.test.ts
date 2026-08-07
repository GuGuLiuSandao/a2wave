/**
 * Covers buildOAuthChannel — not exercised by run-channel.test.ts (which
 * focuses on buildGatewayChannel).
 */
import type { Context } from 'hono'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { buildOAuthChannel } from '../run-channel.js'

type TestGatewayChannelInfo = {
  request_id?: string
  oauth?: unknown
  feishu_scope?: unknown
}

function fakeCtx(headers: Record<string, string> = {}, remoteAddr = '203.0.113.10'): Context {
  return {
    req: {
      header(name: string) {
        return headers[name] ?? headers[name.toLowerCase()]
      },
    },
    env: { incoming: { socket: { remoteAddress: remoteAddr } } },
  } as unknown as Context
}

describe('buildOAuthChannel', () => {
  it('builds an oauth channel from an idaas_user caller with an email', () => {
    const ctx = fakeCtx({ 'X-Request-Id': 'req-1' })
    const result = buildOAuthChannel(ctx, {
      oauthCaller: {
        kind: 'idaas_user',
        userInfo: {
          sub: 's',
          issuer: 'iss',
          email: 'a@b.com',
          username: 'alice',
          mobile: '12345',
          tenantId: 't',
          unionId: 'u',
        },
      } as never,
      requestId: undefined,
    })
    expect(result.ctx).toMatchObject({
      channel_type: 'oauth',
      channel_info: {
        auth: 'oauth',
        request_id: 'req-1',
        oauth: { issuer: 'iss', sub: 's', tenant_id: 't', union_id: 'u' },
      },
      user_info: {
        email: 'a@b.com',
        name: 'alice',
        mobile: '12345',
        source: 'idaas',
        source_id: 's',
      },
    })
    expect(result.displayName).toBe('alice')
  })

  it('honors explicit opts.requestId over header values', () => {
    const ctx = fakeCtx({ 'X-Request-Id': 'header-id' })
    const result = buildOAuthChannel(ctx, {
      oauthCaller: {
        kind: 'idaas_user',
        userInfo: { sub: 's', issuer: 'iss', email: 'a@b.com' },
      } as never,
      requestId: 'explicit-id',
    })
    const channelInfo = result.ctx.channel_info as TestGatewayChannelInfo
    expect(channelInfo.request_id).toBe('explicit-id')
  })

  it('falls back to X-Request-ID (uppercase) when X-Request-Id is absent', () => {
    const ctx = fakeCtx({ 'X-Request-ID': 'uppercase-id' })
    const result = buildOAuthChannel(ctx, {
      oauthCaller: {
        kind: 'idaas_user',
        userInfo: { sub: 's', issuer: 'iss', email: 'a@b.com' },
      } as never,
      requestId: undefined,
    })
    const channelInfo = result.ctx.channel_info as TestGatewayChannelInfo
    expect(channelInfo.request_id).toBe('uppercase-id')
  })

  it('returns user_info=null when there is no email on the IdP user', () => {
    const ctx = fakeCtx()
    const result = buildOAuthChannel(ctx, {
      oauthCaller: {
        kind: 'idaas_user',
        userInfo: { sub: 's', issuer: 'iss' },
      } as never,
      requestId: undefined,
    })
    expect(result.ctx.user_info).toBeNull()
  })

  it('omits the oauth block when caller is not idaas_user', () => {
    const ctx = fakeCtx()
    const result = buildOAuthChannel(ctx, {
      oauthCaller: { kind: 'unknown' } as never,
      requestId: undefined,
    })
    const channelInfo = result.ctx.channel_info as TestGatewayChannelInfo
    expect(channelInfo.oauth).toBeUndefined()
    expect(channelInfo.feishu_scope).toBeUndefined()
    expect(result.ctx.user_info).toBeNull()
  })
})
