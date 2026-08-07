#!/usr/bin/env node
/**
 * Verify that each Provider's declared `minVersion` floor actually accepts every
 * CLI token its engine adapter passes.
 *
 * `minVersion` in packages/shared/src/schemas/provider.ts is a hand-written
 * constant. The invocation-surface snapshot test detects when an adapter's
 * tokens drift, but it cannot decide whether the floor is *right*. This script
 * closes one half of that gap — the dangerous half: a floor set too LOW lets a
 * user pass the version gate and then break at spawn time on a flag their CLI
 * has never heard of.
 *
 * Network-dependent and slow (it installs real CLIs), so it is a manually-run /
 * scheduled tool. It is NOT wired into `pnpm test` or the git hooks; only its
 * pure helpers are unit-tested.
 *
 * Usage:
 *   node scripts/verify-provider-min-versions.mjs [--provider <kind>] [--json]
 *                                                 [--snapshot <path>] [--timeout <ms>]
 *
 * Exit codes: 0 = no rejected token, 1 = a declared floor rejects a token it
 * needs (a real defect), 2 = the run could not be set up (missing snapshot, bad
 * arguments).
 *
 * **0 does not mean "all floors verified."** A Provider whose CLI cannot be
 * probed yields no evidence, which is not a failure — so it cannot raise the
 * exit code — but it is not a pass either. The report therefore names, every
 * run, which Providers were verified and which were withheld; read that, not
 * just the exit status.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PRESETS_PATH = join(REPO_ROOT, 'packages/shared/src/schemas/provider.ts')
const DEFAULT_SNAPSHOT_PATH = join(
  REPO_ROOT,
  'apps/api/src/engine/__tests__/cli-invocation-surface.snapshot.json',
)
/** Where the snapshot lives in-tree. Named in the error so the fix is obvious. */
export const SNAPSHOT_SOURCE = 'apps/api/src/engine/__tests__/cli-invocation-surface.test.ts'
const DEFAULT_TIMEOUT_MS = 30_000

// ============================================================
// Preset parsing
// ============================================================

/**
 * Remove line and block comments while leaving string literals untouched.
 *
 * String awareness is the whole point: `'curl https://cursor.com/install'` is a
 * value, not a comment, and naive stripping truncates it at the `//`. Removing
 * comments up front also means a commented-out `minVersion: '9.9.9'` cannot
 * shadow the real property.
 */
function stripComments(source) {
  let out = ''
  let mode = 'code'
  let quote = ''

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    const next = source[i + 1]

    if (mode === 'string') {
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        i++
      } else if (ch === quote) {
        mode = 'code'
      }
      continue
    }
    if (mode === 'line-comment') {
      if (ch === '\n') {
        out += ch
        mode = 'code'
      }
      continue
    }
    if (mode === 'block-comment') {
      if (ch === '*' && next === '/') {
        i++
        mode = 'code'
      }
      continue
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      mode = 'string'
      quote = ch
      out += ch
    } else if (ch === '/' && next === '/') {
      mode = 'line-comment'
      i++
    } else if (ch === '/' && next === '*') {
      mode = 'block-comment'
      i++
    } else {
      out += ch
    }
  }

  return out
}

/**
 * Split the top-level object literals out of an array literal, ignoring braces
 * inside string literals. Expects comment-free input.
 *
 * `startIndex` must point at the opening `[`.
 */
function sliceObjectLiterals(source, startIndex) {
  const entries = []
  let inString = false
  let quote = ''
  let depth = 0
  let entryStart = -1

  for (let i = startIndex + 1; i < source.length; i++) {
    const ch = source[i]

    if (inString) {
      if (ch === '\\') i++
      else if (ch === quote) inString = false
      continue
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      inString = true
      quote = ch
    } else if (ch === '{') {
      if (depth === 0) entryStart = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && entryStart >= 0) {
        entries.push(source.slice(entryStart, i + 1))
        entryStart = -1
      }
    } else if (ch === ']' && depth === 0) {
      break
    }
  }

  return entries
}

/**
 * Read a `key: 'value'` / `key: null` property from a comment-free entry.
 *
 * The `{`/`,`/line-start boundary keeps the key from matching inside another
 * property's string value (a description mentioning `minVersion: '9.9.9'`).
 */
function readProperty(entry, key) {
  const pattern = new RegExp(`(?:^|[{,])\\s*${key}:\\s*(null|'((?:[^'\\\\]|\\\\.)*)')`, 'm')
  const match = entry.match(pattern)
  if (!match) return undefined
  return match[1] === 'null' ? null : match[2]
}

/**
 * Extract the preset Provider definitions from the shared schema source.
 *
 * Parsed rather than imported because this is a plain `.mjs` script and the
 * presets live in TypeScript — importing them would require a built
 * `packages/shared/dist`, turning a diagnostic tool into a build-order problem.
 */
