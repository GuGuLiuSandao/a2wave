import { delimiter, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PRESET_PROVIDERS, isVersionAtLeast } from '@a2wave/shared'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { cliInstallations } from '../db/schema.js'
import { probeCliVersion } from '../engine/login-status-helper.js'
import { evaluateProviderVersion } from '../engine/provider-catalog.js'
import { env } from '../env.js'
import { withKeyedLock } from './keyed-mutex.js'
import { logger } from './logger.js'

/**
 * Runtime installation of the CLIs a2wave shells out to.
 *
 * The image deliberately ships none of them: the growing Provider CLI roster
 * adds well over 1GB while a given deployment typically binds one or two, so
 * baking them in scales the image against a need that stays flat. Installs
 * therefore happen on demand, driven by the *same*
 * `provider-cli-lock.json` and installer the image build used to run — so a
 * runtime install gets the identical pinned version and checksum verification
 * rather than a floating `curl | bash`.
 */

/** Truncation bound for stored installer output, matching the CodeGraph indexer. */
const MAX_OUTPUT_CHARS = 10_000

const VERSION_TOKEN_RE = /[A-Za-z0-9][A-Za-z0-9.+-]*/g

/**
 * Whether a CLI's `--version` output reports the expected version.
 *
 * Tokenises the output and compares whole tokens, rather than substring-matching
 * with lookarounds. Substring matching kept producing boundary bugs in both
 * directions: `includes()` let `12.1.212` and `2.1.2120` satisfy `2.1.212`, and
 * a character-class boundary that fixed those then rejected Copilot's real
 * `GitHub Copilot CLI 1.0.71.` (the trailing period read as a continuation) and
 * still accepted `1.2.1.212`. Comparing tokens has no such edge.
 *
 * Trailing sentence punctuation is stripped from each token, so `1.0.71.` still
 * matches `1.0.71` while `1.0.71.5` (a different version) does not.
 *
 * Mirrored in scripts/provider-clis/install.mjs, which applies the same rule to
 * the pre-promotion check on the staged binary.
 */
export function versionOutputMatches(output: string, expected: string): boolean {
  for (const token of output.match(VERSION_TOKEN_RE) ?? []) {
    // A version never legitimately ends in a dot, so a trailing one is sentence
    // punctuation rather than part of the version.
    if (token.replace(/\.+$/, '') === expected) return true
  }
  return false
}

/**
 * Classify an installed version against the pinned one.
 *
 * `versionOutputMatches` stays the sole authority for an exact match; this only
 * decides the *direction* of a mismatch, and does so with the same
 * `isVersionAtLeast` comparison the engine uses for `minVersion`, so the two
 * never disagree about which of two versions is newer. An unparsable version
 * yields 'unknown' rather than a guess: claiming 'below' would offer a
 * downgrade, and 'above' would suppress a genuine update.
 *
 * Assumes the `--version` output's *first* multi-segment number is the version.
 * `versionOutputMatches` scans every token, but `isVersionAtLeast` reads only
 * that first one, so a CLI printing an unrelated dotted number ahead of its
 * version (a date, say) would have its drift direction read off the wrong
 * number. Every CLI in the lock leads with its version today; a new entry that
 * does not needs the direction derived from a narrowed token instead.
 */
function classifyLockDrift(installedVersion: string, expectedVersionOutput: string): CliLockDrift {
  if (versionOutputMatches(installedVersion, expectedVersionOutput)) return 'match'

  // `isVersionAtLeast` compares only the leading numeric run, so anything the
  // pin carries beyond it — cursor's `-899851b` build hash, a prerelease tag —
  // is invisible to the comparison. When the numeric parts tie yet the exact
  // match above failed, the difference lives entirely in that invisible part and
  // the direction is genuinely undecidable: reporting 'above' would tell an
  // operator running an *older* build of the same date that it is merely
  // unmanaged, and hide the update.
  const atLeastPinned = isVersionAtLeast(installedVersion, expectedVersionOutput)
  if (atLeastPinned === null) return 'unknown'
  if (atLeastPinned && isVersionAtLeast(expectedVersionOutput, installedVersion)) return 'unknown'
  return atLeastPinned ? 'above' : 'below'
}

/** Version probes shell out, so cache them briefly to keep list reads cheap. */
const VERSION_CACHE_TTL_MS = 5_000

