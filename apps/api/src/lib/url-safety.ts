import { Agent as UndiciAgent } from 'undici'
import { env } from '../env.js'
import {
  PRIVATE_DNS_ADDRESS_ERROR,
  type PublicHostnameResolver,
  type SafeFetchOptions,
  UnsafeUrlError,
  assertSafeStrictUrl,
  createPinnedLookup,
  isBlockedHostStrict,
  isCloudMetadataHostname,
  isPrivateOrReserved,
  resolvePublicUrl,
  safeFetch,
} from './url-safety-core.js'

/**
 * 服务端 fetch 用户可控 URL 的统一 SSRF 过滤。
 *
 * 纯函数核心（hostname/IP 字面量判定、严格通道、UnsafeUrlError）放在
 * `url-safety-core.ts`，零 env 依赖，可被独立 spawn 的子进程（如内置 MCP）安全引入。
 * 本模块在其上叠加依赖 `env` 的部署级精确主机白名单：TRUSTED_IMPORT_HOSTS
 * 仅供 agent-import，TRUSTED_PROVIDER_HOSTS 仅供 Provider 模型探测。
 */

// 向后兼容：历史调用方从 url-safety.js 引入这些核心符号，原样转出。
export { UnsafeUrlError, isBlockedHostStrict, isPrivateOrReserved } from './url-safety-core.js'

function parseTrustedHosts(rawHosts: string): Set<string> {
  return new Set(
    rawHosts
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  )
}

let _trustedImportHosts: Set<string> | null = null
function getTrustedImportHosts(): Set<string> {
  if (!_trustedImportHosts) {
    _trustedImportHosts = parseTrustedHosts(env.TRUSTED_IMPORT_HOSTS)
  }
  return _trustedImportHosts
}

let _trustedProviderHosts: Set<string> | null = null
function getTrustedProviderHosts(): Set<string> {
  if (!_trustedProviderHosts) {
    _trustedProviderHosts = parseTrustedHosts(env.TRUSTED_PROVIDER_HOSTS)
  }
  return _trustedProviderHosts
}

/**
 * 判定 hostname 是否指向应当拒绝访问的目标，**允许 TRUSTED_IMPORT_HOSTS 放行**。
 *
 * 会绕过判定的情况：在 TRUSTED_IMPORT_HOSTS 里显式放行的主机
 * （用于内网部署时允许 agent-import 指向受控内网源；**不**应对 webhook / MCP 放开）。
 */
export function isBlockedHost(hostname: string): boolean {
  if (isCloudMetadataHostname(hostname)) return true
  if (getTrustedImportHosts().has(hostname.toLowerCase())) return false
  return isPrivateOrReserved(hostname)
}

/**
 * Resolve a Provider endpoint with the strict public-address policy by default.
 * Exact hostnames listed in TRUSTED_PROVIDER_HOSTS may resolve to
 * enterprise-private networks. Private IP literals and forbidden DNS ranges
 * remain blocked. Fixed upstream exceptions belong at their non-user-controlled
 * call sites, not in this generic Provider URL resolver.
 */
export async function resolveProviderUrl(
  rawUrl: string,
  resolveHostname?: PublicHostnameResolver,
): Promise<Awaited<ReturnType<typeof resolvePublicUrl>>> {
  const url = assertSafeStrictUrl(rawUrl)
  const hostname = url.hostname.toLowerCase()
  const allowPrivateDnsAnswers = getTrustedProviderHosts().has(hostname)
  try {
    return await resolvePublicUrl(rawUrl, resolveHostname, { allowPrivateDnsAnswers })
  } catch (error) {
    if (
      !allowPrivateDnsAnswers &&
      error instanceof UnsafeUrlError &&
      error.code === 'private_dns_address'
    ) {
      throw new UnsafeUrlError(
        'blocked',
        `${PRIVATE_DNS_ADDRESS_ERROR}; add the exact trusted hostname to TRUSTED_PROVIDER_HOSTS`,
      )
    }
    throw error
  }
}

/**
 * 统一的对外 fetch URL 校验：
 *   - 只允许 http / https
 *   - 挡私网 / loopback / 云元数据 / IPv6 特殊段
 *   - 默认走 strict；若调用方明确需要 TRUSTED_IMPORT_HOSTS 放行（仅限 agent-import），传 allowTrustedHosts
 *   - 不做 DNS 解析层的 rebinding 防护（TODO）
 *
 * 失败抛 UnsafeUrlError。调用方根据 reason 决定对外返回 4xx。
 */
