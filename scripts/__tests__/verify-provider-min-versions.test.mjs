import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  MAX_SUBCOMMAND_CHAINS,
  SENTINEL_FLAG,
  SNAPSHOT_SOURCE,
  SetupError,
  binaryFromCheckScript,
  classifyProbe,
  formatReport,
  isPlausibleVersionOutput,
  loadSnapshot,
  normalizeSurfaceToken,
  npmPackageFromInitScript,
  parseArgs,
  parsePresetProviders,
  pickVersionText,
  planVerification,
  probeEnv,
  probeFlag,
  probeSentinel,
  subcommandChains,
  surfaceFlags,
  surfaceSubcommands,
  verifyPlan,
  verifyProvider,
  withheldReason,
} from '../verify-provider-min-versions.mjs'

/**
 * Unit tests for the pure parts only. The exec/network boundary is injected
 * (`installPackage` / `runProbe`), so nothing here installs a package, spawns a
 * CLI, or touches npm — the live behaviour is what the script itself is for.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PRESETS_PATH = resolve(REPO_ROOT, 'packages/shared/src/schemas/provider.ts')

/** A probe result shaped like realRunProbe's return value. */
const probeResult = (over = {}) => ({
  stdout: '',
  stderr: '',
  exitCode: 0,
  timedOut: false,
  spawnError: null,
  ...over,
})

/** A CLI that rejects unknown flags detectably — the sentinel self-test passes. */
const rejectsUnknownFlags = (args) => probeResult({ stderr: `Error: Unknown option: ${args[0]}` })

/**
 * qodercli 1.0.0's real behaviour: an unknown flag prints the usage banner on
 * both streams and exits 0, so nothing the classifier reads says "rejected".
 */
const permissiveUsageBanner = () =>
  probeResult({
    stdout: 'Usage: qodercli [options] [command] [query...]',
    stderr: 'Usage: qodercli [options] [command] [query...]',
    exitCode: 0,
  })

describe('normalizeSurfaceToken', () => {
  it('strips a pinned value and keeps the flag', () => {
    assert.equal(normalizeSurfaceToken('--tools=read,grep'), '--tools')
    assert.equal(normalizeSurfaceToken('--tools=read,grep,find,ls'), '--tools')
    assert.equal(normalizeSurfaceToken('--mode=json'), '--mode')
    assert.equal(normalizeSurfaceToken('--sandbox=workspace-write'), '--sandbox')
    assert.equal(normalizeSurfaceToken('--allowedTools=mcp__*'), '--allowedTools')
  })

  it('keeps short flags and strips their values', () => {
    assert.equal(normalizeSurfaceToken('-p'), '-p')
    assert.equal(normalizeSurfaceToken('-c=model.name=${}'), '-c')
  })

  it('handles an interpolated value suffix', () => {
    assert.equal(normalizeSurfaceToken('--query-timeout=${}m'), '--query-timeout')
  })

  it('rejects tokens that are not flag-shaped', () => {
    // Subcommands and pinned literal values share the surface array with flags.
    assert.equal(normalizeSurfaceToken('exec'), null)
    assert.equal(normalizeSurfaceToken('stream-json'), null)
    assert.equal(normalizeSurfaceToken('about'), null)
    assert.equal(normalizeSurfaceToken('--'), null)
    assert.equal(normalizeSurfaceToken('-'), null)
    assert.equal(normalizeSurfaceToken(''), null)
    assert.equal(normalizeSurfaceToken(undefined), null)
    assert.equal(normalizeSurfaceToken(42), null)
  })
})

describe('surfaceFlags', () => {
  it('dedupes, sorts and drops non-flags', () => {
    assert.deepEqual(surfaceFlags(['--b=1', 'exec', '--a', '--b=2', '-p']), ['--a', '--b', '-p'])
  })

  it('tolerates a missing surface', () => {
    assert.deepEqual(surfaceFlags(undefined), [])
    assert.deepEqual(surfaceFlags(null), [])
  })
})

describe('surfaceSubcommands', () => {
  it('picks out the bare words an adapter may use as subcommands', () => {
    assert.deepEqual(surfaceSubcommands(['--json', 'provider', 'list', '-p']), ['list', 'provider'])
  })

  it('does not treat a pinned literal value as a subcommand candidate', () => {
    // `stream-json` is a value, but it is indistinguishable from a subcommand in
    // a flat surface — so it counts, and its only effect is to soften a verdict.
    assert.deepEqual(surfaceSubcommands(['--output-format', 'stream-json']), ['stream-json'])
  })

  it('returns nothing for an all-flag surface', () => {
    assert.deepEqual(surfaceSubcommands(['--offline', '--model', '--tools=read']), [])
    assert.deepEqual(surfaceSubcommands(undefined), [])
  })
})

describe('classifyProbe', () => {
  it('treats an argument-parser rejection as rejected', () => {
    assert.equal(
      classifyProbe(probeResult({ stderr: 'Error: Unknown option: --no-approve' })),
      'rejected',
    )
    assert.equal(classifyProbe(probeResult({ stderr: 'unknown flag: --foo' })), 'rejected')
    assert.equal(classifyProbe(probeResult({ stderr: 'Unknown argument --foo' })), 'rejected')
    assert.equal(classifyProbe(probeResult({ stderr: 'unrecognized option `--foo`' })), 'rejected')
    assert.equal(classifyProbe(probeResult({ stderr: 'invalid option -- x' })), 'rejected')
  })

  it('treats a credentials error as accepted — the parser got past the flag', () => {
    assert.equal(
      classifyProbe(
        probeResult({ stderr: 'No API key found for the selected model.', exitCode: 1 }),
      ),
      'accepted',
    )
  })

  it('treats a semantic value error as accepted', () => {
    assert.equal(
      classifyProbe(probeResult({ stderr: 'Error: Model "a2wave-probe" not found.', exitCode: 1 })),
      'accepted',
    )
  })

  it('treats silence as accepted', () => {
    assert.equal(classifyProbe(probeResult()), 'accepted')
  })

  it('reports an unusable probe rather than guessing', () => {
    assert.equal(classifyProbe(probeResult({ timedOut: true })), 'unprobeable')
    assert.equal(classifyProbe(probeResult({ spawnError: 'ENOENT' })), 'unprobeable')
  })

  it('reads stderr only — a rejection printed to stdout is a known blind spot', () => {
    assert.equal(classifyProbe(probeResult({ stdout: 'Unknown option: --foo' })), 'accepted')
  })
})

