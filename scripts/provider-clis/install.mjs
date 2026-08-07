#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const defaultLockPath = resolve(scriptDir, '../../provider-cli-lock.json')
const defaultLockSchemaPath = resolve(scriptDir, 'provider-cli-lock.schema.json')
/**
 * Root-owned layout used when no `--install-root` is given. Kept as the default so
 * an image build (which runs as root) and any existing caller behave exactly as
 * before. The API installs at runtime as a non-root service user, which cannot
 * write either of these paths, so it always passes an explicit root inside the
 * persisted service HOME.
 */
const DEFAULT_ARCHIVE_DIR = '/opt/provider-clis'
const DEFAULT_BIN_DIR = '/usr/local/bin'
/**
 * Parent directory of the per-kind npm prefixes on the default (no
 * `--install-root`) layout.
 *
 * Deliberately an installer-owned directory next to DEFAULT_ARCHIVE_DIR, NOT
 * npm's built-in `/usr/local` prefix. Promotion recursively deletes the prefix
 * it replaces, so pointing this at a system-shared directory would have deleted
 * Node, npm, p4, uv and everything else living under `/usr/local`. The bin
 * symlink still lands in DEFAULT_BIN_DIR (`/usr/local/bin`), so what ends up on
 * PATH is unchanged — only the directory the installer owns and may delete.
 */
const DEFAULT_NPM_ROOT = '/opt/provider-clis-npm'
/**
 * Download flags. The timeouts matter for the runtime installer: without them a
 * stalled connection holds the per-kind install lock forever, leaving the CLI
 * permanently stuck in `installing`. --retry covers a transient blip.
 */
const CURL_TIMEOUT_ARGS = ['-fsSL', '--connect-timeout', '30', '--max-time', '900', '--retry', '2']
const exactVersionPattern = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/
const checksumPattern = /^[a-f0-9]{64}$/
const npmIntegrityPattern = /^sha512-[A-Za-z0-9+/]+={0,2}$/

/**
 * Characters that mean "the version token continues here".
 *
 * Alphanumerics and `+`/`-` always continue a version, so a neighbouring one
 * means the match landed inside a longer token: this is what stops
 * `2026.07.16-899851bad` from satisfying Cursor's locked `2026.07.16-899851b`
 * (a git short-SHA suffix), and `12.1.212` / `2.1.2120` from satisfying
 * `2.1.212`.
 *
 * A dot is deliberately NOT in this set on its own. Copilot prints
 * `GitHub Copilot CLI 1.0.71.` — a sentence-ending period — and treating a bare
 * trailing dot as a continuation rejected that real, correct output outright.
 * A dot only continues a version when another version character follows it
 * (`1.0.71.5`), which VERSION_CONTINUES_RIGHT encodes.
 */
const VERSION_TOKEN_RE = /[A-Za-z0-9][A-Za-z0-9.+-]*/g

/**
 * Whether a CLI's `--version` output reports the expected version.
 *
 * Tokenises the output and compares whole tokens, rather than substring-matching
 * with lookarounds. Substring matching kept producing boundary bugs in both
 * directions: `includes()` let `12.1.212` and `2.1.2120` satisfy `2.1.212`, and
 * a character-class boundary that fixed those then rejected Copilot's real
 * `GitHub Copilot CLI 1.0.71.` (the trailing period read as a continuation) and
 * still accepted `1.2.1.212`. Comparing tokens has no such edge: a token is
 * delimited by anything that is not part of a version, and only an exact token
 * match counts.
 *
 * Trailing sentence punctuation is stripped from each token, so `1.0.71.` still
 * matches `1.0.71` while `1.0.71.5` (a genuinely different version) does not.
 *
 * Mirrored by `versionOutputMatches` in apps/api/src/lib/cli-installer.ts, which
 * applies the same rule to the post-install probe and to `matchesLock`.
 */
export function versionOutputMatches(output, expected) {
  for (const token of output.match(VERSION_TOKEN_RE) ?? []) {
    // A version never legitimately ends in a dot, so a trailing one is sentence
    // punctuation rather than part of the version.
    if (token.replace(/\.+$/, '') === expected) return true
  }
  return false
}