export type CliInstallStatus = 'idle' | 'installing' | 'uninstalling' | 'error'

export interface CliCatalogEntry {
  /** Lock entry identity, e.g. 'claude-code'. */
  kind: string
  /** Binary name resolved through PATH, e.g. 'claude'. */
  binary: string
  /** Version pinned by the lock. */
  lockedVersion: string
  /** How the lock installs it; surfaced so the UI can explain what will happen. */
  installType: 'npm' | 'archive'
}

/**
 * Where the installed build sits relative to the pinned version. Null when
 * nothing is installed.
 *
 * The lock pins an *exact* version — `versionOutputMatches` compares whole
 * tokens — which is a different question from the `minVersion` floor the engine
 * gates on. Reporting only "matches / does not match" conflated the two: a build
 * newer than the pin rendered as outdated, and the offered "update" downgraded
 * it. Direction belongs in the state so the UI never has to guess.
 */
export type CliLockDrift = 'match' | 'below' | 'above' | 'unknown'

export interface CliInstallState extends CliCatalogEntry {
  /** Whether the binary currently resolves on PATH. Probed, never read from the DB. */
  installed: boolean
  /** Raw first line of `--version`, or null when absent. */
  installedVersion: string | null
  /**
   * Whether the installed build reports the version the lock pins. Null when not
   * installed. A CLI can drift when the lock is bumped without a reinstall.
   */
  matchesLock: boolean | null
  /** Direction of any mismatch. Null when not installed. */
  lockDrift: CliLockDrift | null
  /**
   * Minimum version the engine gates on, from the Provider preset. Null when the
   * entry declares no floor — including every lock `tools[]` entry, which has no
   * Provider record to read one from.
   *
   * A property of the lock entry rather than of the install, so it is reported
   * even when nothing is installed.
   */
  minVersion: string | null
  /**
   * Whether the installed build clears `minVersion`. Deliberately three-state:
   * `true` a floor is declared and met, `false` declared and unmet, `null`
   * undecidable — not installed, no floor declared, or an unparsable version.
   *
   * The distinction is what lets a consumer tell "below the pin and broken" from
   * "below the pin and perfectly fine". Collapsing `null` into `false` would put
   * every unparsable build back into the second category's warning.
   */
  meetsMinimum: boolean | null
  status: CliInstallStatus
  lastError: string | null
  lastOutput: string | null
}

/**
 * The `minVersion` floor declared for a lock entry.
 *
 * Keyed by Provider kind, so a lock `tools[]` entry — CodeGraph, which indexes
 * SCM sources and has no Provider record — correctly resolves to no floor rather
 * than to a wrong one.
 */
function declaredMinVersion(kind: string): string | null {
  return PRESET_PROVIDERS.find((preset) => preset.kind === kind)?.minVersion ?? null
}

/**
 * Three-state floor verdict for one install.
 *
 * Delegates to the same helper the engine's login-status probe and the Agent
 * diagnosis use, so the CLI card can never disagree with them about whether a
 * build clears its floor. That helper omits `versionOk` for both "no floor" and
 * "unparsable version", which is precisely the undecidable arm here.
 */
function evaluateMinimum(
  installedVersion: string | null,
  minVersion: string | null,
): boolean | null {
  if (installedVersion === null) return null
  return evaluateProviderVersion(installedVersion, minVersion).versionOk ?? null
}

export interface LockFile {
  providers: LockProvider[]
  tools?: LockProvider[]
}

interface LockProvider {
  kind: string
  version: string
  binary: string
  versionArgs: string[]
  expectedVersionOutput: string
  install:
    | { type: 'npm'; package: string; tarball: string; integrity: string; allowScripts: boolean }
    | { type: 'archive'; stripComponents: number; binaryPath: string; targets: object }
}

export interface InstallerModule {
  loadAndValidateLock: (lockPath: string) => LockFile
  /** Providers plus non-Provider tools (CodeGraph), which are managed the same way. */
  allLockEntries: (lock: LockFile) => LockProvider[]
  /**
   * Async variants are used deliberately. The installer's synchronous entry
   * points call `spawnSync`, which inside this long-running server would block
   * the event loop for the whole download — ~12s for a 300MB CLI, stalling every
   * request and failing the container's 5s HEALTHCHECK mid-install.
   */
  installProviderAsync: (
    provider: LockProvider,
    options: {
      installRoot?: string
      targetOs?: string
      targetArch?: string
      onLog?: (line: string) => void
    },
  ) => Promise<unknown>
  uninstallProviderAsync: (
    provider: LockProvider,
    options: { installRoot?: string; onLog?: (line: string) => void },
  ) => Promise<unknown>
}