describe('isPlausibleVersionOutput', () => {
  it('accepts a version banner', () => {
    assert.equal(isPlausibleVersionOutput('0.83.0'), true)
    assert.equal(isPlausibleVersionOutput('qodercli version 1.0.48 (build abc)'), true)
    assert.equal(isPlausibleVersionOutput('  1.18.3\n'), true)
  })

  it('rejects output with no version-looking number', () => {
    assert.equal(isPlausibleVersionOutput('command not found'), false)
    assert.equal(isPlausibleVersionOutput(''), false)
    assert.equal(isPlausibleVersionOutput('   '), false)
    assert.equal(isPlausibleVersionOutput(undefined), false)
  })

  it('rejects a build that dumps its bundle instead of a version', () => {
    // The control gate exists for exactly this: qodercli@1.0.15 answers every
    // flag, --version included, with its JS bundle. Without the gate that build
    // reads as "missing every flag".
    const bundle = `'use strict';var a=1.0;${'x'.repeat(5000)}`
    assert.equal(isPlausibleVersionOutput(bundle), false)
  })

  it('rejects multi-line noise', () => {
    assert.equal(
      isPlausibleVersionOutput(Array.from({ length: 20 }, () => '1.2').join('\n')),
      false,
    )
  })
})

describe('pickVersionText', () => {
  it('prefers stdout and falls back to stderr', () => {
    assert.equal(pickVersionText({ stdout: '1.2.3', stderr: 'warn' }), '1.2.3')
    assert.equal(pickVersionText({ stdout: '  ', stderr: '4.5.6' }), '4.5.6')
    assert.equal(pickVersionText({}), '')
  })
})

describe('parsePresetProviders', () => {
  const source = readFileSync(PRESETS_PATH, 'utf8')

  it('parses every preset out of the real provider.ts', () => {
    const presets = parsePresetProviders(source)
    const kinds = presets.map((preset) => preset.kind)
    assert.ok(kinds.includes('pi'), `expected pi in ${kinds.join(',')}`)
    assert.ok(kinds.includes('qoder'))
    assert.ok(kinds.includes('cursor'))
    for (const preset of presets) {
      assert.ok(preset.checkScript, `${preset.kind} has no checkScript`)
      assert.notEqual(preset.minVersion, undefined, `${preset.kind} has no minVersion`)
    }
  })

  it('keeps a `//` that lives inside a string value', () => {
    // `curl https://cursor.com/install` would be truncated by naive comment stripping.
    const cursor = parsePresetProviders(source).find((preset) => preset.kind === 'cursor')
    assert.match(cursor.initScript, /^curl https:\/\/cursor\.com\/install/)
  })

  it('does not let a commented-out property shadow the real one', () => {
    const fixture = `const PRESET_PROVIDER_DEFS: PresetProvider[] = [
  {
    kind: 'demo',
    // minVersion: '9.9.9',
    initScript: 'npm i -g demo-cli',
    checkScript: 'demo --version',
    minVersion: '1.2.3',
  },
]`
    assert.deepEqual(parsePresetProviders(fixture), [
      {
        kind: 'demo',
        initScript: 'npm i -g demo-cli',
        checkScript: 'demo --version',
        minVersion: '1.2.3',
      },
    ])
  })

  it('reads properties packed onto one line', () => {
    // biome collapses a short entry onto a single line, so the parser cannot
    // assume one property per line.
    const fixture = `const PRESET_PROVIDER_DEFS: PresetProvider[] = [
  { kind: 'demo', initScript: 'npm i -g d', checkScript: 'd --version', minVersion: '2.0.0' },
]`
    assert.deepEqual(parsePresetProviders(fixture), [
      {
        kind: 'demo',
        initScript: 'npm i -g d',
        checkScript: 'd --version',
        minVersion: '2.0.0',
      },
    ])
  })

  it('ignores a key that only appears inside another value', () => {
    const fixture = `const PRESET_PROVIDER_DEFS: PresetProvider[] = [
  {
    kind: 'demo',
    description: 'needs minVersion: 9.9.9 or newer',
    initScript: 'npm i -g d',
    checkScript: 'd --version',
    minVersion: '1.2.3',
  },
]`
    assert.equal(parsePresetProviders(fixture)[0].minVersion, '1.2.3')
  })

  it('ignores a block-commented property', () => {
    const fixture = `const PRESET_PROVIDER_DEFS: PresetProvider[] = [
  {
    kind: 'demo',
    /* minVersion: '9.9.9', */
    initScript: 'npm i -g d',
    checkScript: 'd --version',
    minVersion: '1.2.3',
  },
]`
    assert.equal(parsePresetProviders(fixture)[0].minVersion, '1.2.3')
  })

  it('reads a null floor as null, not as absent', () => {
    const fixture = `const PRESET_PROVIDER_DEFS: PresetProvider[] = [
  { kind: 'demo', initScript: 'npm i -g d', checkScript: 'd --version', minVersion: null },
]`
    assert.equal(parsePresetProviders(fixture)[0].minVersion, null)
  })

  it('throws when the array is gone rather than silently reporting nothing', () => {
    assert.throws(() => parsePresetProviders('export const other = []'), /not found/)
  })

  it('throws when a preset has no minVersion property', () => {
    const fixture = `const PRESET_PROVIDER_DEFS: PresetProvider[] = [
  { kind: 'demo', initScript: 'npm i -g d', checkScript: 'd --version' },
]`
    assert.throws(() => parsePresetProviders(fixture), /no minVersion/)
  })
})

