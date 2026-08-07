/**
 * `safeReturnTo` guards the post-login redirect.
 *
 * The chat page is reached by following a colleague's link, so the target must
 * survive the login round-trip — but a redirect target taken from the URL is an
 * open-redirect vector if it is not constrained to same-origin paths.
 */
import { describe, expect, it } from 'vitest'

import { safeReturnTo } from '../login'

describe('safeReturnTo', () => {
  it('accepts an absolute same-origin path', () => {
    expect(safeReturnTo('/agents/agt_1/chat_app')).toBe('/agents/agt_1/chat_app')
  })

  it('keeps the query string', () => {
    expect(safeReturnTo('/agents/agt_1?tab=publish')).toBe('/agents/agt_1?tab=publish')
  })

  it('rejects null and empty input', () => {
    expect(safeReturnTo(null)).toBeNull()
    expect(safeReturnTo('')).toBeNull()
  })

  it('rejects an absolute external URL', () => {
    expect(safeReturnTo('https://evil.example.com/')).toBeNull()
  })

  it('rejects protocol-relative URLs, which browsers resolve as external', () => {
    expect(safeReturnTo('//evil.example.com/')).toBeNull()
    expect(safeReturnTo('/\\evil.example.com/')).toBeNull()
  })

  it('rejects a relative path that could escape the app root', () => {
    expect(safeReturnTo('agents/agt_1')).toBeNull()
  })
})

describe('safeReturnTo — parser-level bypasses', () => {
  it('rejects a leading control character that resolves to an external origin', () => {
    // `/\t/evil.example` is stripped by the URL parser into `https://evil.example/`,
    // so a prefix-only check let it through. Verified against the real parser.
    expect(safeReturnTo('/\t/evil.example')).toBeNull()
    expect(safeReturnTo('/\n/evil.example')).toBeNull()
    expect(safeReturnTo('/\r/evil.example')).toBeNull()
  })

  it('keeps a percent-encoded segment as a same-origin path', () => {
    // %09 is NOT decoded by the parser, so this stays a genuine local path.
    expect(safeReturnTo('/%09/evil.example')).toBe('/%09/evil.example')
  })

  it('rejects paths that normalise into a protocol-relative URL', () => {
    // The prefix checks run BEFORE parsing, and the parser applies dot-segment
    // normalisation — both of these used to come back as '//evil.com', violating
    // the function's own same-origin-path contract.
    expect(safeReturnTo('/.//evil.com')).toBeNull()
    expect(safeReturnTo('/%2e%2e//evil.com')).toBeNull()
  })

  it('preserves query and hash on an accepted path', () => {
    expect(safeReturnTo('/agents/a1/chat_app?x=1#frag')).toBe('/agents/a1/chat_app?x=1#frag')
  })
})