function truncate(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= MAX_OUTPUT_CHARS) return trimmed
  return `${trimmed.slice(0, MAX_OUTPUT_CHARS)}...`
}

/**
 * Absolute install root. A relative value (the local-dev default) is resolved
 * against cwd here so the installer never depends on the cwd of whichever
 * subprocess it happens to spawn.
 */
export function resolveInstallRoot(): string {
  const configured = env.A2WAVE_CLI_INSTALL_ROOT
  return isAbsolute(configured) ? configured : resolve(process.cwd(), configured)
}

/**
 * Put the effective install root's bin directory on this process's PATH.
 *
 * The Dockerfile hardcodes it for its own default root, which breaks the two
 * cases where the root is not that default: a deployment that overrides
 * `A2WAVE_CLI_INSTALL_ROOT`, and local development (where the root is under
 * `data/` and nothing is on PATH at all). Without this an install writes the
 * files, fails its own PATH verification, and gets rolled back — succeeding on
 * disk while reporting failure.
 *
 * Only `<root>/bin` is needed. Both install types put exactly one symlink there
 * per CLI (npm packages live in a per-kind prefix under `<root>/npm/<kind>` that
 * is deliberately not on PATH — one PATH entry per CLI would not scale, and the
 * per-kind prefixes exist so promoting one CLI cannot disturb another).
 *
 * `NPM_CONFIG_PREFIX` is deliberately NOT set here: there is no single npm prefix
 * any more, and the installer passes the correct per-kind staging prefix
 * explicitly on every call.
 *
 * Child processes inherit `process.env`, so doing this once at boot covers every
 * engine spawn as well.
 */
export function ensureInstallRootOnPath(): void {
  const binDir = resolve(resolveInstallRoot(), 'bin')
  const current = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  if (current.includes(binDir)) return

  process.env.PATH = [binDir, ...current].join(delimiter)
  logger.info({ added: binDir }, 'Added Provider CLI install root to PATH')
}

/**
 * Repository root, derived from this module's own location rather than cwd.
 *
 * cwd is not a reliable anchor: the API process runs from `apps/api` (so does
 * vitest), while the Docker image runs from `/app` — a cwd-relative lookup finds
 * the lock in one and misses it in the other.
 */
function repoRoot(): string {
  // dist/lib/cli-installer.js and src/lib/cli-installer.ts are both two levels
  // below apps/api, which is two below the repo root.
  return resolve(fileURLToPath(import.meta.url), '../../../../..')
}

/**
 * Directory holding the installer. The image copies it plus the lock to
 * /app/provider-clis (see the Dockerfile); a source checkout reads them in place.
 */
function resolveLockDir(): string {
  if (env.A2WAVE_CLI_LOCK_DIR) return env.A2WAVE_CLI_LOCK_DIR
  return resolve(repoRoot(), 'scripts/provider-clis')
}

function lockPath(): string {
  // The image keeps the lock beside the installer; the repo keeps it at the root.
  return env.A2WAVE_CLI_LOCK_DIR
    ? resolve(env.A2WAVE_CLI_LOCK_DIR, 'provider-cli-lock.json')
    : resolve(repoRoot(), 'provider-cli-lock.json')
}

let installerOverride: InstallerModule | null = null

/**
 * Load the installer. It is a plain .mjs script shared with the Docker build
 * rather than a compiled module, so it is imported by path at call time; keeping
 * one implementation is what guarantees build-time and runtime installs behave
 * identically.
 *
 * Tests inject a stub via `_setInstallerForTest` rather than mocking the dynamic
 * path: the real installer downloads tarballs and writes to disk, and a
 * path-based mock silently stops matching the moment either side's path logic
 * changes.
 */
async function loadInstaller(): Promise<InstallerModule> {
  if (installerOverride) return installerOverride
  const path = resolve(resolveLockDir(), 'install.mjs')
  return (await import(/* @vite-ignore */ `file://${path}`)) as unknown as InstallerModule
}

/** Test seam: substitute the installer so no network or disk work happens. */
export function _setInstallerForTest(installer: InstallerModule | null): void {
  installerOverride = installer
}