describe('npmPackageFromInitScript', () => {
  it('derives the package from an npm install line', () => {
    assert.equal(npmPackageFromInitScript('npm i -g @qoder-ai/qodercli'), '@qoder-ai/qodercli')
    assert.equal(npmPackageFromInitScript('npm i -g @openai/codex'), '@openai/codex')
    assert.equal(
      npmPackageFromInitScript('npm i -g --ignore-scripts @earendil-works/pi-coding-agent'),
      '@earendil-works/pi-coding-agent',
    )
    assert.equal(npmPackageFromInitScript('npm install -g foo'), 'foo')
  })

  it('strips a pinned version but keeps a scope', () => {
    assert.equal(npmPackageFromInitScript('npm i -g foo@1.2.3'), 'foo')
    assert.equal(npmPackageFromInitScript('npm i -g @scope/foo@1.2.3'), '@scope/foo')
  })

  it('returns null for CLIs that are not npm-distributed', () => {
    // curl|bash installers publish no enumerable versions, so a floor cannot be fetched.
    assert.equal(npmPackageFromInitScript('curl https://cursor.com/install -fsS | bash'), null)
    assert.equal(npmPackageFromInitScript('curl -fsSL https://claude.ai/install.sh | bash'), null)
    assert.equal(npmPackageFromInitScript('curl -fsSL https://opencode.ai/install | bash'), null)
    assert.equal(
      npmPackageFromInitScript('sh -c "$(curl -fsSL https://trae.cn/trae-cli/install.sh)"'),
      null,
    )
    assert.equal(npmPackageFromInitScript(''), null)
    assert.equal(npmPackageFromInitScript(undefined), null)
  })

  it('classifies every real preset', () => {
    const byKind = Object.fromEntries(
      parsePresetProviders(readFileSync(PRESETS_PATH, 'utf8')).map((preset) => [
        preset.kind,
        npmPackageFromInitScript(preset.initScript),
      ]),
    )
    assert.equal(byKind.qoder, '@qoder-ai/qodercli')
    assert.equal(byKind.kimi, '@moonshot-ai/kimi-code')
    assert.equal(byKind.pi, '@earendil-works/pi-coding-agent')
    assert.equal(byKind.cursor, null)
    assert.equal(byKind.trae, null)
  })
})

describe('binaryFromCheckScript', () => {
  it('takes the binary name', () => {
    assert.equal(binaryFromCheckScript('qodercli --version'), 'qodercli')
    assert.equal(binaryFromCheckScript('cursor-agent --version'), 'cursor-agent')
    assert.equal(binaryFromCheckScript(undefined), null)
  })
})

describe('loadSnapshot', () => {
  const snapshotPath = '/nowhere/cli-invocation-surface.snapshot.json'

  it('names the test that writes the snapshot when it is absent', () => {
    // Absence means the run cannot start, so the error must name the test that
    // regenerates the snapshot rather than just the missing path.
    assert.throws(
      () => loadSnapshot({ snapshotPath, fileExists: () => false }),
      (error) => {
        assert.ok(error instanceof SetupError)
        assert.match(error.message, /not found/)
        assert.match(error.message, new RegExp(SNAPSHOT_SOURCE))
        assert.match(error.message, /--snapshot/)
        return true
      },
    )
  })

  it('rejects invalid JSON', () => {
    assert.throws(
      () => loadSnapshot({ snapshotPath, fileExists: () => true, readFile: () => 'not json' }),
      /not valid JSON/,
    )
  })

  it('rejects a snapshot with no engines object', () => {
    assert.throws(
      () => loadSnapshot({ snapshotPath, fileExists: () => true, readFile: () => '{}' }),
      /no `engines` object/,
    )
  })

  it('returns the parsed snapshot', () => {
    const snapshot = loadSnapshot({
      snapshotPath,
      fileExists: () => true,
      readFile: () => JSON.stringify({ engines: { pi: { surface: ['--offline'] } } }),
    })
    assert.deepEqual(snapshot.engines.pi.surface, ['--offline'])
  })
})