export function parsePresetProviders(source) {
  const code = stripComments(source)
  const anchor = code.match(/const\s+PRESET_PROVIDER_DEFS\s*:[^=]*=\s*\[/)
  if (!anchor) {
    throw new Error('PRESET_PROVIDER_DEFS array not found — has provider.ts been restructured?')
  }

  const arrayStart = anchor.index + anchor[0].length - 1
  const presets = sliceObjectLiterals(code, arrayStart).map((entry) => ({
    kind: readProperty(entry, 'kind'),
    initScript: readProperty(entry, 'initScript'),
    checkScript: readProperty(entry, 'checkScript'),
    minVersion: readProperty(entry, 'minVersion'),
  }))

  if (presets.length === 0) {
    throw new Error('PRESET_PROVIDER_DEFS parsed to zero providers — the parser is out of date')
  }
  for (const preset of presets) {
    if (!preset.kind || !preset.initScript || !preset.checkScript) {
      throw new Error(`Preset missing kind/initScript/checkScript: ${JSON.stringify(preset)}`)
    }
    if (preset.minVersion === undefined) {
      throw new Error(`Preset ${preset.kind} has no minVersion property`)
    }
  }

  return presets
}

/**
 * Derive the npm package an `initScript` installs, or null when the CLI is not
 * npm-distributed (`curl | bash` installers publish no enumerable versions, so
 * a specific floor cannot be fetched and probed).
 */
export function npmPackageFromInitScript(initScript) {
  if (typeof initScript !== 'string') return null
  const tokens = initScript.trim().split(/\s+/)
  if (tokens[0] !== 'npm') return null
  if (tokens[1] !== 'i' && tokens[1] !== 'install' && tokens[1] !== 'add') return null

  const spec = tokens.slice(2).find((token) => !token.startsWith('-'))
  if (!spec) return null

  // Strip a trailing `@version`; the leading `@` of a scoped name is at index 0.
  const at = spec.lastIndexOf('@')
  return at > 0 ? spec.slice(0, at) : spec
}

/** The binary a preset's `checkScript` invokes (`'qodercli --version'` -> `'qodercli'`). */
export function binaryFromCheckScript(checkScript) {
  if (typeof checkScript !== 'string') return null
  return checkScript.trim().split(/\s+/)[0] ?? null
}

// ============================================================
// Snapshot
// ============================================================

/**
 * Load the invocation-surface snapshot.
 *
 * The snapshot is generated and committed by the invocation-surface test, so if
 * it is missing the run cannot start — say which test writes it rather than
 * producing a stack trace about a path.
 */
export function loadSnapshot({ snapshotPath, readFile = readFileSync, fileExists = existsSync }) {
  if (!fileExists(snapshotPath)) {
    throw new SetupError(
      [
        `CLI invocation surface snapshot not found: ${snapshotPath}`,
        `It is written by \`${SNAPSHOT_SOURCE}\`; run that test to regenerate it,`,
        'or point at a copy with --snapshot <path>, e.g.:',
        '  node scripts/verify-provider-min-versions.mjs --snapshot /tmp/surface.json',
      ].join('\n'),
    )
  }

  let parsed
  try {
    parsed = JSON.parse(readFile(snapshotPath, 'utf8'))
  } catch (error) {
    throw new SetupError(`Snapshot is not valid JSON (${snapshotPath}): ${error.message}`)
  }
  if (!parsed || typeof parsed.engines !== 'object' || parsed.engines === null) {
    throw new SetupError(`Snapshot has no \`engines\` object (${snapshotPath})`)
  }
  return parsed
}

/** Raised for "this run cannot start" conditions; surfaced as exit code 2. */
export class SetupError extends Error {}

// ============================================================
// Token normalisation & probe classification
// ============================================================

/**
 * Reduce a snapshot surface token to the flag to probe, or null when it is not
 * flag-shaped (a subcommand like `exec`, or a pinned literal like `stream-json`).
 *
 * `--tools=read,grep` -> `--tools`: the adapter pins the value, but argument
 * parsing accepts or rejects the flag, so the flag is what we can probe.
 */
export function normalizeSurfaceToken(token) {
  if (typeof token !== 'string') return null
  const trimmed = token.trim()
  if (!trimmed.startsWith('-')) return null

  const flag = trimmed.split('=')[0]
  return /^--?[A-Za-z][\w-]*$/.test(flag) ? flag : null
}

/** Unique, sorted, flag-shaped tokens from a snapshot `surface` array. */
export function surfaceFlags(surface) {
  if (!Array.isArray(surface)) return []
  const flags = new Set()
  for (const token of surface) {
    const flag = normalizeSurfaceToken(token)
    if (flag) flags.add(flag)
  }
  return [...flags].sort()
}

/**
 * Bare-word tokens from a surface — the adapter's subcommand candidates.
 *
 * Their presence decides whether a top-level rejection can be trusted: `kimi`
 * only ever passes `--json` as `kimi provider list --json`, so `kimi --json`
 * rejecting says nothing about the floor. The snapshot is a flat set with no
 * ordering, so the chain cannot be reconstructed — only flagged.
 */
export function surfaceSubcommands(surface) {
  if (!Array.isArray(surface)) return []
  const words = new Set()
  for (const token of surface) {
    if (typeof token === 'string' && /^[a-z][\w-]*$/i.test(token.trim())) words.add(token.trim())
  }
  return [...words].sort()
}

/**
 * Argument-parser rejections. Matched against stderr only — the signal that was
 * verified by hand lands there, and help text on stdout routinely lists the word
 * "unknown", which would produce false rejections.
 */
const UNKNOWN_OPTION_PATTERN = /unknown (option|flag|argument)|unrecognized|invalid option/i

/**
 * Classify one flag probe.
 *
 * Acceptance probing, not help-text scraping: help output is incomplete and
 * inconsistently formatted, whereas running the flag gives the parser's own
 * verdict. A supported flag gets *past* argument parsing and then fails on
 * something later — missing credentials being the usual one — so a credentials
 * error is a POSITIVE result, not a failure.
 */
export function classifyProbe(result) {
  if (result?.spawnError) return 'unprobeable'
  if (result?.timedOut) return 'unprobeable'
  return UNKNOWN_OPTION_PATTERN.test(result?.stderr ?? '') ? 'rejected' : 'accepted'
}

/** Inert argument used to give a value-taking flag something to consume. */
export const PROBE_PLACEHOLDER = 'a2wave-probe'

/**
 * Probe one flag under an optional subcommand prefix, bare first and then with a
 * placeholder value.
 *
 * The retry is not belt-and-braces, it is required for correctness: pi 0.83.0
 * answers a *value-taking* flag given no value with `Error: Unknown option:
 * --model` — the same words it uses for a flag it has genuinely never heard of.
 * Probing bare only, every value-taking flag in pi's surface reported as
 * rejected and the script claimed seven defects that do not exist. A flag is
 * therefore only rejected when the CLI rejects it in BOTH shapes.
 *
 * Bare stays the first attempt so boolean flags are never handed a stray
 * positional, which some CLIs would read as a prompt and actually execute.
 */
async function probeShapes(flag, { runProbe, binPath, cwd, timeoutMs, prefix = [] }) {
  const bare = await runProbe({ binPath, args: [...prefix, flag], cwd, timeoutMs })
  const bareVerdict = classifyProbe(bare)
  if (bareVerdict !== 'rejected') {
    return {
      verdict: bareVerdict,
      acceptedAs: bareVerdict === 'accepted' ? 'bare' : null,
      evidence: evidenceOf(bare),
    }
  }

  const withValue = await runProbe({
    binPath,
    args: [...prefix, flag, PROBE_PLACEHOLDER],
    cwd,
    timeoutMs,
  })
  const valueVerdict = classifyProbe(withValue)
  if (valueVerdict !== 'rejected') {
    const retryEvidence = evidenceOf(withValue)
    return {
      verdict: valueVerdict,
      acceptedAs: valueVerdict === 'accepted' ? 'with-value' : null,
      // A timeout or spawn failure on the retry produces no output of its own.
      // Keeping the bare probe's rejection text is the difference between
      // "unprobeable, and here is what we did see" and an evidence-free verdict.
      evidence: valueVerdict === 'unprobeable' && !retryEvidence ? evidenceOf(bare) : retryEvidence,
    }
  }

  return { verdict: 'rejected', acceptedAs: null, evidence: evidenceOf(bare) }
}

/**
 * Upper bound on the subcommand chains tried before a top-level rejection is
 * allowed to stand. Real surfaces have one to four bare words; the cap only
 * exists so a future surface cannot turn one rejected flag into a combinatorial
 * probe storm.
 */
export const MAX_SUBCOMMAND_CHAINS = 12

/**
 * Candidate subcommand chains to try a top-level-rejected flag under: every
 * single bare word first, then every ordered pair.
 *
 * Pairs are not optional. `kimi --json` is really `kimi provider list --json`,
 * a two-level chain, and the snapshot records `['list', 'provider']` as an
 * unordered set — singles alone would never reproduce it.
 */
export function subcommandChains(subcommands, max = MAX_SUBCOMMAND_CHAINS) {
  const singles = subcommands.map((word) => [word])
  const pairs = []
  for (const first of subcommands) {
    for (const second of subcommands) {
      if (first !== second) pairs.push([first, second])
    }
  }
  return [...singles, ...pairs].slice(0, max)
}

/**
 * Probe one flag at top level, and — only when that rejects — under the
 * adapter's candidate subcommand chains.
 *
 * **The downgrade rule**: a top-level rejection stands as a defect unless some
 * candidate subcommand chain fails to reject the same flag. The blanket version
 * of this ("the surface contains a bare word, therefore excuse everything")
 * masked real defects on mixed surfaces — qoder and opencode both carry
 * top-level flags (`--list-models`, `--output-format`) *and* a `status`
 * subcommand, so a genuine rejection of a top-level flag was silently excused.
 * Requiring a chain that does not reject makes the excuse evidence-based.
 *
 * "Does not reject" rather than "accepts" is deliberate and errs away from
 * crying wolf: an unprobeable chain is missing evidence, not proof of a defect.
 */
export async function probeFlag(flag, context) {
  const { subcommands = [] } = context

  const top = await probeShapes(flag, { ...context, prefix: [] })
  if (top.verdict !== 'rejected') {
    return {
      token: flag,
      verdict: top.verdict,
      acceptedAs: top.acceptedAs,
      evidence: top.evidence,
    }
  }

  const chains = subcommandChains(subcommands)
  for (const chain of chains) {
    const scoped = await probeShapes(flag, { ...context, prefix: chain })
    if (scoped.verdict !== 'rejected') {
      return {
        token: flag,
        verdict: 'inconclusive',
        acceptedAs: null,
        subcommands,
        resolvedUnder: chain,
        scopedVerdict: scoped.verdict,
        evidence: top.evidence,
      }
    }
  }

  return {
    token: flag,
    verdict: 'rejected',
    acceptedAs: null,
    subcommands,
    chainsProbed: chains.length,
    evidence: top.evidence,
  }
}

/**
 * A flag no CLI can legitimately implement, used to ask one question before any
 * real verdict is trusted: **can this CLI express "I do not know that flag" in a
 * way `classifyProbe` can read?**
 *
 * qodercli 1.0.0 cannot. It answers an unknown flag with its usage banner on
 * stdout *and* stderr and exits 0 — no rejection keyword anywhere — while
 * `--version` returns a clean `1.0.0`, so the control gate passes. Every flag
 * then classified as `accepted` and the tool reported a confident all-clear for
 * a floor it had not tested at all. That is worse than no check, because the
 * result was passed upstream as verification.
 */
export const SENTINEL_FLAG = '--a2wave-nonexistent-sentinel'

/**
 * Run the classifier self-test: probe the sentinel through the same two-phase
 * path a real flag takes, so a CLI is never failed for a difference in probing.
 *
 * No subcommand prefix and no subcommand excuse — the sentinel exists nowhere,
 * so any verdict other than `rejected` means this CLI's parser is too permissive
 * for acceptance probing to say anything.
 */
export async function probeSentinel(context) {
  return probeShapes(SENTINEL_FLAG, { ...context, prefix: [] })
}

function evidenceOf(result) {
  return truncate((result?.stderr || result?.stdout || '').trim(), 160)
}

const MAX_VERSION_OUTPUT_CHARS = 400
const MAX_VERSION_OUTPUT_LINES = 10

/**
 * Does this look like a version banner?
 *
 * The control gate exists because some published builds are simply broken and
 * fail *everything* identically — qodercli@1.0.15 dumps its JS bundle plus an
 * "unsettled top-level await" warning for `--version` and for every flag alike.
 * Without this check such a build reads as "missing every flag" and yields a
 * confident, entirely bogus verdict.
 */
export function isPlausibleVersionOutput(text) {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_VERSION_OUTPUT_CHARS) return false
  if (trimmed.split('\n').length > MAX_VERSION_OUTPUT_LINES) return false
  return /\d+\.\d+/.test(trimmed)
}