/**
 * Flattened managed-CLI list: Provider CLIs plus non-Provider tools. CodeGraph is
 * a tool — it indexes SCM sources and has no Provider record — but it is removed
 * from the image alongside the rest, so it must be installable here too.
 */
let cachedEntries: LockProvider[] | null = null

async function loadLock(): Promise<LockProvider[]> {
  if (cachedEntries) return cachedEntries
  const installer = await loadInstaller()
  cachedEntries = installer.allLockEntries(installer.loadAndValidateLock(lockPath()))
  return cachedEntries
}

export async function listCatalog(): Promise<CliCatalogEntry[]> {
  const entries = await loadLock()
  return entries.map((provider) => ({
    kind: provider.kind,
    binary: provider.binary,
    lockedVersion: provider.version,
    installType: provider.install.type,
  }))
}

async function findProvider(kind: string): Promise<LockProvider | undefined> {
  const entries = await loadLock()
  return entries.find((provider) => provider.kind === kind)
}

const versionCache = new Map<string, { at: number; version: string | null }>()

/**
 * Probe an installed version, briefly cached.
 *
 * Each probe spawns the CLI, and the list endpoint probes every entry, so an
 * uncached read would spawn one subprocess per CLI on every poll — the cost that
 * makes eager per-CLI version checks untenable once the roster reaches dozens.
 */
async function probeVersion(provider: LockProvider): Promise<string | null> {
  const cached = versionCache.get(provider.kind)
  const now = Date.now()
  if (cached && now - cached.at < VERSION_CACHE_TTL_MS) return cached.version

  const version = await probeCliVersion(provider.binary, provider.versionArgs)
  versionCache.set(provider.kind, { at: now, version })
  return version
}

function invalidateVersion(kind: string): void {
  versionCache.delete(kind)
}

/**
 * Installed state of one CLI by Provider kind.
 *
 * Distinguishes "not managed by a2wave" from "managed but absent": collapsing
 * both to null would make an unmanaged Provider report as a missing install and
 * fail its Agent's diagnosis for no reason.
 *
 * Shares the cache with the list endpoint, so the Agent diagnosis costs no extra
 * subprocess spawn per request.
 */
export async function probeProviderCli(
  kind: string,
): Promise<{ managed: false } | { managed: true; version: string | null }> {
  const provider = await findProvider(kind)
  if (!provider) return { managed: false }
  return { managed: true, version: await probeVersion(provider) }
}

/** Read the persisted job rows keyed by kind. */
async function readRows(): Promise<Map<string, typeof cliInstallations.$inferSelect>> {
  const rows = await db.select().from(cliInstallations)
  return new Map(rows.map((row) => [row.kind, row]))
}

/**
 * Current state of every managed CLI. Probes run concurrently so the response
 * time is one probe, not the sum of them.
 */
export async function listInstallStates(): Promise<CliInstallState[]> {
  const entries = await loadLock()
  const rows = await readRows()

  return Promise.all(
    entries.map(async (provider) => {
      const row = rows.get(provider.kind)
      const installedVersion = await probeVersion(provider)
      const minVersion = declaredMinVersion(provider.kind)
      return {
        kind: provider.kind,
        binary: provider.binary,
        lockedVersion: provider.version,
        installType: provider.install.type,
        installed: installedVersion !== null,
        installedVersion,
        matchesLock:
          installedVersion === null
            ? null
            : versionOutputMatches(installedVersion, provider.expectedVersionOutput),
        lockDrift:
          installedVersion === null
            ? null
            : classifyLockDrift(installedVersion, provider.expectedVersionOutput),
        minVersion,
        meetsMinimum: evaluateMinimum(installedVersion, minVersion),
        status: row?.status ?? 'idle',
        lastError: row?.lastError ?? null,
        lastOutput: row?.lastOutput ?? null,
      }
    }),
  )
}

async function upsertRow(
  kind: string,
  values: Partial<typeof cliInstallations.$inferInsert>,
): Promise<void> {
  await db
    .insert(cliInstallations)
    .values({ kind, ...values, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: cliInstallations.kind,
      set: { ...values, updatedAt: new Date() },
    })
}

export class CliInstallError extends Error {
  constructor(
    readonly code: 'unknown_kind' | 'already_running' | 'install_failed' | 'not_installed',
    message: string,
  ) {
    super(message)
    this.name = 'CliInstallError'
  }
}

