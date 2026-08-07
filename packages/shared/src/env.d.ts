/**
 * This package's lib stops at ES2022 (see tsconfig.base.json) and excludes DOM,
 * deliberately: it is the contract layer shared by all three apps and must not
 * assume browser globals exist.
 *
 * `URL`, however, is a WHATWG standard built into Node >= 10 and every browser —
 * runtime bedrock on both sides. So only its minimal signature is declared here,
 * rather than enabling the whole `DOM` lib, which would pull in genuinely
 * platform-specific globals like document/window and make this package look as
 * though it may touch the DOM.
 *
 * Why declare it instead of working around it: the callback-origin check in
 * schemas/sso.ts needs URL parsing. An earlier attempt dodged the missing type
 * with a regex, which was not equivalent to `new URL` on the api/web side — an
 * invalid value could be persisted and was then silently ignored at runtime.
 * There must be exactly one definition of validity; declaring the type beats
 * maintaining a second implementation of it.
 */
declare class URL {
  constructor(url: string, base?: string)
  readonly origin: string
  readonly protocol: string
  readonly username: string
  readonly password: string
  readonly hostname: string
  readonly port: string
  readonly pathname: string
  readonly search: string
  readonly hash: string
  readonly href: string
}
