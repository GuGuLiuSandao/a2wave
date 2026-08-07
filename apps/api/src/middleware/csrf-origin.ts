import type { Context, Next } from 'hono'
import { env } from '../env.js'
import { AUTH_COOKIE_NAME, LEGACY_AUTH_COOKIE_NAME } from '../lib/auth.js'

/**
 * Origin-based CSRF guard for cookie-authenticated state changes.
 *
 * Why this is needed even with `SameSite=Lax` + CORS:
 *
 *  1. `SameSite=Lax` blocks cross-*site* requests, but every subdomain of one
 *     registrable domain is same-*site*. A foothold on any sibling host
 *     (`intranet.example.com`) therefore still gets the session cookie attached
 *     to a POST at `a2wave.example.com`.
 *  2. CORS governs who may *read* a response, not who may cause the side effect.
 *     The write lands before the browser withholds the body.
 *  3. The "JSON bodies force a preflight" assumption does not hold: `c.req.json()`
 *     is `text().then(JSON.parse)` and never inspects `Content-Type`, so a
 *     CORS-safelisted `text/plain` POST — which is *not* preflighted — parses
 *     exactly like `application/json`.
 *
 * Scope is deliberately narrow, so this closes the hole without becoming a second
 * authorization layer that can silently break clients:
 *
 *  - **Safe methods pass.** GET/HEAD/OPTIONS change no state.
 *  - **Only requests carrying a session cookie are gated.** Ambient authority is
 *    the entire problem; a request with no cookie has none to abuse. This keeps
 *    the public gateway / A2A / OAuth channels (Iron Rule: they authenticate by
 *    their own API key or token) completely untouched.
 *  - **`Authorization: Bearer` is exempt.** A cross-origin attacker cannot set
 *    that header, and `authMiddleware` prefers it over the cookie, so a CLI or
 *    programmatic client is never ambient-authenticated. Gating it would break
 *    every such client for no security gain.
 *  - **Same-origin writes are exempt.** They are not cross-site requests at all,
 *    and the single-container deployment (API serving `apps/web/dist`) produces
 *    an origin no configured allowlist entry describes. See `isSameOrigin`.
 *  - **SSO callbacks are exempt.** They are cross-origin *by design* (the IdP
 *    POSTs/redirects into them) and carry their own anti-forgery state: OIDC
 *    verifies `state` plus a PKCE verifier sealed in a flow cookie, and SAML
 *    validates a signed assertion.
 *
 * A missing `Origin` on a cookie-bearing unsafe request is rejected rather than
 * waved through: browsers always send it in exactly the cross-origin case this
 * defends, so its absence is not a shape a supported browser client produces.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Paths that must stay reachable cross-origin. Prefix-matched, so the OIDC entry
 * also covers `/callback`, and SAML covers its ACS endpoint.
 */
const EXEMPT_PATH_PREFIXES = ['/api/auth/oidc/', '/api/auth/saml/']

/**
 * Origins allowed to drive cookie-authenticated writes.
 *
 * Read per request rather than computed once at module load: several tests (and
 * the operator scripts) mutate env after import, and a cached list would answer
 * from a stale configuration.
 */
function allowedOrigins(): string[] {
  return [env.CORS_ORIGIN, env.PUBLIC_URL].filter((value): value is string => !!value)
}

/**
 * True when `origin` names the same host this request was addressed to.
 *
 * A same-origin request is not a CSRF by definition, and this is not a second
 * trust decision: a browser sets both `Origin` and `Host` itself, so a page on
 * another site cannot make them agree. The escape hatch exists because
 * `CORS_ORIGIN` describes the *dev* two-port topology (web :3501 + api :3502),
 * while the single-container deployment has the API serve `apps/web/dist` — the
 * browser's origin is then the API's own host, which that list never contains.
 * Without this, every post-login write in the documented Docker quickstart 403s.
 *
 * Compares host only, ignoring scheme: TLS is routinely terminated at a reverse
 * proxy that forwards over plain HTTP, so the request URL is `http://` while the
 * browser sends an `https://` origin. The host may be proxy-rewritten, but it is
 * rewritten to *this instance's* public name — which is exactly the value a
 * same-origin browser puts in `Origin`.
 *
 * Reads the host from `c.req.url` rather than the `Host` header: hono builds the
 * URL from that header (or HTTP/2 `:authority`) for a real request, and the value
 * survives in-process dispatch, where the raw header is absent.
 */
function isSameOrigin(c: Context, origin: string): boolean {
  try {
    return new URL(origin).host === new URL(c.req.url).host
  } catch {
    return false
  }
}

/**
 * True when the request presents a platform session cookie.
 *
 * Matches both the `__Host-` prefixed name and the legacy unprefixed one, because
 * a non-secure (plain-HTTP intranet) deployment writes the latter — reading only
 * the prefixed name would leave exactly those installs unprotected.
 *
 * Uses the raw header instead of hono's `getCookie` so a malformed cookie header
 * cannot throw its way past the guard.
 */
function hasSessionCookie(c: Context): boolean {
  const header = c.req.header('Cookie')
  if (!header) return false
  return header
    .split(';')
    .map((part) => part.trim().split('=')[0])
    .some((name) => name === AUTH_COOKIE_NAME || name === LEGACY_AUTH_COOKIE_NAME)
}

export async function csrfOriginMiddleware(c: Context, next: Next) {
  if (SAFE_METHODS.has(c.req.method)) return next()
  if (EXEMPT_PATH_PREFIXES.some((prefix) => c.req.path.startsWith(prefix))) return next()

  // Bearer wins over the cookie in authMiddleware, so such a request is never
  // authenticated by ambient credentials even when a cookie rides along.
  if (c.req.header('Authorization')?.startsWith('Bearer ')) return next()

  if (!hasSessionCookie(c)) return next()

  const origin = c.req.header('Origin')
  if (origin && isSameOrigin(c, origin)) return next()

  if (!origin || !allowedOrigins().includes(origin)) {
    return c.json({ error: 'CSRF_ORIGIN_REJECTED' }, 403)
  }

  return next()
}