/**
 * Reserve the install slot for one CLI, resolving the kind in the same step.
 *
 * Everything here is synchronous, and that is the point: SQLite runs inline, so
 * the status read and the `installing` write cannot interleave with another
 * request. Awaiting anything in between — even just to look the kind up — reopens
 * the window where two rapid clicks are both accepted, which showed up as two
 * 202s and two audit entries for a single install.
 *
 * Returns the locked version so the caller can audit it without a second lookup.
 */
export async function claimInstallSlot(kind: string): Promise<{ lockedVersion: string }> {
  // Requires a lock already loaded (any prior list/probe call does it). Loading it
  // here would mean an await, defeating the atomicity this function exists for.
  const provider = cachedEntries?.find((candidate) => candidate.kind === kind)
  if (!provider) throw new CliInstallError('unknown_kind', `Unknown CLI: ${kind}`)

  const existing = (await readRows()).get(kind)
  // install and uninstall share one slot: whichever claims it first wins, and the
  // other is rejected outright rather than queued behind it.
  if (existing?.status === 'installing' || existing?.status === 'uninstalling') {
    throw new CliInstallError('already_running', `${kind} is already ${existing.status}`)
  }
  await upsertRow(kind, { status: 'installing', lastError: null, lastOutput: null })
  return { lockedVersion: provider.version }
}

/** Ensure the lock is loaded so `claimInstallSlot` can run without awaiting. */
export async function ensureLockLoaded(): Promise<void> {
  await loadLock()
}

/**
 * Install one CLI at the locked version.
 *
 * Runs to completion in the background: callers respond 202 and the UI polls the
 * row, so a page reload or a restart mid-install does not lose the outcome.
 *
 * Assumes the caller already held the slot via `claimInstallSlot`; call that
 * first so a duplicate request is rejected before this ever starts.
 */
export async function installCli(kind: string): Promise<void> {
  const provider = await findProvider(kind)
  if (!provider) throw new CliInstallError('unknown_kind', `Unknown CLI: ${kind}`)

  // Serialize per kind so two installs never write the same target directory,
  // even if a caller skipped the claim above.
  return withKeyedLock(`cli-install:${kind}`, async () => {
    // Whether a working copy existed before this attempt. A reinstall/update over
    // a healthy CLI must not be cleaned up on failure — doing so would turn a
    // failed update (a dropped connection mid-download) into an outage of a CLI
    // that was working a moment earlier.
    const hadWorkingInstall =
      (await probeCliVersion(provider.binary, provider.versionArgs)) !== null

    await upsertRow(kind, { status: 'installing', lastError: null, lastOutput: null })

    const logLines: string[] = []
    try {
      const installer = await loadInstaller()
      await installer.installProviderAsync(provider, {
        installRoot: resolveInstallRoot(),
        targetOs: process.platform === 'darwin' ? 'darwin' : 'linux',
        targetArch: process.arch === 'arm64' ? 'arm64' : 'amd64',
        onLog: (line) => logLines.push(line),
      })

      invalidateVersion(kind)
      // Verify through the same PATH lookup the engines use, so "installed"
      // cannot be reported for a binary the engines will fail to spawn.
      const version = await probeCliVersion(provider.binary, provider.versionArgs)
      if (version === null) {
        throw new Error(
          `${provider.binary} was installed but does not resolve on PATH — ` +
            `check that ${resolveInstallRoot()} is on PATH`,
        )
      }
      // The installed build must actually be the locked one. Recording
      // `provider.version` after only a null check would report success for a
      // different build entirely — a lock URL/checksum pointing at the wrong
      // version, or an install script producing an unexpected binary — leaving
      // the mismatch to surface later as a passive `matchesLock: false`.
      if (!versionOutputMatches(version, provider.expectedVersionOutput)) {
        throw new Error(
          `${provider.binary} reports "${version}" but the lock pins ` +
            `${provider.version} (expected output containing ` +
            `"${provider.expectedVersionOutput}")`,
        )
      }

      await upsertRow(kind, {
        status: 'idle',
        // The probed value is the ground truth; the lock version is only what we
        // asked for. They are equal here by the check above.
        installedVersion: version,
        lastError: null,
        lastOutput: truncate(logLines.join('\n')),
      })
      logger.info({ kind, version }, 'Provider CLI installed')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Clean up a partial tree only for a first install, where a half-extracted
      // archive would leave a dangling symlink that looks installed but cannot
      // run. After a failed update the previous copy is still the best thing
      // available, so remove nothing and let the probe report what is really there.
      if (!hadWorkingInstall) {
        try {
          const installer = await loadInstaller()
          await installer.uninstallProviderAsync(provider, { installRoot: resolveInstallRoot() })
        } catch {
          // Best effort — the failure being reported is the install, not the cleanup.
        }
      }
      invalidateVersion(kind)
      await upsertRow(kind, {
        status: 'error',
        lastError: truncate(message),
        lastOutput: truncate(logLines.join('\n')),
      })
      logger.error({ kind, err: message }, 'Provider CLI installation failed')
      throw new CliInstallError('install_failed', message)
    }
  })
}