function fail(message) {
  throw new Error(`[provider-clis] ${message}`)
}

function requireString(value, path) {
  if (typeof value !== 'string' || !value.trim()) fail(`${path} must be a non-empty string`)
}

/**
 * Reject a path component that could escape the directory it is joined onto.
 *
 * `binary` and `binaryPath` are joined onto the install root and then passed to
 * `rmSync` / `symlinkSync`, so a value like `../../x` would let a malformed lock
 * delete or link outside the root. The committed lock is safe; this makes a bad
 * edit fail loudly at validation instead of at `rm` time.
 */
function requireContainedPath(value, path, { allowSubdirs = false } = {}) {
  requireString(value, path)
  if (value.startsWith('/')) fail(`${path} must be relative, received ${value}`)
  const segments = value.split('/')
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    fail(`${path} must not contain "." or ".." segments, received ${value}`)
  }
  if (!allowSubdirs && segments.length > 1) {
    fail(`${path} must be a bare file name, received ${value}`)
  }
}

function requireHttpsArchiveUrl(value, path) {
  requireString(value, path)
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    fail(`${path} archive URL must be valid and use HTTPS`)
  }
  if (parsed.protocol !== 'https:') fail(`${path} archive URL must use HTTPS`)
}

export function loadSupportedProviderKinds(schemaPath = defaultLockSchemaPath) {
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
  const kinds = schema?.properties?.providers?.items?.properties?.kind?.enum
  if (
    !Array.isArray(kinds) ||
    kinds.length === 0 ||
    kinds.some((kind) => typeof kind !== 'string' || !kind.trim())
  ) {
    fail('lock schema must declare a non-empty Provider kind enum')
  }
  return new Set(kinds)
}

/** Kinds allowed in the non-Provider `tools` array. */
export function loadSupportedToolKinds(schemaPath = defaultLockSchemaPath) {
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
  const kinds = schema?.properties?.tools?.items?.properties?.kind?.enum
  return new Set(Array.isArray(kinds) ? kinds : [])
}

/**
 * Validate one entry. Shared by `providers` and `tools` so a managed tool gets
 * exactly the same version pinning and checksum guarantees a Provider CLI does.
 */
function validateEntry(provider, path, allowedKinds, label, seen) {
  requireString(provider.kind, `${path}.kind`)
  if (!allowedKinds.has(provider.kind)) {
    fail(`unsupported ${label} kind: ${provider.kind}`)
  }
  if (seen.has(provider.kind)) fail(`duplicate ${label} kind: ${provider.kind}`)
  seen.add(provider.kind)
  requireString(provider.version, `${path}.version`)
  if (!exactVersionPattern.test(provider.version)) {
    fail(`${path}.version must be exact, received ${provider.version}`)
  }
  requireContainedPath(provider.binary, `${path}.binary`)
  requireString(provider.expectedVersionOutput, `${path}.expectedVersionOutput`)
  if (!Array.isArray(provider.versionArgs)) fail(`${path}.versionArgs must be an array`)

  if (provider.install?.type === 'npm') {
    requireString(provider.install.package, `${path}.install.package`)
    requireString(provider.install.tarball, `${path}.install.tarball`)
    if (!provider.install.tarball.startsWith('https://registry.npmjs.org/')) {
      fail(`${path}.install.tarball must use the npmjs registry over HTTPS`)
    }
    if (!npmIntegrityPattern.test(provider.install.integrity ?? '')) {
      fail(`${path}.install.integrity must be a SHA-512 SRI digest`)
    }
    if (typeof provider.install.allowScripts !== 'boolean') {
      fail(`${path}.install.allowScripts must be a boolean`)
    }
    return
  }
  if (provider.install?.type !== 'archive') fail(`${path}.install.type is unsupported`)
  if (!Number.isInteger(provider.install.stripComponents) || provider.install.stripComponents < 0) {
    fail(`${path}.install.stripComponents must be a non-negative integer`)
  }
  requireContainedPath(provider.install.binaryPath, `${path}.install.binaryPath`, {
    allowSubdirs: true,
  })
  if (!provider.install.targets || typeof provider.install.targets !== 'object') {
    fail(`${path}.install.targets must be an object`)
  }
  for (const [targetName, target] of Object.entries(provider.install.targets)) {
    requireHttpsArchiveUrl(target.url, `${path}.install.targets.${targetName}.url`)
    if (!checksumPattern.test(target.sha256 ?? '')) {
      fail(`${path}.install.targets.${targetName}.sha256 must be a SHA-256 checksum`)
    }
  }
}