/** Version banners normally go to stdout; fall back to stderr for the CLIs that do not. */
export function pickVersionText(result) {
  const stdout = (result?.stdout ?? '').trim()
  return stdout.length > 0 ? stdout : (result?.stderr ?? '').trim()
}

// ============================================================
// Planning
// ============================================================

/**
 * Decide, without touching the network, which Providers can be verified and why
 * the rest cannot.
 */
export function planVerification({ presets, snapshot, only = null }) {
  const checks = []
  const skipped = []

  for (const preset of presets) {
    if (only && preset.kind !== only) continue

    const npmPackage = npmPackageFromInitScript(preset.initScript)
    const engine = snapshot.engines?.[preset.kind]
    const reasons = []

    if (preset.minVersion === null) reasons.push('no declared minVersion floor')
    if (!npmPackage) reasons.push('not npm-distributed')
    if (!engine) reasons.push('no snapshot entry')

    const flags = engine ? surfaceFlags(engine.surface) : []
    if (reasons.length === 0 && flags.length === 0) reasons.push('no flag-shaped tokens in surface')

    if (reasons.length > 0) {
      skipped.push({ kind: preset.kind, minVersion: preset.minVersion, reasons })
      continue
    }

    checks.push({
      kind: preset.kind,
      minVersion: preset.minVersion,
      npmPackage,
      binary: binaryFromCheckScript(preset.checkScript),
      snapshotMinVersion: engine.minVersion ?? null,
      flags,
      subcommands: surfaceSubcommands(engine.surface),
    })
  }

  return { checks, skipped }
}

