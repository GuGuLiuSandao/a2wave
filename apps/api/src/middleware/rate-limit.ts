import { GatewayErrorCode } from '@a2wave/shared'
import type { Context, Next } from 'hono'
import { resolveClientIp } from '../lib/client-ip.js'

interface RateLimitEntry {
  count: number
  resetAt: number
}

interface RateLimitOptions {
  windowMs?: number
  max?: number
  keyFn?: (c: Context) => string
  trustProxy?: boolean
  trustedProxyAddresses?: string[]
}

const DEFAULT_WINDOW_MS = 60_000
const DEFAULT_MAX = 60

export function rateLimit(options: RateLimitOptions = {}) {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
  const max = options.max ?? DEFAULT_MAX
  const keyFn =
    options.keyFn ??
    ((c: Context) =>
      resolveClientIp(
        c,
        options.trustProxy === undefined && options.trustedProxyAddresses === undefined
          ? undefined
          : {
              trustProxy: options.trustProxy ?? false,
              trustedProxyAddresses: options.trustedProxyAddresses ?? [],
            },
      ) ?? 'global')

  const store = new Map<string, RateLimitEntry>()

  setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of store) {
      if (entry.resetAt <= now) store.delete(key)
    }
  }, windowMs).unref()

  return async (c: Context, next: Next) => {
    const key = keyFn(c)
    const now = Date.now()

    let entry = store.get(key)
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs }
      store.set(key, entry)
    }

    entry.count++

    c.header('X-RateLimit-Limit', String(max))
    c.header('X-RateLimit-Remaining', String(Math.max(0, max - entry.count)))
    c.header('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)))

    if (entry.count > max) {
      c.header('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))))
      return c.json(
        {
          error: {
            code: GatewayErrorCode.RATE_LIMITED,
            message:
              'This client has exceeded the API request limit. Wait until the time in Retry-After, then retry.',
            source: 'caller',
            action: 'retry_later',
            retryable: true,
          },
        },
        429,
      )
    }

    await next()
  }
}