export function loadAndValidateLock(lockPath = defaultLockPath) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  if (lock.schemaVersion !== 2) fail('schemaVersion must be 2')
  if (!Array.isArray(lock.providers) || lock.providers.length === 0) {
    fail('providers must be a non-empty array')
  }

  const providerKinds = loadSupportedProviderKinds()
  const seenProviders = new Set()
  for (const [index, provider] of lock.providers.entries()) {
    validateEntry(provider, `providers[${index}]`, providerKinds, 'Provider', seenProviders)
  }

  // `tools` is optional and holds CLIs a2wave installs that are not Providers
  // (CodeGraph indexes SCM sources and has no Provider record). Kept separate so
  // the Provider-kind contract across shared/zod/drizzle/schema stays exact.
  if (lock.tools !== undefined) {
    if (!Array.isArray(lock.tools)) fail('tools must be an array')
    const toolKinds = loadSupportedToolKinds()
    const seenTools = new Set()
    for (const [index, tool] of lock.tools.entries()) {
      validateEntry(tool, `tools[${index}]`, toolKinds, 'tool', seenTools)
    }
  }
  return lock
}

/** Every managed CLI: Provider CLIs plus non-Provider tools. */
export function allLockEntries(lock) {
  return [...lock.providers, ...(lock.tools ?? [])]
}

export function resolveArchiveTarget(provider, os, arch) {
  if (provider.install.type !== 'archive') fail(`${provider.kind} is not archive-installed`)
  const key = `${os}-${arch}`
  const target = provider.install.targets[key]
  if (!target) fail(`${provider.kind} has no archive target for ${key}`)
  return target
}

/**
 * Resolve where binaries, npm packages, and unpacked archives go.
 *
 * `installRoot` is a single directory the caller must be able to write; the
 * npm/archive/bin subdirectories are derived from it so a caller never has to
 * keep three paths in sync. Omitting it keeps the historical root-owned layout.
 */
export function resolveInstallLayout(installRoot) {
  if (!installRoot) {
    return {
      binDir: DEFAULT_BIN_DIR,
      archiveDir: DEFAULT_ARCHIVE_DIR,
      // Installer-owned even on the default layout. This must NOT be a
      // system-shared prefix such as `/usr/local`: installNpmProvider promotes a
      // per-kind prefix by recursively deleting the old one, and pointing that at
      // `/usr/local` would delete Node, npm and every other tool in the image.
      npmRoot: DEFAULT_NPM_ROOT,
    }
  }
  const root = resolve(installRoot)
  return {
    // Parent of the per-kind npm prefixes (`<npmRoot>/<kind>`), not a prefix
    // itself: `npm install --global` writes `lib/`, `bin/`, `include/` and
    // `share/` into whichever prefix it is given, so two CLIs sharing one prefix
    // cannot be promoted independently.
    npmRoot: join(root, 'npm'),
    binDir: join(root, 'bin'),
    archiveDir: join(root, 'opt'),
  }
}

/**
 * Environment variables an npm subprocess legitimately needs.
 *
 * This is an allowlist, not a denylist, and that is the whole point: the API
 * process holds AUTH_SECRET, SCM PATs/P4 passwords, SSO client secrets and every
 * Provider credential, and three locked packages (claude-code / opencode / qoder)
 * run install lifecycle scripts. Passing `process.env` through would hand all of
 * those to third-party `postinstall` code — and the installer even records
 * subprocess output into `cli_installations.last_output`, so a leak would be
 * persisted and rendered to admins. Checksum-verifying the tarball proves the
 * bytes match the lock; it says nothing about what those bytes then read.
 *
 * A denylist would leak every variable added later, so anything not named here
 * simply does not reach the child. Prefixes cover the npm/proxy/CA families whose
 * exact names vary (`npm_config_*`, `NODE_EXTRA_CA_CERTS`, …).
 */