// ============================================================
// Execution boundary (injected so tests never hit the network)
// ============================================================

/**
 * Minimal environment for probing a third-party CLI.
 *
 * An **allowlist, not a denylist**. This script installs arbitrary published
 * builds from npm and then executes them, so the probed binary is untrusted
 * code and anything it does not need to start stays out. The previous denylist
 * dropped only `*_API_KEY` / `*_AUTH_TOKEN` / `*_ACCESS_TOKEN`, which means
 * `GITHUB_TOKEN`, `NPM_TOKEN`, `GITLAB_TOKEN`, `PRIVATE_TOKEN`,
 * `AWS_SECRET_ACCESS_KEY`, `*_PASSWORD` and `SSH_AUTH_SOCK` all reached the
 * child. A denylist can only exclude the names someone thought of; an
 * allowlist cannot be outgrown by a credential naming convention.
 *
 * `HOME` and `TMPDIR` point at the throwaway install dir. That is not only
 * hardening — it is what makes the probe *correct*. On-disk credentials
 * (`~/.claude/.credentials.json`, `~/.config/**`, `~/.npmrc`, `~/.ssh/**`) are
 * out of reach, and, just as importantly, the CLI finds no logged-in session
 * and takes the deterministic "no API key" branch that `classifyProbe` reads as
 * acceptance. With the real `HOME`, the same probe would classify differently
 * on a developer machine that happens to be signed in.
 *
 * Deliberately absent, each for a reason:
 *   - `NODE_OPTIONS` — lets the ambient environment inject code into the very
 *     binary we are treating as untrusted.
 *   - `XDG_CONFIG_HOME` / `XDG_DATA_HOME` and friends — they point back at the
 *     real config tree and would silently undo the `HOME` redirect.
 *   - `USER` / `TERM` / `SHELL` — nothing here needs an identity or a TTY;
 *     stdout is a pipe and `NO_COLOR` already settles colour.
 *   - Windows' `SystemRoot` / `ComSpec` — this script is already POSIX-only, it
 *     looks for an extensionless `node_modules/.bin/<binary>`.
 *
 * @param sandboxDir the throwaway install dir, also used as the probe's cwd
 */
