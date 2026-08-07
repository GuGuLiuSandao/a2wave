import type { GitConfig, P4Config, ScmSourceConfig } from '@a2wave/shared'

/**
 * Sentinel written in place of a stored SCM credential on every read path.
 *
 * SCM `config` carries plaintext credentials (P4 `p4passwd`, Git `pat`, and
 * credentials that may be embedded in a `repoUrl` userinfo). Unlike an mcp-server
 * whose secret is only masked from non-owner viewers, an SCM credential is masked
 * on EVERY read (owner + admin included): the value is never needed client-side
 * (sync/check resolve it server-side by id), and returning it plaintext means a
 * single admin list call dumps every user's Perforce password and Git PAT.
 *
 * The write paths (`POST /` and `PATCH /:id`) treat a submitted value equal to
 * this sentinel — or blank — as "keep the stored secret", so a form can
 * round-trip the masked placeholder back without clobbering the real credential.
 * When there is nothing stored to keep, the sentinel resolves to *no credential*
 * rather than to itself: it must never become a stored or dialed-out value.
 */
export const SCM_SECRET_MASK = '********'

/** True when a submitted credential should be treated as "unchanged, keep stored". */
export function isMaskedOrBlank(value: string | undefined | null): boolean {
  return value == null || value === '' || value === SCM_SECRET_MASK
}

/**
 * Resolve a submitted credential against the stored one.
 *
 * The sentinel means "keep the stored secret", so when there is no stored secret
 * to keep it must resolve to **undefined** — never to itself. Reads mask on
 * every path, so a form loads `********` into the credential field of *any*
 * source and submits it back verbatim; a source that simply has no credential
 * (a public repo, a P4 server with no password) round-trips the sentinel just
 * like one that does.
 *
 * Letting it through made the literal string the credential:
 * `buildAuthUrlFromParts` embeds it as the HTTPS password, so probing such a
 * source dialed out with `********` — a spurious auth failure on a repo that is
 * actually reachable anonymously, plus the sentinel written into the remote's
 * auth log. The save path is the same bug one step earlier, persisting the
 * sentinel as the stored credential.
 *
 * `stored` is screened by the same rule, which is what repairs rows the save
 * path already polluted: restoring a stored sentinel verbatim would keep dialing
 * out with it indefinitely, and the user cannot clear it by submitting a blank
 * because blank means "keep stored". Screening both sides makes the corruption
 * self-healing on the next save.
 */
function resolveMaskedSecret(
  submitted: string | undefined,
  stored: string | undefined,
): string | undefined {
  const resolved = isMaskedOrBlank(submitted) ? stored : submitted
  return resolved === SCM_SECRET_MASK ? undefined : resolved
}

/** Keys of `T` whose type admits `undefined` — i.e. the ones safe to delete. */
type OptionalKeys<T> = {
  [K in keyof T]-?: undefined extends T[K] ? K : never
}[keyof T]

/**
 * Set `key` to `value`, or remove it entirely when there is no value.
 *
 * Assigning a bare `undefined` is not equivalent, for two reasons. `scmConfigEquals`
 * sorts `Object.keys`, and an own-but-undefined property serializes as `null`,
 * so inventing a `pat: undefined` on a config that never had one makes a pure
 * masked round-trip compare unequal — and `PATCH /:id` reads that as a config
 * change, resetting sync bookkeeping or 409-ing while a sync holds the row. The
 * persisted value would not even differ: `JSON.stringify` drops undefined
 * properties, so the row lands identical while comparing unequal — a phantom
 * change that clears sync state and leaves no trace of why.
 *
 * `key` is constrained to OPTIONAL keys so the `as T` cast cannot lie: `rest` is
 * really `Omit<T, K>`, which only equals `T` when `K` was allowed to be absent.
 * Without the constraint this compiles for a required key too (P4's `p4passwd`
 * sits one branch away), handing back a config missing a field the type promises.
 */