const NPM_ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'TZ',
  'TERM',
  // npm/node runtime knobs that must survive for installs to work at all.
  'NPM_CONFIG_PREFIX',
  'NPM_CONFIG_CACHE',
  'NPM_CONFIG_REGISTRY',
  'NPM_CONFIG_USERCONFIG',
  'NPM_CONFIG_GLOBALCONFIG',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  // Corporate egress: without these an intranet deployment cannot reach the
  // registry at all.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'ALL_PROXY',
  'all_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CURL_CA_BUNDLE',
])

/**
 * Credential-bearing npm config, rejected even though the surrounding name looks
 * innocuous.
 *
 * There is deliberately no `npm_config_*` wildcard: that namespace maps onto
 * *any* npm config key, including `_auth`, `_authToken`, `password`, `certfile`
 * and `//registry.example/:_authToken`. Allowing the prefix wholesale would have
 * handed registry credentials to every `allowScripts: true` package — the exact
 * class of leak this function exists to prevent. Only the specific keys named in
 * NPM_ENV_ALLOWLIST get through, and these patterns are a second line of defence
 * in case one is ever added carelessly.
 */
const NPM_ENV_CREDENTIAL_PATTERNS = [
  /auth/i,
  /token/i,
  /password/i,
  /passwd/i,
  /secret/i,
  /credential/i,
  /private[-_]?key/i,
  /certfile/i,
  /keyfile/i,
  // `//registry.npmjs.org/:_authToken=...` style per-registry credentials.
  /^\/\//,
]

/**
 * Any URL-shaped value carrying userinfo (`scheme://user:pass@host`, or the
 * bare `user:pass@host:port` form curl/npm both also accept for a proxy) is a
 * credential, so every allowlisted value is sanitized by *shape* rather than by
 * which variable name it happened to arrive under. Naming only `HTTP(S)_PROXY`
 * as needing this treatment missed `NPM_CONFIG_REGISTRY`, which is exactly as
 * capable of carrying `https://user:token@registry.corp/` — checking by name
 * category will always miss the next URL-shaped variable added to the
 * allowlist, so every value is treated the same way regardless of which key
 * it is on.
 *
 * Returns the value unchanged when it carries no userinfo, the userinfo-free
 * form when it does, and `null` when a scheme-less `user:pass@host` cannot be
 * parsed with any confidence — such a value is dropped rather than guessed at.
 */
function stripUrlUserinfo(value) {
  // Only a `scheme://...` (double slash) reliably parses as an authority-based
  // URL where `.username`/`.password` are populated. Without the `//` check,
  // `new URL('user:pass@host:3128')` parses "succeeds" by treating `user:` as
  // an opaque custom scheme (like `mailto:`) — `.username`/`.password` come
  // back empty and userinfo silently survives unstripped. Confirmed with
  // Node's own URL parser before relying on this.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const parsed = new URL(value)
      if (!parsed.username && !parsed.password) return value
      parsed.username = ''
      parsed.password = ''
      return parsed.toString()
    } catch {
      // Malformed despite matching the scheme:// shape; fall through to the
      // bare-form attempt below rather than assume it is safe.
    }
  }

  const bareMatch = value.match(/^([^:/@]+):([^@/]+)@(.+)$/)
  if (!bareMatch) return value
  const [, , , hostAndRest] = bareMatch
  // A scheme-less value with userinfo syntax is a proxy address (npm/curl both
  // accept `user:pass@host:port`); anything else matching this shape is
  // ambiguous enough that guessing wrong would leak a credential, so it is
  // dropped instead of passed through partially sanitized.
  return /^[\w.-]+(:\d+)?\/?$/.test(hostAndRest) ? hostAndRest : null
}