describe('planVerification', () => {
  const presets = [
    {
      kind: 'pi',
      initScript: 'npm i -g pi-cli',
      checkScript: 'pi --version',
      minVersion: '0.83.0',
    },
    {
      kind: 'cursor',
      initScript: 'curl x | bash',
      checkScript: 'cursor-agent --version',
      minVersion: null,
    },
    {
      kind: 'trae',
      initScript: 'curl y | bash',
      checkScript: 'traecli --version',
      minVersion: '0.120.0',
    },
    {
      kind: 'codex',
      initScript: 'npm i -g @openai/codex',
      checkScript: 'codex --version',
      minVersion: null,
    },
    {
      kind: 'ghost',
      initScript: 'npm i -g ghost',
      checkScript: 'ghost --version',
      minVersion: '1.0.0',
    },
  ]
  const snapshot = {
    engines: {
      pi: { minVersion: '0.83.0', surface: ['--offline', '--model', 'run'] },
      cursor: { minVersion: null, surface: ['--force'] },
      trae: { minVersion: '0.120.0', surface: ['-p'] },
      codex: { minVersion: null, surface: ['exec'] },
    },
  }

  it('plans only the Providers that have a floor, an npm source and a snapshot entry', () => {
    const plan = planVerification({ presets, snapshot })
    assert.deepEqual(
      plan.checks.map((check) => check.kind),
      ['pi'],
    )
    assert.deepEqual(plan.checks[0].flags, ['--model', '--offline'])
    assert.equal(plan.checks[0].binary, 'pi')
    assert.equal(plan.checks[0].npmPackage, 'pi-cli')
    assert.deepEqual(plan.checks[0].subcommands, ['run'])
  })

  it('records why each Provider was skipped', () => {
    const reasons = Object.fromEntries(
      planVerification({ presets, snapshot }).skipped.map((skip) => [skip.kind, skip.reasons]),
    )
    assert.deepEqual(reasons.cursor, ['no declared minVersion floor', 'not npm-distributed'])
    assert.deepEqual(reasons.trae, ['not npm-distributed'])
    assert.deepEqual(reasons.codex, ['no declared minVersion floor'])
    assert.deepEqual(reasons.ghost, ['no snapshot entry'])
  })

  it('skips a Provider whose surface has no flag-shaped token', () => {
    const plan = planVerification({
      presets: [
        { kind: 'x', initScript: 'npm i -g x', checkScript: 'x --version', minVersion: '1.0.0' },
      ],
      snapshot: { engines: { x: { surface: ['run', 'models'] } } },
    })
    assert.equal(plan.checks.length, 0)
    assert.deepEqual(plan.skipped[0].reasons, ['no flag-shaped tokens in surface'])
  })

  it('honours --provider by reporting nothing about the others', () => {
    const plan = planVerification({ presets, snapshot, only: 'pi' })
    assert.equal(plan.checks.length, 1)
    assert.equal(plan.skipped.length, 0)
  })
})

describe('probeFlag', () => {
  const context = { binPath: '/bin/fake', cwd: '/tmp', timeoutMs: 100 }

  it('accepts a boolean flag on the bare probe without a retry', async () => {
    const calls = []
    const runProbe = (options) => {
      calls.push(options.args)
      return probeResult()
    }
    const result = await probeFlag('--offline', { ...context, runProbe })
    assert.equal(result.verdict, 'accepted')
    assert.equal(result.acceptedAs, 'bare')
    assert.deepEqual(calls, [['--offline']])
  })

  it('retries a value-taking flag that the bare probe reports as unknown', async () => {
    // pi 0.83.0 answers `--model` with no value using the same "Unknown option"
    // wording it uses for a flag it has never heard of. Without the retry the
    // script invents defects.
    const calls = []
    const runProbe = ({ args }) => {
      calls.push(args)
      return args.length === 1
        ? probeResult({ stderr: 'Error: Unknown option: --model' })
        : probeResult({ stderr: 'Error: Model "a2wave-probe" not found.' })
    }
    const result = await probeFlag('--model', { ...context, runProbe })
    assert.equal(result.verdict, 'accepted')
    assert.equal(result.acceptedAs, 'with-value')
    assert.deepEqual(calls, [['--model'], ['--model', 'a2wave-probe']])
    assert.match(result.evidence, /not found/)
  })

  it('rejects only when both shapes are rejected and the adapter has no subcommands', async () => {
    const runProbe = () => probeResult({ stderr: 'Error: Unknown option: --no-approve' })
    const result = await probeFlag('--no-approve', { ...context, runProbe, subcommands: [] })
    assert.equal(result.verdict, 'rejected')
    assert.equal(result.acceptedAs, null)
    assert.match(result.evidence, /Unknown option/)
  })

  it('will not call a subcommand-scoped flag a defect', async () => {
    // kimi only ever passes --json as `kimi provider list --json`; `kimi --json`
    // rejecting says nothing about the floor. The excuse is now evidence-based:
    // the flag has to actually parse under some chain we can reproduce.
    const runProbe = ({ args }) =>
      args[0] === 'provider' && args[1] === 'list'
        ? probeResult({ stderr: 'Error: no API key configured', exitCode: 1 })
        : probeResult({ stderr: "error: unknown option '--json'" })
    const result = await probeFlag('--json', {
      ...context,
      runProbe,
      subcommands: ['list', 'provider'],
    })
    assert.equal(result.verdict, 'inconclusive')
    assert.deepEqual(result.subcommands, ['list', 'provider'])
    // Naming the chain is the point — a bare "inconclusive" is not checkable by hand.
    assert.deepEqual(result.resolvedUnder, ['provider', 'list'])
  })

  it('still calls a top-level flag a defect on a mixed surface', async () => {
    // The regression this replaces: qoder and opencode both carry top-level flags
    // AND a `status` subcommand, and the old blanket rule excused every rejection
    // on any surface with a bare word in it. A rejection the subcommands cannot
    // explain is a defect, subcommands present or not.
    const runProbe = () => probeResult({ stderr: "error: unknown option '--list-models'" })
    const result = await probeFlag('--list-models', {
      ...context,
      runProbe,
      subcommands: ['status'],
    })
    assert.equal(result.verdict, 'rejected')
    assert.equal(result.chainsProbed, 1)
    assert.match(result.evidence, /unknown option/)
  })

  it('treats an unprobeable subcommand chain as missing evidence, not as proof', async () => {
    // A timeout under a subcommand rules nothing out. Erring toward "inconclusive"
    // keeps the tool from inventing a defect out of a flaky probe.
    const runProbe = ({ args }) =>
      args[0] === 'run' ? probeResult({ timedOut: true }) : rejectsUnknownFlags(args)
    const result = await probeFlag('--x', { ...context, runProbe, subcommands: ['run'] })
    assert.equal(result.verdict, 'inconclusive')
    assert.equal(result.scopedVerdict, 'unprobeable')
  })

  it('passes an unprobeable bare result through without a retry', async () => {
    let calls = 0
    const runProbe = () => {
      calls++
      return probeResult({ timedOut: true })
    }
    const result = await probeFlag('--x', { ...context, runProbe })
    assert.equal(result.verdict, 'unprobeable')
    assert.equal(result.acceptedAs, null)
    assert.equal(calls, 1)
  })

  it('keeps the bare rejection as evidence when the retry is unprobeable', async () => {
    // Otherwise the flag is reported with `evidence: ''` and the one thing the
    // run did observe — the CLI's own rejection wording — is thrown away.
    const runProbe = ({ args }) =>
      args.length === 1
        ? probeResult({ stderr: 'Error: Unknown option: --model' })
        : probeResult({ timedOut: true })
    const result = await probeFlag('--model', { ...context, runProbe })
    assert.equal(result.verdict, 'unprobeable')
    assert.match(result.evidence, /Unknown option: --model/)
  })
})