export function probeEnv(sandboxDir) {
  return {
    // The `.bin` shim starts with `#!/usr/bin/env node`; with no PATH, nothing runs.
    PATH: process.env.PATH ?? '',
    HOME: sandboxDir,
    TMPDIR: sandboxDir,
    // Stable, machine-readable output: colour escapes and locale-dependent
    // wording both land on the stderr that `classifyProbe` matches against.
    NO_COLOR: '1',
    CI: '1',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  }
}

function realRunProbe({ binPath, args, cwd, timeoutMs }) {
  const result = spawnSync(binPath, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    // stdin closed: a flag with no prompt must not drop the CLI into an interactive TUI.
    stdio: ['ignore', 'pipe', 'pipe'],
    // Run inside the throwaway install dir so anything a probe writes is deleted with it.
    cwd,
    // The same dir is the probe's HOME, so a stray config write is deleted with it too.
    env: probeEnv(cwd),
  })

  const timedOut = result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM'
  const spawnError = result.error && !timedOut ? result.error.message : null

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status,
    timedOut,
    spawnError,
  }
}

/**
 * Install one version into a throwaway prefix.
 *
 * Unlike the probe, this inherits the real environment on purpose: the process
 * being run is `npm` itself, which needs `~/.npmrc` and any proxy settings to
 * reach the registry at all. `--ignore-scripts` is what keeps the downloaded
 * package from executing here — the untrusted build only ever runs later, under
 * `probeEnv`.
 */
