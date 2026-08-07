import type { Context } from 'hono'
import ipaddr from 'ipaddr.js'
import { env } from '../env.js'

export interface ClientIpPolicy {
  trustProxy: boolean
  trustedProxyAddresses: string[]
}

function defaultPolicy(): ClientIpPolicy {
  return {
    trustProxy: env.TRUSTED_PROXY,
    trustedProxyAddresses: env.TRUSTED_PROXY_ADDRESSES.split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  }
}

/** Read the direct TCP peer address supplied by Hono's Node adapter. */
export function readTcpRemoteAddress(c: Context): string | undefined {
  const remoteAddress = (
    c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
  )?.incoming?.socket?.remoteAddress
  return remoteAddress && remoteAddress !== 'unknown' ? remoteAddress : undefined
}

function normalizeIp(raw: string): ipaddr.IPv4 | ipaddr.IPv6 | null {
  try {
    const parsed = ipaddr.parse(raw)
    if (parsed.kind() === 'ipv6') {
      const ipv6 = parsed as ipaddr.IPv6
      if (ipv6.isIPv4MappedAddress()) return ipv6.toIPv4Address()
    }
    return parsed
  } catch {
    return null
  }
}

function isTrustedProxy(remoteAddress: string, allowlist: string[]): boolean {
  const remote = normalizeIp(remoteAddress)
  if (!remote) return false

  return allowlist.some((entry) => {
    try {
      if (!entry.includes('/')) {
        const allowed = normalizeIp(entry)
        return allowed?.kind() === remote.kind() && allowed.toString() === remote.toString()
      }
      const [networkRaw, prefixRaw] = ipaddr.parseCIDR(entry)
      let network: ipaddr.IPv4 | ipaddr.IPv6 = networkRaw
      let prefix = prefixRaw
      if (networkRaw.kind() === 'ipv6') {
        const ipv6 = networkRaw as ipaddr.IPv6
        if (ipv6.isIPv4MappedAddress()) {
          if (prefix < 96) return false
          network = ipv6.toIPv4Address()
          prefix -= 96
        }
      }
      return network.kind() === remote.kind() && remote.match([network, prefix])
    } catch {
      return false
    }
  })
}

/**
 * Resolve the caller IP from one explicit proxy trust boundary.
 *
 * X-Forwarded-For is accepted only when proxy trust is enabled and the direct
 * TCP peer is allowlisted. Invalid forwarded values fail closed to the peer IP.
 */
export function resolveClientIp(
  c: Context,
  policy: ClientIpPolicy = defaultPolicy(),
): string | undefined {
  const remoteAddress = readTcpRemoteAddress(c)
  if (!remoteAddress) return undefined

  if (policy.trustProxy && isTrustedProxy(remoteAddress, policy.trustedProxyAddresses)) {
    const forwarded = c.req.header('X-Forwarded-For')
    if (forwarded) {
      const rawHops = forwarded.split(',').map((hop) => hop.trim())
      const hops = rawHops.map(normalizeIp)
      // A partially malformed chain is not trustworthy: do not skip past the
      // invalid entry and accidentally promote an attacker-controlled prefix.
      if (rawHops.some((hop) => !hop) || hops.some((hop) => hop === null)) {
        return normalizeIp(remoteAddress)?.toString() ?? remoteAddress
      }

      // Trusted proxies append their peer to XFF. Walk from the direct peer
      // outward and stop at the first untrusted hop, so a client-supplied
      // prefix cannot override the address appended by the edge proxy.
      for (let index = hops.length - 1; index >= 0; index--) {
        const hop = hops[index]
        if (!hop) return normalizeIp(remoteAddress)?.toString() ?? remoteAddress
        const normalized = hop.toString()
        if (!isTrustedProxy(normalized, policy.trustedProxyAddresses)) return normalized
      }
      // An all-trusted chain has no independently attributable client hop.
      // Returning any XFF element would let a caller inside a broadly trusted
      // CIDR choose its own identity, so fail closed to the direct peer.
      return normalizeIp(remoteAddress)?.toString() ?? remoteAddress
    }
  }

  return normalizeIp(remoteAddress)?.toString() ?? remoteAddress
}
