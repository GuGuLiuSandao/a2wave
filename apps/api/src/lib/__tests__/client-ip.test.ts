import type { Context } from 'hono'
import { describe, expect, it } from 'vitest'
import { resolveClientIp } from '../client-ip.js'

function makeContext(remoteAddress: string | undefined, forwardedFor?: string): Context {
  return {
    req: {
      header: (name: string) =>
        name.toLowerCase() === 'x-forwarded-for' ? forwardedFor : undefined,
    },
    env: remoteAddress ? { incoming: { socket: { remoteAddress } } } : undefined,
  } as unknown as Context
}

describe('resolveClientIp', () => {
  it('ignores a spoofed X-Forwarded-For header when proxy trust is disabled', async () => {
    const c = makeContext('198.51.100.20', '203.0.113.10')
    expect(
      resolveClientIp(c, { trustProxy: false, trustedProxyAddresses: ['198.51.100.20'] }),
    ).toBe('198.51.100.20')
  })

  it('ignores X-Forwarded-For when the TCP peer is not trusted', async () => {
    const c = makeContext('198.51.100.20', '203.0.113.10')
    expect(resolveClientIp(c, { trustProxy: true, trustedProxyAddresses: ['10.0.0.0/8'] })).toBe(
      '198.51.100.20',
    )
  })

  it('uses the first valid forwarded client IP behind an exact trusted proxy', async () => {
    const c = makeContext('10.0.0.2', '203.0.113.10')
    expect(resolveClientIp(c, { trustProxy: true, trustedProxyAddresses: ['10.0.0.2'] })).toBe(
      '203.0.113.10',
    )
  })

  it('walks an appended chain right-to-left so a spoofed prefix cannot become the client', async () => {
    const c = makeContext('10.0.0.2', '192.0.2.66, 203.0.113.10')
    expect(resolveClientIp(c, { trustProxy: true, trustedProxyAddresses: ['10.0.0.2'] })).toBe(
      '203.0.113.10',
    )
  })

  it('skips every trusted proxy in a multi-proxy chain', async () => {
    const c = makeContext('10.0.0.3', '203.0.113.10, 10.0.0.1, 10.0.0.2')
    expect(resolveClientIp(c, { trustProxy: true, trustedProxyAddresses: ['10.0.0.0/8'] })).toBe(
      '203.0.113.10',
    )
  })

  it('supports trusted IPv4 and IPv6 CIDR proxy boundaries', async () => {
    expect(
      resolveClientIp(makeContext('10.2.3.4', '203.0.113.11'), {
        trustProxy: true,
        trustedProxyAddresses: ['10.0.0.0/8'],
      }),
    ).toBe('203.0.113.11')
    expect(
      resolveClientIp(makeContext('2001:db8::42', '2001:4860:4860::8888'), {
        trustProxy: true,
        trustedProxyAddresses: ['2001:db8::/32'],
      }),
    ).toBe('2001:4860:4860::8888')
  })

  it('falls back to the TCP peer when X-Forwarded-For is malformed', async () => {
    const c = makeContext('10.0.0.2', '203.0.113.10, attacker-controlled-value')
    expect(resolveClientIp(c, { trustProxy: true, trustedProxyAddresses: ['10.0.0.0/8'] })).toBe(
      '10.0.0.2',
    )
  })

  it('normalizes an IPv4-mapped trusted TCP peer before matching', async () => {
    const c = makeContext('::ffff:10.0.0.2', '203.0.113.10')
    expect(resolveClientIp(c, { trustProxy: true, trustedProxyAddresses: ['10.0.0.0/8'] })).toBe(
      '203.0.113.10',
    )
    expect(
      resolveClientIp(c, {
        trustProxy: true,
        trustedProxyAddresses: ['::ffff:10.0.0.0/104'],
      }),
    ).toBe('203.0.113.10')
  })

  it('falls back to the direct peer when every forwarded hop is trusted', async () => {
    const c = makeContext('10.0.0.3', '10.9.9.9, 10.0.0.2')
    expect(resolveClientIp(c, { trustProxy: true, trustedProxyAddresses: ['10.0.0.0/8'] })).toBe(
      '10.0.0.3',
    )
  })
})