/**
 * Strip everything but the allowlisted variables, so a package's lifecycle
 * scripts cannot read the service's credentials.
 */
export function buildNpmSubprocessEnv(sourceEnv = process.env, overrides = {}) {
  const safeEnv = {}
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) continue
    if (!NPM_ENV_ALLOWLIST.has(key)) continue
    if (NPM_ENV_CREDENTIAL_PATTERNS.some((pattern) => pattern.test(key))) continue
    // Every allowlisted value is sanitized the same way regardless of which
    // variable it is on — see stripUrlUserinfo for why this cannot be scoped
    // to a fixed list of "proxy-shaped" variable names.
    const sanitized = stripUrlUserinfo(value)
    if (sanitized !== null) safeEnv[key] = sanitized
  }
  return { ...safeEnv, ...overrides }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.capture || options.onLog ? 'pipe' : 'inherit',
    env: options.env ?? process.env,
  })
  if (result.error) fail(`${command} failed to start: ${result.error.message}`)
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (options.onLog && output) options.onLog(output)
  if (result.status !== 0) {
    const detail = options.capture || options.onLog ? `: ${output}` : ''
    fail(`${command} exited with ${result.status}${detail}`)
  }
  return output
}

/**
 * Async twin of `run`, for callers that must not block their event loop.
 *
 * The CLI entry point below is a short-lived script where `spawnSync` is simply
 * simpler, but the API imports this module inside a long-running server: a
 * `spawnSync` download of a 300MB CLI blocks Node entirely for ~12s, stalling
 * every request and failing the container's 5s HEALTHCHECK mid-install.
 */
function runAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env ?? process.env,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', (error) =>
      reject(new Error(`[provider-clis] ${command} failed to start: ${error.message}`)),
    )
    child.once('close', (code) => {
      const output = `${stdout}${stderr}`.trim()
      if (options.onLog && output) options.onLog(output)
      if (code !== 0) {
        reject(new Error(`[provider-clis] ${command} exited with ${code}: ${output}`))
        return
      }
      resolve(output)
    })
  })
}

function verifyProvider(provider) {
  const output = run(provider.binary, provider.versionArgs, { capture: true })
  if (!versionOutputMatches(output, provider.expectedVersionOutput)) {
    fail(
      `${provider.kind} version mismatch: expected output containing ` +
        `${provider.expectedVersionOutput}, received ${output}`,
    )
  }
  process.stdout.write(`[provider-clis] verified ${provider.kind} ${provider.version}\n`)
}

export function buildNpmInstallArgs(provider, archivePath) {
  if (provider.install.type !== 'npm') fail(`${provider.kind} is not npm-installed`)
  return [
    'install',
    '--global',
    '--no-audit',
    '--no-fund',
    ...(provider.install.allowScripts ? [] : ['--ignore-scripts']),
    archivePath,
  ]
}

export function verifyNpmArchiveIntegrity(kind, archivePath, expectedIntegrity) {
  const actualIntegrity = `sha512-${createHash('sha512')
    .update(readFileSync(archivePath))
    .digest('base64')}`
  if (actualIntegrity !== expectedIntegrity) {
    fail(
      `${kind} npm archive integrity mismatch: expected ` +
        `${expectedIntegrity}, got ${actualIntegrity}`,
    )
  }
}

/**
 * Resolve the binary an npm-installed CLI drops on PATH, inside a given prefix.
 *
 * npm places bin symlinks at `<prefix>/bin/<name>` (POSIX) regardless of the
 * package's internal layout, so this does not need to inspect the package.
 */
function npmBinaryPath(prefix, binaryName) {
  return join(prefix, 'bin', binaryName)
}

/**
 * Recursively delete a directory, but only after proving it sits strictly inside
 * a directory the installer owns.
 *
 * Promotion has to remove the directory it replaces, and getting that target
 * wrong is catastrophic rather than merely buggy: an earlier version pointed the
 * npm prefix at the shared `/usr/local` and would have deleted Node, npm and
 * every other tool in the image. Requiring the caller to name the owning root,
 * and refusing anything that is not strictly beneath it, makes that class of
 * mistake fail loudly instead of silently wiping a system directory.
 */