/**
 * Claim the slot for an uninstall, synchronously.
 *
 * A read-only check is not enough. `uninstallCli` awaits before taking the keyed
 * lock, so a check-then-await leaves a window where an install claims the slot in
 * between: the uninstall then queues behind it and deletes the CLI that was just
 * installed, and on the way out overwrites the status the install had set. Both
 * operations must therefore *write* their claim before yielding again, and every
 * caller must await this — an unawaited claim lets the `already_running`
 * rejection escape while the operation proceeds regardless.
 */
export async function claimUninstallSlot(kind: string): Promise<void> {
  const existing = (await readRows()).get(kind)
  if (existing?.status === 'installing' || existing?.status === 'uninstalling') {
    throw new CliInstallError('already_running', `${kind} is already ${existing.status}`)
  }
  await upsertRow(kind, { status: 'uninstalling', lastError: null })
}

/** Remove one CLI's files, freeing the space the on-demand model exists to save. */
export async function uninstallCli(kind: string): Promise<void> {
  // Claimed before the first await: `findProvider` yields, and an install that
  // claims the slot during that gap must lose the race rather than run alongside.
  await claimUninstallSlot(kind)

  let provider: LockProvider | undefined
  try {
    provider = await findProvider(kind)
  } catch (error) {
    await upsertRow(kind, { status: 'idle' })
    throw error
  }
  if (!provider) {
    // Release the slot we just claimed; an unknown kind is not a running job.
    await upsertRow(kind, { status: 'idle' })
    throw new CliInstallError('unknown_kind', `Unknown CLI: ${kind}`)
  }

  return withKeyedLock(`cli-install:${kind}`, async () => {
    const logLines: string[] = []
    try {
      const installer = await loadInstaller()
      await installer.uninstallProviderAsync(provider, {
        installRoot: resolveInstallRoot(),
        onLog: (line) => logLines.push(line),
      })
      invalidateVersion(kind)
      await upsertRow(kind, {
        status: 'idle',
        installedVersion: null,
        lastError: null,
        lastOutput: truncate(logLines.join('\n')),
      })
      logger.info({ kind }, 'Provider CLI uninstalled')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      invalidateVersion(kind)
      await upsertRow(kind, { status: 'error', lastError: truncate(message) })
      throw new CliInstallError('install_failed', message)
    }
  })
}

/**
 * Fail rows left mid-install by a crash or restart.
 *
 * The status lives in the DB rather than memory precisely so it survives a
 * restart — but that means a killed process leaves a row claiming to be
 * installing forever, which would block every later attempt on that kind.
 */
export async function recoverInterruptedInstalls(): Promise<void> {
  // Both claim states must be settled: a crash during an uninstall would
  // otherwise leave the slot claimed forever, blocking every later operation on
  // that CLI exactly like a stranded install would.
  const stuck = await db
    .select()
    .from(cliInstallations)
    .where(inArray(cliInstallations.status, ['installing', 'uninstalling']))
  if (stuck.length === 0) return

  for (const row of stuck) {
    await db
      .update(cliInstallations)
      .set({
        status: 'error',
        lastError: 'Interrupted by a server restart',
        updatedAt: new Date(),
      })
      .where(eq(cliInstallations.kind, row.kind))
  }
  logger.warn(
    { kinds: stuck.map((row) => row.kind) },
    'Marked interrupted Provider CLI installations as failed',
  )
}

/** Test seam: drop the memoized lock so a test can point at a different file. */
export function _resetCliInstallerCaches(): void {
  cachedEntries = null
  versionCache.clear()
}