export function assertSafePublicUrl(rawUrl: string, opts?: { allowTrustedHosts?: boolean }): URL {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new UnsafeUrlError('invalid', 'Invalid URL')
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new UnsafeUrlError('protocol', 'Only http/https allowed')
  }

  const blocked = opts?.allowTrustedHosts
    ? isBlockedHost(parsed.hostname)
    : isBlockedHostStrict(parsed.hostname)

  if (blocked) {
    throw new UnsafeUrlError('blocked', 'URL points to a private or reserved address')
  }

  return parsed
}

/**
 * Strongest-tier SSRF-safe outbound fetch for a user-configurable URL.
 *
 * Combines the two controls that a bare `fetch` (even after a one-time
 * `assertSafePublicUrl`) leaves open:
 *   1. **Redirect-follow bypass** — a target that passes validation but returns
 *      `302 Location: http://169.254.169.254/...` would be followed by default
 *      `fetch`. We resolve the redirect entirely (`maxRedirects: 0`); a webhook
 *      posts to a final endpoint, so refusing to chase a 3xx is safe.
 *   2. **DNS rebinding** — a hostname that passes the literal check while
 *      resolving to a private IP. We resolve + validate every answer, then pin
 *      the validated IP into the connection layer so the socket connects to the
 *      address we checked (no validate-then-reresolve TOCTOU). Host/SNI stay the
 *      original hostname.
 *
 * Mirrors the pinning used by attachment-materializer / claude-code — the
 * single entry point new user-URL fetchers should call instead of `fetch`.
 * Throws UnsafeUrlError when the URL is invalid, blocked, or resolves privately.
 */
/** Hard ceiling on a safePublicFetch request; a slow/never-ending peer must not hang the caller. */
const SAFE_PUBLIC_FETCH_TIMEOUT_MS = 15_000
/** Cap the buffered body so a huge/never-ending response can't exhaust memory (webhook replies are tiny). */
const SAFE_PUBLIC_FETCH_MAX_BYTES = 1024 * 1024
/** Statuses the Fetch spec forbids a body on; `new Response(body, {status})` throws otherwise. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

export async function safePublicFetch(
  rawUrl: string,
  options: Omit<SafeFetchOptions, 'dispatcher' | 'maxRedirects'> = {},
  // Injectable for tests; defaults to the real DNS resolver inside resolvePublicUrl.
  resolveHostname?: PublicHostnameResolver,
): Promise<Response> {
  // Reject scheme / IP-literal targets up front (also what safeFetch's per-hop
  // validator uses), then resolve + validate every DNS answer.
  const { addresses } = await resolvePublicUrl(rawUrl, resolveHostname)
  const pinnedDispatcher = new UndiciAgent({
    connect: {
      lookup: createPinnedLookup(addresses),
    },
  })
  // A hard timeout is the real guarantee against a peer that returns headers and
  // then holds the body open forever. It is cleared only AFTER the body is fully
  // read below, so it covers body consumption too (not just the headers).
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SAFE_PUBLIC_FETCH_TIMEOUT_MS)
  try {
    const upstream = await safeFetch(rawUrl, {
      ...options,
      signal: controller.signal,
      // Each hop still runs the strict literal validator; combined with
      // maxRedirects: 0 the request cannot be bounced to an internal address.
      validateHop: assertSafeStrictUrl,
      maxRedirects: 0,
      dispatcher: pinnedDispatcher,
    } as SafeFetchOptions)

    // Buffer the body HERE, while the pinned dispatcher is still alive and the
    // timeout still armed, then return a detached Response backed by that buffer.
    // Previously we tore the dispatcher down before returning, which either hung
    // (close drains an unread body) or handed back a Response whose body errored
    // on .text()/.json(). Buffering keeps this a real, generally-consumable
    // Response — any caller can read status AND body — with no lingering socket.
    const buffer = await readBoundedBody(upstream, SAFE_PUBLIC_FETCH_MAX_BYTES)
    const headers = new Headers(upstream.headers)
    headers.delete('content-encoding') // body is already decoded into the buffer
    headers.delete('content-length')
    // The Fetch spec forbids a body on null-body statuses (101/204/205/304), and
    // `new Response(emptyUint8Array, { status: 204 })` throws — a zero-length
    // Uint8Array is still a non-null body. A 204 is a common webhook success, so
    // pass `null` for those statuses. Uint8Array is a valid BodyInit at runtime;
    // the DOM lib types lag, so widen.
    const body = NULL_BODY_STATUSES.has(upstream.status) ? null : (buffer as BodyInit)
    return new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    })
  } finally {
    clearTimeout(timer)
    // Body already consumed (or the request aborted/errored), so destroy() is a
    // clean, immediate teardown with nothing left to drain.
    void pinnedDispatcher.destroy().catch(() => {})
  }
}

/** Read a response body into a buffer, aborting if it exceeds `maxBytes`. */
async function readBoundedBody(res: Response, maxBytes: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new UnsafeUrlError('blocked', `Response body exceeded ${maxBytes} bytes`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}