function removeOwnedDir(target, ownedRoot) {
  const resolvedTarget = resolve(target)
  const resolvedRoot = resolve(ownedRoot)
  if (resolvedTarget === resolvedRoot || !resolvedTarget.startsWith(`${resolvedRoot}/`)) {
    fail(
      `refusing to remove ${resolvedTarget}: not strictly inside the installer-owned ${resolvedRoot}`,
    )
  }
  rmSync(resolvedTarget, { recursive: true, force: true })
}

/**
 * Replace a symlink atomically.
 *
 * `rmSync` + `symlinkSync` leaves a window with no link at all, so a crash in
 * between takes a previously-working CLI off PATH. Building the new link under a
 * temporary name and renaming it over the old one has no such window.
 */
function atomicSymlink(target, linkPath) {
  const linkStagingPath = `${linkPath}.tmp-${process.pid}-${Date.now()}`
  rmSync(linkStagingPath, { force: true })
  mkdirSync(dirname(linkPath), { recursive: true })
  symlinkSync(target, linkStagingPath)
  renameSync(linkStagingPath, linkPath)
}

async function installNpmProvider(provider, layout, options = {}) {
  const exec = options.exec ?? run
  const workDir = mkdtempSync(join(tmpdir(), `a2wave-${provider.kind}-`))
  const archivePath = join(workDir, 'package.tgz')
  // Each npm CLI gets its OWN prefix, `<npmRoot>/<kind>`, and never shares one.
  //
  // A single shared prefix cannot be the unit of staged promotion: `npm install`
  // into an empty staging prefix contains only the current package, so promoting
  // it over a shared prefix deletes every other CLI installed there (verified:
  // installing codex after claude-code removed claude-code). With the default
  // root-owned layout that shared prefix is `/usr/local`, so the same
  // `rmSync(prefix)` would have deleted Node, npm and every other tool in the
  // image. Per-kind prefixes make the promoted directory genuinely owned by this
  // one package, so the recursive delete can only ever remove this CLI's own
  // previous copy.
  const realPrefix = join(layout.npmRoot, provider.kind)
  const stagingPrefix = `${realPrefix}.tmp-${process.pid}-${Date.now()}`
  // The per-kind prefix is not itself on PATH (that would need one PATH entry
  // per CLI); a symlink in the shared bin dir is what PATH resolves, exactly as
  // installArchiveProvider already does for its versioned directories.
  const linkPath = join(layout.binDir, provider.binary)
  try {
    await exec('curl', [...CURL_TIMEOUT_ARGS, provider.install.tarball, '-o', archivePath], options)
    verifyNpmArchiveIntegrity(provider.kind, archivePath, provider.install.integrity)
    // Minimal env: the three lock entries with allowScripts:true run third-party
    // lifecycle scripts, which must never see the service's credentials.
    // A per-install npm cache, inside the same throwaway workDir. Two installs
    // for different kinds run concurrently (the API locks per kind), and sharing
    // one cache made them race: `npm install` reported success having written
    // only the top-level package ("added 1 package"), silently skipping the
    // platform-specific optionalDependencies that carry the actual binary, so
    // the staged binary then failed with "Missing optional dependency". Isolating
    // the cache costs a cold download per install and removes the interference.
    const env = buildNpmSubprocessEnv(options.env ?? process.env, {
      NPM_CONFIG_PREFIX: stagingPrefix,
      NPM_CONFIG_CACHE: join(workDir, 'npm-cache'),
    })
    rmSync(stagingPrefix, { recursive: true, force: true })
    mkdirSync(stagingPrefix, { recursive: true })
    await exec('npm', buildNpmInstallArgs(provider, archivePath), { ...options, env })

    const stagedBinaryPath = npmBinaryPath(stagingPrefix, provider.binary)
    // Same reasoning as the archive path: verify the version the staged binary
    // actually reports, before promotion, using the same exec (sync for the CLI
    // build, async for the API) so this cannot reintroduce the event-loop stall
    // the async path exists to avoid.
    const stagedVersionOutput = await exec(stagedBinaryPath, provider.versionArgs, {
      capture: true,
      env,
    })
    if (!versionOutputMatches(stagedVersionOutput, provider.expectedVersionOutput)) {
      fail(
        `${provider.kind} staged npm install reports ${JSON.stringify(
          stagedVersionOutput.split('\n')[0] ?? '',
        )} but the lock expects output containing "${provider.expectedVersionOutput}"`,
      )
    }

    removeOwnedDir(realPrefix, layout.npmRoot)
    // Same-filesystem rename (stagingPrefix is always `${realPrefix}.tmp-...`),
    // so this CLI's prefix appears atomically and its previous copy is only
    // removed after the replacement already verified. The window between the
    // delete and the rename can only affect this one CLI, and the caller retries
    // by reinstalling the same kind.
    renameSync(stagingPrefix, realPrefix)
    atomicSymlink(npmBinaryPath(realPrefix, provider.binary), linkPath)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
    rmSync(stagingPrefix, { recursive: true, force: true })
  }
}