function withOptionalSecret<T extends object, K extends OptionalKeys<T> & string>(
  config: T,
  key: K,
  value: string | undefined,
): T {
  if (value === undefined) {
    const { [key]: _removed, ...rest } = config
    return rest as T
  }
  return { ...config, [key]: value }
}

/**
 * Reduce a repo URL to a form that cannot leak an embedded credential.
 *
 * A git `repoUrl` may embed `user:token@host`. We drop the userinfo entirely and
 * keep the rest (scheme/host/path) so the URL stays recognizable. Non-URL / ssh
 * scp-style strings (`git@host:org/repo`) are returned unchanged — they carry no
 * inline password, only a username, which is not a secret. If a userinfo password
 * is present we mask it; if only a username is present we keep it.
 */
export function redactRepoUrlCredential(repoUrl: string): string {
  if (!repoUrl) return repoUrl
  try {
    const parsed = new URL(repoUrl)
    if (!parsed.username && !parsed.password) return repoUrl
    // Keep the username (identity, not a secret); drop any inline password.
    parsed.password = ''
    if (parsed.username) parsed.username = SCM_SECRET_MASK
    // URL serializes back with `user@` when username is set and password empty.
    return parsed.toString()
  } catch {
    // Not a standard URL (e.g. scp-style git@host:path) — no inline password to leak.
    return repoUrl
  }
}

/**
 * True when `repoUrl` looks like the masked form this module emits — i.e. its
 * userinfo username is the sentinel (`redactRepoUrlCredential` sets username to
 * SCM_SECRET_MASK and clears the password). Used by the write path to decide
 * "this URL is a masked round-trip; keep the stored one" rather than persisting
 * `********@host` (which would break clone). Blank counts as masked/keep too.
 */
export function isMaskedRepoUrl(repoUrl: string | undefined | null): boolean {
  if (repoUrl == null || repoUrl === '') return true
  try {
    return new URL(repoUrl).username === SCM_SECRET_MASK
  } catch {
    return false // scp-style / non-URL is never masked (no userinfo to sentinel)
  }
}

type GitUrlShape = {
  repoUrl?: string
  repos?: { repoUrl: string; directory: string }[]
}

/**
 * Collect every stored URL (top-level + repos[]) as a candidate for restoration.
 * Order does not matter — we match by masked value, not position.
 */
function collectStoredUrls(existing: GitUrlShape | undefined): string[] {
  if (!existing) return []
  const urls: string[] = []
  if (existing.repoUrl) urls.push(existing.repoUrl)
  for (const r of existing.repos ?? []) if (r.repoUrl) urls.push(r.repoUrl)
  return urls
}

/**
 * Resolve a masked URL back to the stored URL it was produced from — i.e. the
 * stored URL whose `redactRepoUrlCredential(...)` equals the incoming masked value.
 *
 * Matching by MASKED VALUE (not by `directory`) is the point: `directory` is a
 * user-editable field (the detail page lets you rename it and even auto-derives it
 * from the URL), so it is NOT a stable id. Value matching is robust to rename and
 * reorder because it keys on what the URL masked to.
 *
 * BUT the mask erases BOTH username and password, so it is not a unique key:
 * `alice:token-a@host/r` and `bob:token-b@host/r` both mask to `********@host/r`.
 * If the masked value maps to **more than one distinct** stored URL, the match is
 * AMBIGUOUS — picking one would silently graft the wrong repo's credential. In
 * that case we return `{ ambiguous: true }` so the caller refuses the update
 * rather than guess. A single distinct match resolves; no match stays unresolved.
 */
function resolveMaskedUrl(
  maskedUrl: string,
  storedUrls: string[],
): { url?: string; ambiguous: boolean } {
  const matches = storedUrls.filter((s) => redactRepoUrlCredential(s) === maskedUrl)
  const distinct = [...new Set(matches)]
  if (distinct.length > 1) return { ambiguous: true }
  return { url: distinct[0], ambiguous: false }
}