function realInstallPackage({ npmPackage, version, binary }) {
  const prefix = mkdtempSync(join(tmpdir(), 'a2wave-minver-'))
  const cleanup = () => rmSync(prefix, { recursive: true, force: true })

  // --ignore-scripts is deliberate: pi's own preset documents that its official
  // install disables lifecycle scripts. A build that genuinely needs them will
  // fail the control gate rather than produce a bogus flag verdict.
  const result = spawnSync(
    'npm',
    [
      'i',
      '--prefix',
      prefix,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `${npmPackage}@${version}`,
    ],
    { encoding: 'utf8', timeout: 300_000 },
  )

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || '').trim()
    cleanup()
    return { ok: false, error: detail.split('\n').slice(-6).join('\n') }
  }

  const binPath = join(prefix, 'node_modules', '.bin', binary)
  if (!existsSync(binPath)) {
    cleanup()
    return { ok: false, error: `installed, but no executable at node_modules/.bin/${binary}` }
  }

  return { ok: true, binPath, cwd: prefix, cleanup }
}

// ============================================================
// Verification
// ============================================================

/**
 * Why a Provider's flag verdicts were withheld. Both are `status: 'unprobeable'`
 * — no evidence either way — but they mean different things to a reader and
 * have different fixes, so they are never collapsed into one message:
 *   - `control-gate`: this published build is broken (it cannot even print a
 *     version), so nothing it says can be trusted.
 *   - `permissive-parser`: the build is fine, but its argument parser never
 *     reports an unknown flag in a detectable way, so acceptance probing simply
 *     does not work on this CLI.
 */
export const WITHHELD_REASON = {
  controlGate: 'control-gate',
  permissiveParser: 'permissive-parser',
}

/**
 * Run one Provider's check: install the floor, gate on `--version`, self-test the
 * classifier with a sentinel flag, then probe each flag. Never throws — every
 * failure mode becomes a reported status.
 */
export async function verifyProvider(check, deps) {
  const { installPackage, runProbe, timeoutMs = DEFAULT_TIMEOUT_MS } = deps

  const install = await installPackage({
    npmPackage: check.npmPackage,
    version: check.minVersion,
    binary: check.binary,
  })
  if (!install.ok) {
    return { ...check, status: 'install-failed', error: install.error, tokens: [] }
  }

  const probeContext = {
    runProbe,
    binPath: install.binPath,
    cwd: install.cwd,
    timeoutMs,
    subcommands: check.subcommands ?? [],
  }

  try {
    const control = await runProbe({
      binPath: install.binPath,
      args: ['--version'],
      cwd: install.cwd,
      timeoutMs,
    })
    const versionText = pickVersionText(control)
    if (!isPlausibleVersionOutput(versionText)) {
      return {
        ...check,
        status: 'unprobeable',
        reason: WITHHELD_REASON.controlGate,
        control: { ok: false, output: truncate(versionText) },
        error: `\`${check.binary} --version\` produced no usable version banner at ${check.minVersion}`,
        tokens: [],
      }
    }

    // Classifier self-test, before any real flag is probed. A CLI that answers a
    // flag that cannot exist with anything but a rejection would report every
    // flag as accepted — a confident all-clear with nothing behind it.
    const sentinel = await probeSentinel(probeContext)
    if (sentinel.verdict !== 'rejected') {
      return {
        ...check,
        status: 'unprobeable',
        reason: WITHHELD_REASON.permissiveParser,
        control: { ok: true, output: versionText },
        sentinel: { token: SENTINEL_FLAG, verdict: sentinel.verdict, evidence: sentinel.evidence },
        error: `\`${check.binary} ${SENTINEL_FLAG}\` classified as \`${sentinel.verdict}\`, not \`rejected\` — this CLI does not report an unknown flag detectably, so every flag would read as accepted`,
        tokens: [],
      }
    }

    const tokens = []
    for (const flag of check.flags) {
      tokens.push(await probeFlag(flag, probeContext))
    }

    return {
      ...check,
      status: 'checked',
      control: { ok: true, output: versionText },
      sentinel: { token: SENTINEL_FLAG, verdict: sentinel.verdict, evidence: sentinel.evidence },
      tokens,
    }
  } finally {
    install.cleanup?.()
  }
}