async function installArchiveProvider(provider, target, layout, options = {}) {
  const exec = options.exec ?? run
  const workDir = mkdtempSync(join(tmpdir(), `a2wave-${provider.kind}-`))
  const archivePath = join(workDir, 'package.tar.gz')
  const installDir = join(layout.archiveDir, provider.kind, provider.version)
  // Extract next to the real target rather than into it, so a crash mid-`tar`
  // (kill -9, OOM, container restart) leaves an orphaned `.tmp` directory instead
  // of a half-extracted tree sitting at the path a symlink can point to and
  // `--version` might still happen to pass against. `renameSync` on the same
  // filesystem is atomic, so `installDir` only ever exists fully populated.
  const stagingDir = `${installDir}.tmp-${process.pid}-${Date.now()}`
  try {
    await exec('curl', [...CURL_TIMEOUT_ARGS, target.url, '-o', archivePath], options)
    const actualChecksum = createHash('sha256').update(readFileSync(archivePath)).digest('hex')
    if (actualChecksum !== target.sha256) {
      fail(
        `${provider.kind} archive checksum mismatch: expected ${target.sha256}, got ${actualChecksum}`,
      )
    }

    rmSync(stagingDir, { recursive: true, force: true })
    mkdirSync(stagingDir, { recursive: true })
    await exec(
      'tar',
      [
        `--strip-components=${provider.install.stripComponents}`,
        '-xzf',
        archivePath,
        '-C',
        stagingDir,
      ],
      options,
    )

    const stagedBinaryPath = join(stagingDir, provider.install.binaryPath)
    chmodSync(stagedBinaryPath, 0o755)
    // Verified in place, before the rename: an unreadable/missing binary inside
    // the staged tree must fail here and leave `installDir` (the previous good
    // version, if any) completely untouched. Uses the same `exec` as the download
    // (sync for the CLI build, async for the API) — a synchronous version probe
    // here would reintroduce the event-loop stall the async path exists to avoid.
    const stagedVersionOutput = await exec(stagedBinaryPath, provider.versionArgs, {
      capture: true,
    })
    // Check the *version*, not merely that the binary exits 0 — and do it before
    // promotion. Verifying only after the rename means a wrong build has already
    // replaced the working install and taken over the PATH symlink, with nothing
    // left to roll back to. Bounded match so `12.1.212` cannot satisfy `2.1.212`.
    if (!versionOutputMatches(stagedVersionOutput, provider.expectedVersionOutput)) {
      fail(
        `${provider.kind} staged binary reports ${JSON.stringify(
          stagedVersionOutput.split('\n')[0] ?? '',
        )} but the lock expects output containing "${provider.expectedVersionOutput}"`,
      )
    }

    removeOwnedDir(installDir, layout.archiveDir)
    // Same-filesystem rename (installDir is always <archiveDir>/<kind>/<version>.tmp-...,
    // so this never crosses a mount) — the directory tree appears atomically.
    renameSync(stagingDir, installDir)

    const binaryPath = join(installDir, provider.install.binaryPath)
    atomicSymlink(binaryPath, join(layout.binDir, provider.binary))
  } finally {
    rmSync(workDir, { recursive: true, force: true })
    rmSync(stagingDir, { recursive: true, force: true })
  }
}