/**
 * Restore any masked repoUrl (top-level + repos[]) in an incoming Git config by
 * matching each masked value back to the stored URL it was masked from. A repoUrl
 * the user genuinely changed (non-masked) is kept as submitted. A blank/empty
 * masked URL restores from the single stored URL when unambiguous — except for
 * the top-level `repoUrl` of a multi-repo config, where blank is the shape's
 * normal value rather than a round-trip, and back-filling it would both break
 * no-op-save equality and resurrect a URL the user deliberately cleared.
 * Returns a new config; does not mutate inputs. A masked URL with NO match, or an
 * AMBIGUOUS one (the same masked value maps to two distinct stored URLs, e.g. two
 * repos on the same host with different credentials), is left as the sentinel —
 * callers must reject such an update via `unresolvableMaskedGitUrls` rather than
 * persist a corrupt or wrongly-attributed credential.
 */
export function restoreMaskedGitUrls<T extends GitUrlShape>(
  incoming: T,
  existing: GitUrlShape | undefined,
): T {
  const storedUrls = collectStoredUrls(existing)
  const restored: T = { ...incoming }

  const distinctStored = [...new Set(storedUrls)]

  /**
   * Multi-repo configs carry every URL in `repos[]` and leave the top-level
   * `repoUrl` empty by design (the form hardcodes `repoUrl: ''`). A blank there
   * is therefore a real value, not a masked round-trip, so it must not be
   * back-filled from the stored URL — see `restoreOne`.
   */
  const incomingIsMultiRepo = (incoming.repos?.length ?? 0) > 0

  const restoreOne = (url: string | undefined, allowBlankRestore: boolean): string | undefined => {
    if (url == null || url === '') {
      // Blank round-trip: recoverable only if there is exactly one stored URL —
      // and only where blank cannot be a legitimate value (see the caller).
      return allowBlankRestore && distinctStored.length === 1 ? distinctStored[0] : url
    }
    if (isMaskedRepoUrl(url)) {
      // ambiguous or no-match → resolved is undefined → keep the sentinel so
      // unresolvableMaskedGitUrls flags it and the route rejects the update
      // (never guess a credential when the masked value maps to >1 stored URL).
      return resolveMaskedUrl(url, storedUrls).url ?? url
    }
    return url // genuinely changed
  }

  if (incoming.repoUrl !== undefined) {
    restored.repoUrl = restoreOne(incoming.repoUrl, !incomingIsMultiRepo)
  }
  if (incoming.repos) {
    // A blank entry inside `repos[]` is never legitimate (`repoUrl` is `.min(1)`
    // there), so blank restoration still applies.
    restored.repos = incoming.repos.map((r) => ({
      ...r,
      repoUrl: restoreOne(r.repoUrl, true) ?? r.repoUrl,
    }))
  }
  return restored
}

/**
 * True only for the `********@host` sentinel form (userinfo username is the
 * sentinel) — NOT for blank. Distinguishes "an unrecoverable masked URL that
 * would corrupt the source if persisted" from a legitimate blank/clear.
 */
function isSentinelUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    return new URL(url).username === SCM_SECRET_MASK
  } catch {
    return false
  }
}

/**
 * Sentinel URLs (`********@host`) still present in `config` after restoration —
 * i.e. a masked value the user submitted that matched no stored URL, so the real
 * credential cannot be recovered. Persisting these would corrupt the source
 * (broken clone, lost credential), so the route must reject the update instead.
 */
export function unresolvableMaskedGitUrls(config: GitUrlShape): string[] {
  const bad: string[] = []
  if (isSentinelUrl(config.repoUrl) && config.repoUrl) bad.push(config.repoUrl)
  for (const r of config.repos ?? []) {
    if (isSentinelUrl(r.repoUrl)) bad.push(r.repoUrl)
  }
  return bad
}