function truncate(text, max = 300) {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}...` : flat
}

/**
 * One line explaining why a Provider produced no flag verdicts, phrased for an
 * operator reading the summary rather than the code.
 */
export function withheldReason(result) {
  if (result.status === 'install-failed') return `could not install ${result.minVersion} from npm`
  if (result.reason === WITHHELD_REASON.permissiveParser) {
    return `parser too permissive to probe (${SENTINEL_FLAG} was not rejected)`
  }
  if (result.reason === WITHHELD_REASON.controlGate) return 'no usable `--version` banner'
  return 'no flag verdicts produced'
}

/** Verify every planned Provider. Returns the full report; decides no exit code. */
export async function verifyPlan(plan, deps) {
  const results = []
  for (const check of plan.checks) {
    results.push(await verifyProvider(check, deps))
  }

  const collect = (verdict) =>
    results.flatMap((result) =>
      (result.tokens ?? [])
        .filter((token) => token.verdict === verdict)
        .map((token) => ({
          kind: result.kind,
          minVersion: result.minVersion,
          token: token.token,
          subcommands: token.subcommands ?? [],
        })),
    )

  // Which Providers this run actually has evidence about, and which it does not.
  // Kept as first-class report fields so silence can never be read as success —
  // by a human skimming the summary or by a machine reading `--json`.
  const verified = results
    .filter((result) => result.status === 'checked')
    .map((result) => ({
      kind: result.kind,
      minVersion: result.minVersion,
      flagsProbed: (result.tokens ?? []).length,
    }))
  const withheld = results
    .filter((result) => result.status !== 'checked')
    .map((result) => ({
      kind: result.kind,
      minVersion: result.minVersion,
      reason: withheldReason(result),
    }))

  return {
    results,
    skipped: plan.skipped,
    verified,
    withheld,
    rejected: collect('rejected'),
    inconclusive: collect('inconclusive'),
  }
}

// ============================================================
// Reporting
// ============================================================

const VERDICT_MARK = {
  accepted: 'ok  ',
  rejected: 'FAIL',
  unprobeable: '??  ',
  inconclusive: 'scope',
}

export function formatReport(report) {
  const lines = []

  for (const result of report.results) {
    lines.push('')
    lines.push(`${result.kind} — declared floor ${result.minVersion} (${result.npmPackage})`)

    if (result.status === 'install-failed') {
      lines.push(`  install failed: ${result.error}`)
      continue
    }
    if (result.status === 'unprobeable' && result.reason === WITHHELD_REASON.permissiveParser) {
      lines.push(`  control gate ok: ${result.binary} --version -> ${result.control.output}`)
      lines.push(
        `  classifier self-test FAILED: ${SENTINEL_FLAG} classified as \`${result.sentinel.verdict}\`, not \`rejected\`.`,
      )
      lines.push(
        `    ${result.binary} ${SENTINEL_FLAG} -> ${result.sentinel.evidence || '(no output)'}`,
      )
      lines.push('  this CLI does not reject a flag that cannot exist, so acceptance probing')
      lines.push('  would report every flag as accepted regardless of the floor.')
      lines.push('  every flag verdict for this version is withheld — no evidence, NOT a pass.')
      continue
    }
    if (result.status === 'unprobeable') {
      lines.push(`  control gate FAILED: ${result.error}`)
      lines.push(`    ${result.binary} --version -> ${result.control.output || '(no output)'}`)
      lines.push('  every flag verdict for this version is withheld as unreliable.')
      continue
    }

    lines.push(`  control gate ok: ${result.binary} --version -> ${result.control.output}`)
    lines.push(`  classifier self-test ok: ${result.binary} ${SENTINEL_FLAG} -> rejected`)
    for (const token of result.tokens) {
      const mark = VERDICT_MARK[token.verdict] ?? token.verdict
      const shape = token.acceptedAs === 'with-value' ? ' (takes a value)' : ''
      lines.push(`  [${mark}] ${token.token}${shape}`)
      if (token.verdict !== 'accepted' && token.evidence) {
        lines.push(`         ${token.evidence}`)
      }
    }
  }

  if (report.skipped.length > 0) {
    lines.push('')
    lines.push('Not checked:')
    for (const skip of report.skipped) {
      lines.push(`  ${skip.kind}: ${skip.reasons.join('; ')}`)
    }
  }

  const inconclusive = report.inconclusive ?? []
  if (inconclusive.length > 0) {
    lines.push('')
    lines.push(`Inconclusive — ${inconclusive.length} token(s) rejected at top level only:`)
    for (const item of inconclusive) {
      lines.push(
        `  ${item.kind}@${item.minVersion} ${item.token} — rejected at top level but not under ` +
          `every candidate subcommand (${item.subcommands.join(', ')}); check by hand.`,
      )
    }
  }

  const verified = report.verified ?? []
  const withheld = report.withheld ?? []
  lines.push('')
  lines.push(
    verified.length > 0
      ? `Verified — ${verified.length} provider(s) produced usable evidence: ${verified
          .map((item) => `${item.kind}@${item.minVersion} (${item.flagsProbed} flag(s))`)
          .join(', ')}`
      : 'Verified — no provider produced usable evidence in this run.',
  )
  if (withheld.length > 0) {
    lines.push(`Withheld — ${withheld.length} provider(s) produced NO evidence:`)
    for (const item of withheld) {
      lines.push(`  ${item.kind}@${item.minVersion} — ${item.reason}`)
    }
    lines.push('  Withheld is an absence of evidence, not a pass: those floors are UNVERIFIED.')
  }

  lines.push('')
  if (report.rejected.length > 0) {
    lines.push(`DEFECT — ${report.rejected.length} token(s) rejected by their declared floor:`)
    for (const item of report.rejected) {
      lines.push(`  ${item.kind}@${item.minVersion} rejects ${item.token}`)
    }
    lines.push(
      'Raise minVersion in packages/shared/src/schemas/provider.ts, or stop passing the token.',
    )
  } else {
    const scope =
      verified.length > 0 ? ` — across the ${verified.length} verified provider(s) above.` : '.'
    lines.push(`No declared floor rejected a token its adapter passes at top level${scope}`)
    if (withheld.length > 0) {
      const names = withheld.map((item) => item.kind).join(', ')
      lines.push(`This is NOT an all-clear for ${names}: nothing was proven about those floors.`)
    }
  }

  lines.push('')
  lines.push('Residual risk this run does NOT cover:')
  lines.push('  - CLIs installed by `curl | bash` (no enumerable versions) are never probed.')
  lines.push("  - Acceptance proves the parser knows the flag. It does NOT prove the CLI's")
  lines.push('    OUTPUT SHAPE matches what the adapter parses — a probe cannot decide that,')
  lines.push('    and it is the residual the invocation-surface snapshot cannot decide either.')
  lines.push('  - Subcommands and pinned literal values in the surface are not flag-shaped')
  lines.push('    and are therefore not probed.')
  lines.push("  - A flag is probed on its own, not in the adapter's full argument list. When a")
  lines.push('    top-level probe rejects, the flag is retried under every single candidate')
  lines.push(
    `    subcommand and every ordered pair (max ${MAX_SUBCOMMAND_CHAINS}); the rejection only stands as a`,
  )
  lines.push('    defect when every one of those also rejects it. Deeper chains are not tried.')
  lines.push('  - A CLI whose parser does not reject unknown flags detectably cannot be probed')
  lines.push('    at all. The sentinel self-test catches that and withholds every verdict for it,')
  lines.push('    but withholding is an absence of evidence — such a floor stays unverified.')
  lines.push('  - A CLI that writes parse errors to stdout instead of stderr would read as')
  lines.push('    "accepted"; classification deliberately reads stderr only. In practice the')
  lines.push('    sentinel self-test also catches this, since it reads the same stderr.')
  lines.push('  - Floors are only checked from below. Nothing here says a floor is not higher')
  lines.push('    than it needs to be.')

  return lines.join('\n')
}