describe('subcommandChains', () => {
  it('tries every single word first, then every ordered pair', () => {
    // Ordered pairs are required, not thorough-for-its-own-sake: `kimi --json` is
    // really `kimi provider list --json`, and the snapshot stores the words sorted.
    assert.deepEqual(subcommandChains(['list', 'provider']), [
      ['list'],
      ['provider'],
      ['list', 'provider'],
      ['provider', 'list'],
    ])
  })

  it('returns nothing when the adapter uses no subcommands', () => {
    assert.deepEqual(subcommandChains([]), [])
  })

  it('bounds the search so one rejected flag cannot become a probe storm', () => {
    const many = ['a', 'b', 'c', 'd', 'e']
    assert.equal(subcommandChains(many).length, MAX_SUBCOMMAND_CHAINS)
    assert.equal(subcommandChains(many, 3).length, 3)
  })
})

describe('probeSentinel', () => {
  const context = { binPath: '/bin/fake', cwd: '/tmp', timeoutMs: 100 }

  it('is rejected by a CLI that reports unknown flags', async () => {
    const result = await probeSentinel({
      ...context,
      runProbe: ({ args }) => rejectsUnknownFlags(args),
    })
    assert.equal(result.verdict, 'rejected')
  })

  it('is accepted by a CLI that answers an impossible flag with its usage banner', async () => {
    const result = await probeSentinel({ ...context, runProbe: permissiveUsageBanner })
    assert.equal(result.verdict, 'accepted')
  })

  it('probes the sentinel through the same two-phase path a real flag takes', async () => {
    // A CLI that says "Unknown option" for any flag given no value (pi does) must
    // not be failed for a difference in how it was probed.
    const calls = []
    const runProbe = ({ args }) => {
      calls.push(args)
      return args.length === 1 ? rejectsUnknownFlags(args) : probeResult()
    }
    const result = await probeSentinel({ ...context, runProbe })
    assert.deepEqual(calls, [[SENTINEL_FLAG], [SENTINEL_FLAG, 'a2wave-probe']])
    assert.equal(result.verdict, 'accepted')
  })

  it('never prefixes the sentinel with a subcommand', async () => {
    // The sentinel exists nowhere, so a subcommand cannot excuse it — passing one
    // would only give a permissive parser another way to look fine.
    const calls = []
    const runProbe = ({ args }) => {
      calls.push(args)
      return rejectsUnknownFlags(args)
    }
    await probeSentinel({ ...context, runProbe, subcommands: ['status'], prefix: ['status'] })
    assert.deepEqual(calls, [[SENTINEL_FLAG], [SENTINEL_FLAG, 'a2wave-probe']])
  })
})