function maskP4Config(config: P4Config): P4Config {
  if (!config.p4passwd) return config
  return { ...config, p4passwd: SCM_SECRET_MASK }
}

function maskGitConfig(config: GitConfig): GitConfig {
  const masked: GitConfig = { ...config }
  if (config.pat) masked.pat = SCM_SECRET_MASK
  if (config.repoUrl) masked.repoUrl = redactRepoUrlCredential(config.repoUrl)
  if (config.repos) {
    masked.repos = config.repos.map((r) => ({
      ...r,
      repoUrl: redactRepoUrlCredential(r.repoUrl),
    }))
  }
  return masked
}

/**
 * Mask credentials inside an SCM source `config` for any API read response.
 * Non-object / unknown-shape configs are returned unchanged (defence in depth:
 * never throw on a malformed row, just don't reveal secrets we can't parse).
 */
export function maskScmConfig(config: unknown): unknown {
  if (!config || typeof config !== 'object') return config
  const typed = config as Partial<ScmSourceConfig> & { type?: string }
  if (typed.type === 'p4') return maskP4Config(config as P4Config)
  if (typed.type === 'git') return maskGitConfig(config as GitConfig)
  return config
}

/**
 * Mask an entire SCM source row (or any object with a `config` field) for a read
 * response. Returns a shallow copy with the credential-bearing `config` masked;
 * all other columns pass through untouched. Safe to call on `null`/`undefined`.
 */
export function maskScmSourceRow<T extends { config?: unknown }>(
  row: T | undefined,
): T | undefined {
  if (!row || typeof row !== 'object' || !('config' in row)) return row
  return { ...row, config: maskScmConfig(row.config) }
}

/** Error text returned when a masked repo URL cannot be traced to a stored credential. */
export const UNRESOLVABLE_MASKED_URL_ERROR =
  'A masked repository URL could not be matched to a stored credential (the repo was likely renamed or the layout changed). Re-enter the full repository URL with its credentials.'

/**
 * The same refusal, worded for create mode. There is no stored row behind a
 * create, so the parenthetical about a rename or layout change describes a
 * history that cannot exist — and this is reachable in practice: the edit form
 * renders the masked value into the repoUrl input, so copying a URL out of an
 * existing source and into the create form lands exactly here.
 */
export const MASKED_URL_WITHOUT_SOURCE_ERROR =
  'This repository URL still contains the masked credential placeholder. Re-enter the full repository URL with its real credentials.'

export type RehydrateResult = { ok: true; config: ScmSourceConfig } | { ok: false; error: string }

/** Error text returned when a restored credential would be sent to a new endpoint. */
export const ENDPOINT_CHANGED_ERROR =
  'The connection address changed, so the saved credential cannot be reused for this test. Re-enter the credential for the new address.'

export interface RehydrateOptions {
  /**
   * Bind a restored credential to the endpoint it was stored against: refuse
   * rather than resolve when the submitted config points somewhere else.
   *
   * Required by any caller that DIALS OUT with the result (`POST /probe`).
   * Restoration is keyed only on "the secret is masked", so without this the
   * caller chooses both the credential (by `sourceId`) and the destination (by
   * body) independently — pointing a stored PAT at an arbitrary host turns a
   * read-only probe into a credential exfiltration primitive. That matters even
   * within the trusted-colleague model: `getOwnerFilter` returns undefined for
   * admins, and the mask is deliberately applied to admins too, so an
   * unbound probe would hand any admin every user's PAT / P4 password through a
   * request that writes no row and leaves no trace.
   *
   * The save path (`PATCH /:id`) leaves this off on purpose: re-pointing a
   * source at a moved repository while keeping its credential is a legitimate
   * edit, and it is persisted and audited rather than dialed out.
   */
  requireSameEndpoint?: boolean
}