/**
 * Install one Provider CLI. This is the entry point the API calls at runtime;
 * the command-line `main()` below is a thin loop over it.
 *
 * `verifyProvider` is deliberately NOT called here: it resolves the binary via
 * PATH, which the caller's process may not have pointed at `layout.binDir` yet.
 * Runtime callers verify separately through their own version probe.
 */
export async function installProvider(provider, options = {}) {
  const layout = resolveInstallLayout(options.installRoot)
  // `exec: runAsync` keeps a long download off the caller's event loop; the CLI
  // entry point below omits it and gets the simpler synchronous path.
  const runOptions = { onLog: options.onLog, env: options.env, exec: options.exec }
  if (provider.install.type === 'npm') {
    await installNpmProvider(provider, layout, runOptions)
    return layout
  }
  const target = resolveArchiveTarget(
    provider,
    options.targetOs ?? 'linux',
    options.targetArch ?? (process.arch === 'arm64' ? 'arm64' : 'amd64'),
  )
  await installArchiveProvider(provider, target, layout, runOptions)
  return layout
}

/** Event-loop-friendly `installProvider`, for use inside the long-running API. */
export function installProviderAsync(provider, options = {}) {
  return installProvider(provider, { ...options, exec: runAsync })
}

/**
 * Remove a Provider CLI's files. Archive installs own a versioned directory plus
 * a bin symlink; npm installs are removed by npm itself so its own bookkeeping
 * under the prefix stays consistent.
 */
export async function uninstallProvider(provider, options = {}) {
  const layout = resolveInstallLayout(options.installRoot)
  if (provider.install.type === 'npm') {
    // Per-kind prefixes make this a plain directory removal: the prefix contains
    // only this CLI, so deleting it cannot disturb another one. This deliberately
    // no longer shells out to `npm uninstall --global` — that only made sense
    // while every CLI shared one prefix and npm's own bookkeeping had to stay
    // consistent, and it also meant a third-party `preuninstall` script ran with
    // whatever env we handed npm.
    removeOwnedDir(join(layout.npmRoot, provider.kind), layout.npmRoot)
    rmSync(join(layout.binDir, provider.binary), { force: true })
    return layout
  }
  removeOwnedDir(join(layout.archiveDir, provider.kind), layout.archiveDir)
  rmSync(join(layout.binDir, provider.binary), { force: true })
  return layout
}

/** Event-loop-friendly `uninstallProvider`, for use inside the long-running API. */
export function uninstallProviderAsync(provider, options = {}) {
  return uninstallProvider(provider, { ...options, exec: runAsync })
}

function parseArgs(argv) {
  const options = {
    check: false,
    verify: false,
    installRoot: null,
    lockPath: defaultLockPath,
    targetOs: 'linux',
    targetArch: process.arch === 'arm64' ? 'arm64' : 'amd64',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--check') options.check = true
    else if (arg === '--verify') options.verify = true
    else if (arg === '--lock') options.lockPath = resolve(argv[++index])
    else if (arg === '--install-root') options.installRoot = resolve(argv[++index])
    else if (arg === '--target-os') options.targetOs = argv[++index]
    else if (arg === '--target-arch') options.targetArch = argv[++index]
    else fail(`unknown argument: ${arg}`)
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const lock = loadAndValidateLock(options.lockPath)
  if (options.check) {
    process.stdout.write(`[provider-clis] lock valid (${lock.providers.length} Providers)\n`)
    return
  }

  for (const provider of lock.providers) {
    if (!options.verify) {
      await installProvider(provider, {
        installRoot: options.installRoot,
        targetOs: options.targetOs,
        targetArch: options.targetArch,
      })
    }
    verifyProvider(provider)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
