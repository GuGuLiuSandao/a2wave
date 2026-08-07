/**
 * Strip capability-bearing material out of a request-log path.
 *
 * Two independent leaks make this necessary:
 *
 *  1. hono's `logger()` builds its path as `url.slice(url.indexOf('/', 8))`, which
 *     keeps the **query string** — so the OIDC `code` on `/api/auth/oidc/callback`
 *     lands in the log. (PKCE means a logged code is not directly redeemable, but
 *     it is still an authorization artefact that has no business in stdout.)
 *  2. Several routes carry their credential in a **path segment**, most sharply
 *     `GET /api/agents/shared/:token` — unauthenticated, unrate-limited, valid 24h.
 *
 * Neither is covered by pino's `redact`, which matches structured field names and
 * cannot touch a free-text string; the default hono printer does not even reach
 * pino, writing straight to `console.log`.
 *
 * The query string is dropped wholesale rather than by parameter name, so a future
 * capability-bearing param is covered by default instead of after it leaks.
 */

/**
 * Path prefixes whose *next* segment is a secret. Prefix-matched, and anything
 * after the masked segment is preserved so route shape stays readable
 * (`/s/:agentId/***\/raw`).
 */
const TOKEN_BEARING_PREFIXES = ['/api/agents/shared/', '/api/attachments/'] as const

/** `/s/:agentId/:shareId` — the shareId *is* the URL token. */
const ARTIFACT_SHARE_PATTERN = /^(\/s\/[^/]+\/)[^/]+/

export function sanitizeRequestLogPath(pathWithQuery: string): string {
  const queryStart = pathWithQuery.indexOf('?')
  const path = queryStart === -1 ? pathWithQuery : pathWithQuery.slice(0, queryStart)

  for (const prefix of TOKEN_BEARING_PREFIXES) {
    if (path.startsWith(prefix)) {
      const rest = path.slice(prefix.length)
      if (!rest) break
      const nextSlash = rest.indexOf('/')
      return nextSlash === -1 ? `${prefix}***` : `${prefix}***${rest.slice(nextSlash)}`
    }
  }

  return path.replace(ARTIFACT_SHARE_PATTERN, '$1***')
}