/**
 * Identity of a git endpoint for credential-binding purposes: scheme + host +
 * path, with userinfo dropped (it is what the mask erases) and the `.git` suffix
 * and trailing slashes normalized so cosmetic spellings of one repo still match.
 * Port is part of host.
 *
 * Scheme is included, and deliberately so: it selects the transport, not just a
 * spelling. `buildAuthUrlFromParts` embeds the PAT into any `https://` URL, so
 * treating `ssh://host/r` and `https://host/r` as one identity would let a
 * source keyed on SSH have its stored PAT replayed over HTTPS — and `http://`
 * is a strictly weaker channel to the same host. A non-URL (scp-style) string
 * has no parse, so it compares literally, which is stricter still.
 */
function gitEndpointIdentity(repoUrl: string): string {
  try {
    const parsed = new URL(repoUrl)
    const path = parsed.pathname.replace(/\.git$/, '').replace(/\/+$/, '')
    return `${parsed.protocol}//${parsed.host}${path}`.toLowerCase()
  } catch {
    return repoUrl
      .trim()
      .replace(/\.git$/, '')
      .toLowerCase()
  }
}

/** Every git endpoint the config points at (top-level + repos[]), non-blank only. */
function collectEndpoints(config: GitUrlShape): string[] {
  const urls: string[] = []
  if (config.repoUrl) urls.push(config.repoUrl)
  for (const r of config.repos ?? []) if (r.repoUrl) urls.push(r.repoUrl)
  return urls.map(gitEndpointIdentity)
}

/**
 * True when the stored git config holds a credential that endpoint binding is
 * there to protect — either a `pat` or one embedded in a stored URL's userinfo.
 * With nothing to leak, binding would only block legitimate probes.
 */
function storedHasGitSecret(stored: GitConfig | undefined): boolean {
  if (!stored) return false
  if (stored.pat) return true
  return collectStoredUrls(stored).some((url) => {
    try {
      return Boolean(new URL(url).password)
    } catch {
      return false // scp-style carries no inline password
    }
  })
}

/** True when any URL in the incoming config is a masked round-trip to resolve. */
function hasMaskedGitUrl(config: GitUrlShape): boolean {
  if (isMaskedRepoUrl(config.repoUrl)) return true
  return (config.repos ?? []).some((r) => isMaskedRepoUrl(r.repoUrl))
}

/**
 * True when every endpoint the incoming config dials is one the stored config
 * already pointed at. A subset (not an exact match) is the right test: probing
 * one repo of a multi-repo source, or dropping a repo, is legitimate — only
 * reaching an endpoint the stored credential was never issued for is not.
 */
function endpointsAreStored(incoming: GitConfig, stored: GitConfig | undefined): boolean {
  const storedEndpoints = new Set(collectEndpoints(stored ?? {}))
  return collectEndpoints(incoming).every((endpoint) => storedEndpoints.has(endpoint))
}

/**
 * Restore the real credentials behind an incoming config's masked placeholders.
 *
 * Reads mask stored secrets, so any form that loaded a source round-trips the
 * sentinel (or a blank) back on submit — that means "keep the stored secret",
 * never "overwrite it with the placeholder". Applies to P4 `p4passwd`, Git `pat`,
 * and credentials embedded in `repoUrl` / `repos[].repoUrl`.
 *
 * `existing` is the stored config, or undefined when there is nothing to restore
 * from (creating a source, or probing an unsaved one). A stored config of a
 * **different type** is ignored for the same reason: its secrets do not belong
 * to the submitted shape. Note that "nothing to restore from" does NOT mean the
 * config passes through untouched — a submitted sentinel is still stripped, and
 * a sentinel-bearing `repoUrl` is still refused, because neither can be resolved
 * into a real credential and both would corrupt the source if kept.
 *
 * Shared by all three write/dial paths — `POST /` and `PATCH /:id` (before
 * persisting) and `POST /probe` (before dialing out) — so they resolve
 * credentials identically, except that probe additionally passes
 * `requireSameEndpoint`; see `RehydrateOptions`.
 */