// ============================================================
// CLI entry
// ============================================================

export function parseArgs(argv) {
  const options = {
    provider: null,
    json: false,
    help: false,
    snapshot: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  }

  // Every value-taking option validates its value the same way. Letting one of
  // them fall back to a default instead (as `--snapshot` used to) means a typo
  // silently checks something other than what was asked for.
  const requireValue = (value, message) => {
    if (value === undefined) throw new SetupError(message)
    return value
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--json') options.json = true
    else if (arg === '--provider') {
      options.provider = requireValue(argv[++i], '--provider needs a Provider kind')
    } else if (arg === '--snapshot') {
      options.snapshot = requireValue(argv[++i], '--snapshot needs a path')
    } else if (arg === '--timeout') {
      options.timeoutMs = Number(
        requireValue(argv[++i], '--timeout needs a positive number of milliseconds'),
      )
    } else throw new SetupError(`Unknown argument: ${arg}`)
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new SetupError('--timeout needs a positive number of milliseconds')
  }
  return options
}

const USAGE = `Verify each Provider's declared minVersion accepts the CLI tokens its adapter passes.

  node scripts/verify-provider-min-versions.mjs [options]

  --provider <kind>   check one Provider kind only
  --json              machine-readable output
  --snapshot <path>   invocation-surface snapshot (default: apps/api/src/engine/__tests__/)
  --timeout <ms>      per-probe timeout (default ${DEFAULT_TIMEOUT_MS})
  --help

Installs real CLIs from npm into a temp dir. Needs network; takes minutes.`

async function main(argv) {
  const options = parseArgs(argv)
  if (options.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }

  const presets = parsePresetProviders(readFileSync(PRESETS_PATH, 'utf8'))
  const snapshot = loadSnapshot({ snapshotPath: options.snapshot ?? DEFAULT_SNAPSHOT_PATH })

  if (options.provider && !presets.some((preset) => preset.kind === options.provider)) {
    throw new SetupError(
      `Unknown Provider kind: ${options.provider} (known: ${presets.map((p) => p.kind).join(', ')})`,
    )
  }

  const plan = planVerification({ presets, snapshot, only: options.provider })
  const report = await verifyPlan(plan, {
    installPackage: realInstallPackage,
    runProbe: realRunProbe,
    timeoutMs: options.timeoutMs,
  })

  process.stdout.write(
    options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`,
  )
  return report.rejected.length > 0 ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error instanceof SetupError ? error.message : error.stack}\n`)
      process.exit(2)
    })
}