describe('probeEnv', () => {
  const SANDBOX = '/tmp/a2wave-minver-sandbox'

  /** Set variables for one call and always put the real environment back. */
  const withEnv = (vars, body) => {
    const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
    Object.assign(process.env, vars)
    try {
      return body()
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }

  it('is an allowlist — it forwards exactly these keys and nothing else', () => {
    // The assertion is deliberately exhaustive. A denylist could only exclude the
    // credential names someone thought of, so the guard here is the key set
    // itself: adding a passthrough must fail this test and be argued for.
    assert.deepEqual(Object.keys(probeEnv(SANDBOX)).sort(), [
      'CI',
      'HOME',
      'LANG',
      'LC_ALL',
      'NO_COLOR',
      'PATH',
      'TMPDIR',
    ])
  })

  it('keeps credential-shaped variables away from the probed binary', () => {
    // None of these end in API_KEY/AUTH_TOKEN/ACCESS_TOKEN, so the previous
    // denylist forwarded every one of them into a third-party npm build.
    const credentials = {
      GITHUB_TOKEN: 'canary-github',
      NPM_TOKEN: 'canary-npm',
      GITLAB_TOKEN: 'canary-gitlab',
      PRIVATE_TOKEN: 'canary-private',
      AWS_SECRET_ACCESS_KEY: 'canary-aws',
      DB_PASSWORD: 'canary-password',
      SSH_AUTH_SOCK: '/tmp/canary-agent.sock',
      ANTHROPIC_API_KEY: 'canary-anthropic',
    }
    withEnv(credentials, () => {
      const env = probeEnv(SANDBOX)
      for (const key of Object.keys(credentials)) {
        assert.equal(env[key], undefined, `${key} must not reach the probed binary`)
      }
      const values = Object.values(env).join('\n')
      for (const value of Object.values(credentials)) {
        assert.ok(!values.includes(value), `${value} leaked through another key`)
      }
    })
  })

  it('points HOME and TMPDIR at the throwaway install dir', () => {
    // Not only hardening: a CLI that found a logged-in session under the real
    // HOME would take a different branch, and the probe would misclassify.
    withEnv({ HOME: '/Users/real', TMPDIR: '/var/real-tmp' }, () => {
      const env = probeEnv(SANDBOX)
      assert.equal(env.HOME, SANDBOX)
      assert.equal(env.TMPDIR, SANDBOX)
    })
  })

  it('forwards PATH, without which the `env node` shebang cannot resolve', () => {
    withEnv({ PATH: '/usr/bin:/bin' }, () => {
      assert.equal(probeEnv(SANDBOX).PATH, '/usr/bin:/bin')
    })
  })

  it('pins the deterministic output settings the classifier reads', () => {
    const env = probeEnv(SANDBOX)
    assert.equal(env.NO_COLOR, '1')
    assert.equal(env.CI, '1')
    assert.equal(env.LANG, 'C.UTF-8')
    assert.equal(env.LC_ALL, 'C.UTF-8')
  })

  it('drops NODE_OPTIONS and the XDG paths that would undo the HOME redirect', () => {
    withEnv(
      {
        NODE_OPTIONS: '--require /tmp/evil.js',
        XDG_CONFIG_HOME: '/Users/real/.config',
        XDG_DATA_HOME: '/Users/real/.local/share',
      },
      () => {
        const env = probeEnv(SANDBOX)
        assert.equal(env.NODE_OPTIONS, undefined)
        assert.equal(env.XDG_CONFIG_HOME, undefined)
        assert.equal(env.XDG_DATA_HOME, undefined)
      },
    )
  })
})

describe('verifyProvider', () => {
  const check = {
    kind: 'pi',
    minVersion: '0.83.0',
    npmPackage: 'pi-cli',
    binary: 'pi',
    flags: ['--offline'],
  }

  it('reports an install failure instead of throwing', async () => {
    const result = await verifyProvider(check, {
      installPackage: () => ({ ok: false, error: 'No matching version found' }),
      runProbe: () => assert.fail('must not probe after a failed install'),
    })
    assert.equal(result.status, 'install-failed')
    assert.match(result.error, /No matching version/)
    assert.deepEqual(result.tokens, [])
  })

  it('withholds flag verdicts when the control gate fails', async () => {
    // A build that answers everything identically must read as unprobeable, not
    // as "missing every flag".
    let cleaned = false
    const result = await verifyProvider(check, {
      installPackage: () => ({
        ok: true,
        binPath: '/bin/pi',
        cwd: '/tmp',
        cleanup: () => {
          cleaned = true
        },
      }),
      runProbe: () => probeResult({ stdout: `'use strict';${'x'.repeat(5000)}` }),
    })
    assert.equal(result.status, 'unprobeable')
    assert.equal(result.control.ok, false)
    assert.deepEqual(result.tokens, [])
    assert.match(result.error, /no usable version banner/)
    assert.equal(cleaned, true)
  })

  it('withholds every verdict when the classifier self-test fails', async () => {
    // The defect this exists for: qodercli 1.0.0 answers `--version` with a clean
    // `1.0.0` (control gate passes) and every unknown flag with its usage banner
    // on exit 0. Every flag then classified `accepted` and the tool reported a
    // confident all-clear for a floor it had never actually tested.
    let cleaned = false
    const result = await verifyProvider(
      { ...check, kind: 'qoder', binary: 'qodercli', flags: ['--list-models', '--resume'] },
      {
        installPackage: () => ({
          ok: true,
          binPath: '/bin/qodercli',
          cwd: '/tmp',
          cleanup: () => {
            cleaned = true
          },
        }),
        runProbe: ({ args }) =>
          args[0] === '--version' ? probeResult({ stdout: '1.0.0' }) : permissiveUsageBanner(),
      },
    )
    assert.equal(result.status, 'unprobeable')
    assert.equal(result.reason, 'permissive-parser')
    assert.equal(result.control.ok, true, 'the control gate itself passed — a different failure')
    assert.equal(result.sentinel.verdict, 'accepted')
    assert.deepEqual(result.tokens, [], 'no flag may be reported as accepted on this CLI')
    assert.match(result.error, new RegExp(SENTINEL_FLAG))
    assert.equal(cleaned, true)
  })

  it('stops before probing any real flag when the self-test fails', async () => {
    const probed = []
    await verifyProvider(
      { ...check, flags: ['--offline', '--model'] },
      {
        installPackage: () => ({ ok: true, binPath: '/bin/pi', cwd: '/tmp', cleanup: () => {} }),
        runProbe: ({ args }) => {
          probed.push(args[0])
          return args[0] === '--version' ? probeResult({ stdout: '0.83.0' }) : probeResult()
        },
      },
    )
    assert.deepEqual(probed, ['--version', SENTINEL_FLAG])
  })

  it('probes each flag once the control gate and the self-test pass', async () => {
    const result = await verifyProvider(
      { ...check, flags: ['--offline', '--nope'] },
      {
        installPackage: () => ({ ok: true, binPath: '/bin/pi', cwd: '/tmp', cleanup: () => {} }),
        runProbe: ({ args }) => {
          if (args[0] === '--version') return probeResult({ stdout: '0.83.0' })
          if (args[0] === SENTINEL_FLAG) return rejectsUnknownFlags(args)
          if (args[0] === '--nope') return probeResult({ stderr: 'Unknown option: --nope' })
          return probeResult()
        },
      },
    )
    assert.equal(result.status, 'checked')
    assert.equal(result.control.output, '0.83.0')
    assert.equal(result.sentinel.verdict, 'rejected')
    assert.deepEqual(
      result.tokens.map((token) => [token.token, token.verdict]),
      [
        ['--offline', 'accepted'],
        ['--nope', 'rejected'],
      ],
    )
  })

  it('cleans up the temp install even when a probe throws', async () => {
    let cleaned = false
    await assert.rejects(
      verifyProvider(check, {
        installPackage: () => ({
          ok: true,
          binPath: '/bin/pi',
          cwd: '/tmp',
          cleanup: () => {
            cleaned = true
          },
        }),
        runProbe: () => {
          throw new Error('boom')
        },
      }),
      /boom/,
    )
    assert.equal(cleaned, true)
  })
})

describe('verifyPlan', () => {
  it('separates real defects from subcommand-scoped ambiguity', async () => {
    const plan = {
      checks: [
        {
          kind: 'pi',
          minVersion: '0.78.1',
          npmPackage: 'p',
          binary: 'pi',
          flags: ['--no-approve'],
          subcommands: [],
        },
        {
          kind: 'kimi',
          minVersion: '0.30.0',
          npmPackage: 'k',
          binary: 'kimi',
          flags: ['--json'],
          subcommands: ['list', 'provider'],
        },
      ],
      skipped: [{ kind: 'trae', minVersion: '0.120.0', reasons: ['not npm-distributed'] }],
    }
    const report = await verifyPlan(plan, {
      installPackage: () => ({ ok: true, binPath: '/bin/x', cwd: '/tmp', cleanup: () => {} }),
      runProbe: ({ args }) => {
        if (args[0] === '--version') return probeResult({ stdout: '1.0.0' })
        // kimi's --json genuinely parses, but only as `kimi provider list --json`.
        if (args[0] === 'provider' && args[1] === 'list') return probeResult()
        return probeResult({ stderr: `unknown option ${args[0]}` })
      },
    })
    assert.deepEqual(report.rejected, [
      { kind: 'pi', minVersion: '0.78.1', token: '--no-approve', subcommands: [] },
    ])
    assert.deepEqual(report.inconclusive, [
      { kind: 'kimi', minVersion: '0.30.0', token: '--json', subcommands: ['list', 'provider'] },
    ])
    assert.equal(report.results.length, 2)
    assert.equal(report.skipped.length, 1)
  })

  it('names which Providers produced evidence and which produced none', async () => {
    // Silence must never read as success: a caller reading only `rejected` would
    // see an empty array for a run that verified nothing at all.
    const plan = {
      checks: [
        { kind: 'pi', minVersion: '0.83.0', npmPackage: 'p', binary: 'pi', flags: ['--offline'] },
        {
          kind: 'qoder',
          minVersion: '1.0.0',
          npmPackage: 'q',
          binary: 'qodercli',
          flags: ['--list-models'],
        },
      ],
      skipped: [],
    }
    const report = await verifyPlan(plan, {
      installPackage: () => ({ ok: true, binPath: '/bin/x', cwd: '/tmp', cleanup: () => {} }),
      runProbe: ({ args }) =>
        args[0] === '--version' ? probeResult({ stdout: '1.0.0' }) : probeResult(),
    })
    // Both CLIs above answer every flag with silence, so neither can reject the
    // sentinel and neither may contribute a verdict.
    assert.deepEqual(report.verified, [])
    assert.deepEqual(
      report.withheld.map((item) => item.kind),
      ['pi', 'qoder'],
    )
    assert.match(report.withheld[0].reason, /too permissive/)
    assert.deepEqual(report.rejected, [])
  })

  it('counts a Provider as verified once its self-test passes', async () => {
    const plan = {
      checks: [
        { kind: 'pi', minVersion: '0.83.0', npmPackage: 'p', binary: 'pi', flags: ['--offline'] },
      ],
      skipped: [],
    }
    const report = await verifyPlan(plan, {
      installPackage: () => ({ ok: true, binPath: '/bin/pi', cwd: '/tmp', cleanup: () => {} }),
      runProbe: ({ args }) => {
        if (args[0] === '--version') return probeResult({ stdout: '0.83.0' })
        if (args[0] === SENTINEL_FLAG) return rejectsUnknownFlags(args)
        return probeResult()
      },
    })
    assert.deepEqual(report.verified, [{ kind: 'pi', minVersion: '0.83.0', flagsProbed: 1 }])
    assert.deepEqual(report.withheld, [])
  })
})

describe('withheldReason', () => {
  it('distinguishes a broken build from a parser that cannot be probed', () => {
    // Same status, different fix: one means "this published build is broken",
    // the other means "acceptance probing does not work on this CLI".
    assert.match(withheldReason({ status: 'unprobeable', reason: 'control-gate' }), /--version/)
    assert.match(
      withheldReason({ status: 'unprobeable', reason: 'permissive-parser' }),
      /too permissive/,
    )
    assert.match(
      withheldReason({ status: 'install-failed', minVersion: '1.0.0' }),
      /could not install 1\.0\.0/,
    )
  })
})

describe('formatReport', () => {
  const baseReport = {
    results: [],
    skipped: [{ kind: 'trae', minVersion: '0.120.0', reasons: ['not npm-distributed'] }],
    rejected: [],
  }

  it('always states what was not checked', () => {
    const text = formatReport(baseReport)
    assert.match(text, /Not checked:/)
    assert.match(text, /trae: not npm-distributed/)
    assert.match(text, /curl \| bash/)
    assert.match(text, /OUTPUT SHAPE/)
  })

  it('spells out the defect when a floor rejects a token', () => {
    const text = formatReport({
      ...baseReport,
      rejected: [{ kind: 'pi', minVersion: '0.78.1', token: '--no-approve' }],
    })
    assert.match(text, /DEFECT/)
    assert.match(text, /pi@0\.78\.1 rejects --no-approve/)
    assert.match(text, /provider\.ts/)
  })

  it('marks a flag that only parses with a value', () => {
    const text = formatReport({
      ...baseReport,
      results: [
        {
          kind: 'pi',
          minVersion: '0.83.0',
          npmPackage: 'p',
          binary: 'pi',
          status: 'checked',
          control: { ok: true, output: '0.83.0' },
          tokens: [
            { token: '--model', verdict: 'accepted', acceptedAs: 'with-value', evidence: '' },
          ],
        },
      ],
    })
    assert.match(text, /--model \(takes a value\)/)
  })

  it('reports an inconclusive token separately from a defect', () => {
    const text = formatReport({
      ...baseReport,
      inconclusive: [
        { kind: 'kimi', minVersion: '0.30.0', token: '--json', subcommands: ['list', 'provider'] },
      ],
    })
    assert.match(text, /Inconclusive/)
    assert.match(text, /list, provider/)
    assert.doesNotMatch(text, /DEFECT/)
  })

  it('renders a failed control gate as withheld, not as missing flags', () => {
    const text = formatReport({
      ...baseReport,
      results: [
        {
          kind: 'qoder',
          minVersion: '1.0.0',
          npmPackage: 'q',
          binary: 'qodercli',
          status: 'unprobeable',
          reason: 'control-gate',
          control: { ok: false, output: 'bundle...' },
          error: 'no usable version banner',
          tokens: [],
        },
      ],
    })
    assert.match(text, /control gate FAILED/)
    assert.match(text, /withheld as unreliable/)
  })

  it('distinguishes a permissive parser from a broken build', () => {
    // A reader has to be able to tell "this build is broken" from "this CLI's
    // parser is too permissive to probe" — the fixes are nothing alike.
    const text = formatReport({
      ...baseReport,
      results: [
        {
          kind: 'qoder',
          minVersion: '1.0.0',
          npmPackage: 'q',
          binary: 'qodercli',
          status: 'unprobeable',
          reason: 'permissive-parser',
          control: { ok: true, output: '1.0.0' },
          sentinel: { token: SENTINEL_FLAG, verdict: 'accepted', evidence: 'Usage: qodercli' },
          error: 'sentinel accepted',
          tokens: [],
        },
      ],
    })
    assert.match(text, /control gate ok/)
    assert.match(text, /classifier self-test FAILED/)
    assert.match(text, new RegExp(SENTINEL_FLAG))
    assert.match(text, /no evidence, NOT a pass/)
    assert.doesNotMatch(text, /control gate FAILED/)
  })

  it('names what was verified and what was withheld', () => {
    const text = formatReport({
      ...baseReport,
      verified: [{ kind: 'pi', minVersion: '0.83.0', flagsProbed: 14 }],
      withheld: [{ kind: 'qoder', minVersion: '1.0.0', reason: 'parser too permissive to probe' }],
    })
    assert.match(text, /Verified — 1 provider\(s\)/)
    assert.match(text, /pi@0\.83\.0 \(14 flag\(s\)\)/)
    assert.match(text, /Withheld — 1 provider\(s\) produced NO evidence/)
    assert.match(text, /absence of evidence, not a pass/)
  })

  it('refuses to let a clean run read as an all-clear when something was withheld', () => {
    // The whole defect: an empty `rejected` list next to a withheld Provider used
    // to print as an unqualified "no floor rejected a token".
    const text = formatReport({
      ...baseReport,
      verified: [],
      withheld: [{ kind: 'qoder', minVersion: '1.0.0', reason: 'parser too permissive to probe' }],
      rejected: [],
    })
    assert.match(text, /NOT an all-clear for qoder/)
    assert.match(text, /nothing was proven/)
  })
})

describe('parseArgs', () => {
  it('parses the supported options', () => {
    const options = parseArgs([
      '--provider',
      'pi',
      '--json',
      '--snapshot',
      '/tmp/s.json',
      '--timeout',
      '5000',
    ])
    assert.equal(options.provider, 'pi')
    assert.equal(options.json, true)
    assert.equal(options.snapshot, '/tmp/s.json')
    assert.equal(options.timeoutMs, 5000)
  })

  it('defaults to checking everything as text', () => {
    const options = parseArgs([])
    assert.equal(options.provider, null)
    assert.equal(options.json, false)
    assert.equal(options.snapshot, null)
    assert.ok(options.timeoutMs > 0)
  })

  it('rejects an unknown argument rather than ignoring it', () => {
    assert.throws(() => parseArgs(['--wat']), SetupError)
  })

  it('rejects a --provider with no value', () => {
    assert.throws(() => parseArgs(['--provider']), /--provider needs/)
  })

  it('rejects a --snapshot with no value instead of silently using the default', () => {
    // Falling back to the default here means a typo checks something other than
    // what was asked for, and says nothing about having done so.
    assert.throws(() => parseArgs(['--snapshot']), /--snapshot needs a path/)
    assert.throws(() => parseArgs(['--json', '--snapshot']), SetupError)
  })

  it('rejects a --timeout with no value', () => {
    assert.throws(() => parseArgs(['--timeout']), /positive number/)
  })

  it('rejects a non-numeric timeout', () => {
    assert.throws(() => parseArgs(['--timeout', 'soon']), /positive number/)
    assert.throws(() => parseArgs(['--timeout', '0']), /positive number/)
  })
})