export function rehydrateScmConfigSecrets(
  incoming: ScmSourceConfig,
  existing: ScmSourceConfig | undefined,
  options: RehydrateOptions = {},
): RehydrateResult {
  const storedSameType = existing?.type === incoming.type ? existing : undefined
  const bindEndpoint = options.requireSameEndpoint === true

  if (incoming.type === 'p4') {
    const stored = storedSameType as P4Config | undefined
    if (isMaskedOrBlank(incoming.p4passwd)) {
      // A P4 password is issued for a (server, user) pair — both must be intact
      // before it may be replayed at a caller-supplied address.
      if (
        stored?.p4passwd &&
        bindEndpoint &&
        (incoming.p4port !== stored.p4port || incoming.p4user !== stored.p4user)
      ) {
        return { ok: false, error: ENDPOINT_CHANGED_ERROR }
      }
      // `p4passwd` is `.default('')` in the schema, so its "no credential" value
      // is the empty string rather than undefined (unlike git's optional `pat`).
      return {
        ok: true,
        config: {
          ...incoming,
          type: 'p4',
          p4passwd: resolveMaskedSecret(incoming.p4passwd, stored?.p4passwd) ?? '',
        },
      }
    }
    return { ok: true, config: incoming }
  }

  const stored = storedSameType as GitConfig | undefined
  let config = incoming as GitConfig
  // Guard the whole config, not just the branch that restores `pat`. A stored
  // secret can also ride in a `repoUrl`'s userinfo, which `restoreMaskedGitUrls`
  // below resolves regardless of what `pat` was submitted — so scoping this to
  // the pat branch would leave safety resting on how `checkGitConnection`
  // happens to choose between `repoUrl` and `repos[]`, which is not this
  // module's invariant to depend on.
  //
  // Scoped to configs that would actually pull a stored secret forward: either
  // the pat is masked (so `stored.pat` fills it in) or a URL is masked (so
  // `restoreMaskedGitUrls` resolves stored userinfo). A fully self-supplied
  // config restores nothing, so there is no stored credential to misdirect and
  // typing a fresh PAT for a new host stays legitimate.
  const wouldRestoreSecret =
    storedHasGitSecret(stored) &&
    (isMaskedOrBlank(config.pat) || hasMaskedGitUrl(config as GitUrlShape))
  if (bindEndpoint && wouldRestoreSecret && !endpointsAreStored(config, stored)) {
    return { ok: false, error: ENDPOINT_CHANGED_ERROR }
  }
  config = withOptionalSecret(config, 'pat', resolveMaskedSecret(config.pat, stored?.pat))
  // Restore any masked repoUrl / repos[].repoUrl by matching each masked value
  // back to the stored URL it was masked from (robust to directory rename /
  // reorder / single↔multi switch — `directory` is user-editable, not a key).
  config = restoreMaskedGitUrls(config, stored)
  // A masked URL that matched no stored URL cannot be recovered; refuse rather
  // than act on `********@host`, which would drop the real credential. With no
  // stored config at all there was never a URL to match against, so the wording
  // must not blame a rename that could not have happened.
  if (unresolvableMaskedGitUrls(config).length > 0) {
    return {
      ok: false,
      error: stored ? UNRESOLVABLE_MASKED_URL_ERROR : MASKED_URL_WITHOUT_SOURCE_ERROR,
    }
  }
  // GitConfig carries no `type`; the config union discriminates on it.
  return { ok: true, config: { ...config, type: 'git' } }
}

/**
 * Order-independent structural equality for two SCM config objects. Plain
 * `JSON.stringify` comparison is key-order sensitive, so resubmitting an
 * identical config with a different key order (which the request-parse + secret
 * rehydration naturally produces) would falsely read as a change and reset sync
 * bookkeeping. Configs are shallow-to-moderate JSON, so a stable-key stringify
 * is sufficient and cheap.
 */
export function scmConfigEquals(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(',')}}`
}
