#!/usr/bin/env node
/**
 * Architecture gates — lock in a2wave's layering and import boundaries to prevent regressions
 * (currently 0 violations).
 * By default only staged sources are scanned (for pre-commit); pass --all to scan every tracked
 * source file (for a baseline sweep).
 *
 * Rules (per AGENTS.md L7-13/469/332 and docs/agent/i18n.md L8-10):
 *   R1  apps must not import each other (web/api/cli may depend only on packages/shared)
 *   R2  packages/shared/src must not import any app, and must not use the @/ alias
 *   R3  the @/ alias is limited to apps/web/src
 *   R4  @ts-ignore / @ts-nocheck are forbidden (@ts-expect-error is allowed)
 *   R5  the key sets of apps/web/src/locales/zh.json and en.json must be aligned
 *   R7  every audit action/resource written by apps/api must have zh + en copy
 *   R8  apps/web's antd feedback APIs (message/notification/Modal.confirm) must go through lib/antd-static
 *
 * A violation prints "rule file:line reason + fix hint" and exits 1.
 * Allowlist: scripts/gates/arch-rules-allowlist.json (each entry carries rule/path/reason).
 *
 * Second-wave backlog (not implemented here — semi-mechanical/heuristic, and false positives would
 * need long-term allowlist tuning):
 *   R6  forbid bypassing via --no-verify (a hook cannot block it; CI is the backstop)
 *   R9  apps/web must not pull in @radix-ui/* / cmdk / shadcn
 *   R12 forbid hand-editing drizzle/meta or adding migration SQL that was not generated
 *   R13 align apps/api env.ts's zod keys with .env.example
 */
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ALLOWLIST_PATH = resolve(ROOT, 'scripts/gates/arch-rules-allowlist.json')

const scanAll = process.argv.includes('--all')

/**
 * Read the list of files to check (POSIX paths relative to the repo root).
 * -c core.quotepath=false keeps non-ASCII paths from being C-quoted; --diff-filter=ACMR includes renames.
 */
function listFiles() {
  const cmd = scanAll
    ? 'git -c core.quotepath=false ls-files'
    : 'git -c core.quotepath=false diff --cached --name-only --diff-filter=ACMR'
  const out = execSync(cmd, { cwd: ROOT, encoding: 'utf8' })
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

/** Only check ts/tsx/js/jsx/mjs/cjs sources under apps/**\/src and packages/**\/src. */
function isSource(file) {
  if (!/^(apps|packages)\/[^/]+\/src\//.test(file)) return false
  return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)
}

/** Which top-level package a file belongs to: apps/web → 'web', packages/shared → 'shared'. */
function packageOf(file) {
  const m = file.match(/^(apps|packages)\/([^/]+)\//)
  return m ? m[2] : null
}

/** Read staged or working-tree content (--all uses the working tree, pre-commit the index). */
function readContent(file) {
  if (scanAll) {
    const abs = resolve(ROOT, file)
    return existsSync(abs) ? readFileSync(abs, 'utf8') : ''
  }
  try {
    // execFileSync is parameterised so filenames never reach a shell (names with spaces/$()/backticks
    // are neither skipped nor injected).
    return execFileSync('git', ['show', `:${file}`], { cwd: ROOT, encoding: 'utf8' })
  } catch {
    return ''
  }
}

function loadAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return []
  try {
    return JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'))
  } catch {
    return []
  }
}

const APP_NAMES = ['web', 'api', 'cli']
// Published package name → app directory name, used to spot cross-app imports written by package name.
const APP_PKG_TO_DIR = {
  '@a2wave/web': 'web',
  '@a2wave/api': 'api',
  a2wave: 'cli',
}

// Extract every import/require/export-from source string in the file.
// [\s\S]*? matches across lines, handling multi-line imports produced by biome's wrapping
// (a `} from '...'` continuation is no longer missed).
const IMPORT_RE =
  /(?:import|export)\b[\s\S]*?from\s*['"]([^'"]+)['"]|(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g

/** Extract imports from file content, returning [{spec, line}] where line is the statement's start. */
function importSources(content) {
  const out = []
  IMPORT_RE.lastIndex = 0
  let m = IMPORT_RE.exec(content)
  while (m !== null) {
    const spec = m[1] || m[2] || m[3]
    // Derive the line number from the match's start offset (the keyword's own line).
    const line = content.slice(0, m.index).split('\n').length
    out.push({ spec, line })
    m = IMPORT_RE.exec(content)
  }
  return out
}

/** Resolve a relative import to the app it lands in (for R1); returns null when it is not an app. */
function resolveRelativeApp(fromFile, spec) {
  if (!spec.startsWith('.')) return null
  const abs = resolve(ROOT, dirname(fromFile), spec)
  const rel = abs.slice(ROOT.length + 1).replace(/\\/g, '/')
  const m = rel.match(/^apps\/([^/]+)\//)
  return m ? m[1] : null
}

const violations = []
function report(rule, file, line, msg, fix) {
  violations.push({ rule, file, line, msg, fix })
}

/**
 * R8: antd feedback APIs must go through lib/antd-static.
 *
 * `import { message } from 'antd'` yields the static instance: it renders outside the React tree,
 * escaping `<StyleProvider layer>`, so the antd reset it injects is not inside `@layer antd`.
 * Unlayered styles always outrank layered ones, so the global `a` reset repaints every sidebar link
 * link-blue — global style pollution unrelated to the call site, appearing only after the first toast.
 *
 * Only static feedback APIs (message/notification) and static calls like `Modal.confirm` are blocked;
 * components such as `<Modal>` / `<Select>` render inside the tree, are unaffected, and are still
 * imported from 'antd' as usual.
 */
const ANTD_STATIC_FEEDBACK = ['message', 'notification']

function checkAntdStaticFeedback(file, content) {
  if (!file.startsWith('apps/web/')) return
  if (file.includes('lib/antd-static')) return // the bridge layer itself

  // For each `import { ... } from 'antd'`, take the named bindings inside the braces (the original
  // name, before any `as`).
  const namedFromAntd = /import\s*\{([^}]*)\}\s*from\s*['"]antd['"]/g
  let m = namedFromAntd.exec(content)
  while (m !== null) {
    const names = m[1]
      .split(',')
      .map((s) =>
        s
          .trim()
          .split(/\s+as\s+/)[0]
          .trim(),
      )
      .filter(Boolean)
    const hit = names.filter((n) => ANTD_STATIC_FEEDBACK.includes(n))
    if (hit.length > 0) {
      const lineNo = content.slice(0, m.index).split('\n').length
      report(
        'R8',
        file,
        lineNo,
        `imports static feedback APIs directly from 'antd' (${hit.join(', ')})`,
        "Use import { message } from '@/lib/antd-static' instead: the static instance renders outside the StyleProvider layer and its unlayered `a` reset repaints sidebar links blue.",
      )
    }
    m = namedFromAntd.exec(content)
  }

  // Static calls like Modal.confirm / Modal.info have the same problem (the <Modal> component does not).
  const staticModal = /\bModal\.(confirm|info|success|error|warning)\s*\(/.exec(content)
  if (staticModal) {
    const lineNo = content.slice(0, staticModal.index).split('\n').length
    report(
      'R8',
      file,
      lineNo,
      `uses the antd static modal ${staticModal[0].replace(/\s*\($/, '()')}`,
      "Import { modal } from '@/lib/antd-static' and call modal.confirm() instead; otherwise it likewise escapes the StyleProvider layer.",
    )
  }
}

function checkImports(file, content) {
  const pkg = packageOf(file)
  const isShared = file.startsWith('packages/shared/')
  const isWeb = file.startsWith('apps/web/')

  checkAntdStaticFeedback(file, content)

  // R1–R3: evaluate every import extracted from the file (multi-line import aware).
  for (const { spec, line: lineNo } of importSources(content)) {
    // R3: the @/ alias is limited to apps/web/src
    if (spec === '@' || spec.startsWith('@/')) {
      if (!isWeb) {
        report(
          'R3',
          file,
          lineNo,
          `a non-apps/web file uses the @/ alias (import '${spec}')`,
          'The @/ alias does not exist outside apps/web; use a relative path or @a2wave/shared.',
        )
      }
      continue
    }

    // R2: shared must not import any app
    if (isShared) {
      const pkgDir =
        APP_PKG_TO_DIR[spec] ?? Object.keys(APP_PKG_TO_DIR).find((p) => spec.startsWith(`${p}/`))
      const hitPkg = APP_PKG_TO_DIR[spec] || (pkgDir && APP_PKG_TO_DIR[pkgDir])
      const relApp =
        resolveRelativeApp(file, spec) || (/(^|\/)apps\/(web|api|cli)\//.test(spec) ? 'x' : null)
      if (hitPkg || relApp) {
        report(
          'R2',
          file,
          lineNo,
          `packages/shared depends back on an app (import '${spec}')`,
          'shared is a leaf layer and may only be depended upon. Move shared logic down into shared, or implement it inside the app.',
        )
      }
      continue
    }

    // R1: apps must not import each other
    if (pkg && APP_NAMES.includes(pkg)) {
      // Detect by package name
      let targetApp = APP_PKG_TO_DIR[spec]
      if (!targetApp) {
        const base = Object.keys(APP_PKG_TO_DIR).find((p) => spec.startsWith(`${p}/`))
        if (base) targetApp = APP_PKG_TO_DIR[base]
      }
      // Detect by relative path
      if (!targetApp) targetApp = resolveRelativeApp(file, spec)
      // Detect by a literal apps/x/ path
      if (!targetApp) {
        const m = spec.match(/(?:^|\/)apps\/(web|api|cli)\//)
        if (m) targetApp = m[1]
      }
      if (targetApp && targetApp !== pkg) {
        report(
          'R1',
          file,
          lineNo,
          `apps/${pkg} imports across apps into apps/${targetApp} ('${spec}')`,
          'Apps must not depend on each other; put shared code in packages/shared.',
        )
      }
    }
  }

  // R4: forbid @ts-ignore / @ts-nocheck (line by line)
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (/@ts-ignore|@ts-nocheck/.test(lines[i])) {
      report(
        'R4',
        file,
        i + 1,
        'uses @ts-ignore / @ts-nocheck to mask a type error',
        'Fix the underlying type problem; to suppress a single line when truly necessary, use @ts-expect-error with a comment.',
      )
    }
  }
}

/** Flatten nested JSON into a set of dot-path keys. */
function flattenKeys(obj, prefix, set) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      flattenKeys(v, key, set)
    } else {
      set.add(key)
    }
  }
}

const ZH_LOCALE = 'apps/web/src/locales/zh.json'
const EN_LOCALE = 'apps/web/src/locales/en.json'

/**
 * Read a locale file: --all uses the working tree, pre-commit uses "what is about to be committed"
 * — the staged blob (git show :file), falling back to the working tree / HEAD when the file is not
 * staged. That way a key-set drift is caught even when only one side's locale was staged.
 */
function readLocaleStaged(file) {
  if (scanAll) {
    const abs = resolve(ROOT, file)
    return existsSync(abs) ? readFileSync(abs, 'utf8') : null
  }
  try {
    return execFileSync('git', ['show', `:${file}`], { cwd: ROOT, encoding: 'utf8' })
  } catch {
    // The file is not staged: use the HEAD version to represent the post-commit content.
    try {
      return execFileSync('git', ['show', `HEAD:${file}`], { cwd: ROOT, encoding: 'utf8' })
    } catch {
      return null
    }
  }
}

function checkLocales() {
  const zhRaw = readLocaleStaged(ZH_LOCALE)
  const enRaw = readLocaleStaged(EN_LOCALE)
  if (zhRaw == null || enRaw == null) return

  let zh
  let en
  try {
    zh = JSON.parse(zhRaw)
    en = JSON.parse(enRaw)
  } catch (e) {
    report('R5', ZH_LOCALE, 0, `failed to parse locale JSON: ${e.message}`, 'Fix the JSON syntax.')
    return
  }
  const zhKeys = new Set()
  const enKeys = new Set()
  flattenKeys(zh, '', zhKeys)
  flattenKeys(en, '', enKeys)
  const onlyZh = [...zhKeys].filter((k) => !enKeys.has(k))
  const onlyEn = [...enKeys].filter((k) => !zhKeys.has(k))
  if (onlyZh.length) {
    report(
      'R5',
      EN_LOCALE,
      0,
      `en.json is missing ${onlyZh.length} key(s) present in zh.json: ${onlyZh.slice(0, 5).join(', ')}${onlyZh.length > 5 ? ' …' : ''}`,
      'zh/en key sets must match; add the missing keys to en.json.',
    )
  }
  if (onlyEn.length) {
    report(
      'R5',
      ZH_LOCALE,
      0,
      `zh.json is missing ${onlyEn.length} key(s) present in en.json: ${onlyEn.slice(0, 5).join(', ')}${onlyEn.length > 5 ? ' …' : ''}`,
      'zh/en key sets must match; add the missing keys to zh.json.',
    )
  }
}

/**
 * R7 audit-action i18n coverage: every audit `action` / `resource` written by apps/api must have
 * copy under auditLogs.actions|resources in both zh and en.
 *
 * When copy is missing the audit page falls back to the raw key (`auth.oauth.login`) — the page does
 * not error, it just becomes unreadable, which is exactly the state this rule exists to block.
 * `action` is a free-form string, so nothing else prevents a new logAudit() call from shipping with
 * an untranslated action.
 */
function checkAuditI18n() {
  const zhRaw = readLocaleStaged(ZH_LOCALE)
  const enRaw = readLocaleStaged(EN_LOCALE)
  if (zhRaw == null || enRaw == null) return

  let locales
  try {
    locales = { zh: JSON.parse(zhRaw), en: JSON.parse(enRaw) }
  } catch {
    return // R5 already reported the JSON syntax error
  }

  const apiSrc = resolve(ROOT, 'apps/api/src')
  if (!existsSync(apiSrc)) return

  let files
  try {
    files = execFileSync(
      'grep',
      ['-rl', '--exclude-dir=__tests__', '-e', 'logAudit', '-e', 'logBackgroundAudit', apiSrc],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .filter(Boolean)
  } catch {
    return // grep exits non-zero when there are no matches
  }

  // The AUDIT_ACTIONS constant table: auth/settings/user call sites mostly reference names rather
  // than inline strings.
  const constants = new Map()
  const constantsPath = resolve(apiSrc, 'lib/audit-actions.ts')
  if (existsSync(constantsPath)) {
    const src = readFileSync(constantsPath, 'utf8')
    for (const [, name, value] of src.matchAll(/([A-Z_]+):\s*'([a-z0-9_.-]+)'/g)) {
      constants.set(name, value)
    }
  }

  const actions = new Set()
  const resources = new Set()
  for (const file of files) {
    const src = readFileSync(file, 'utf8')
    for (const [, args] of src.matchAll(
      /log(?:Background)?Audit\s*\(([\s\S]{0,900}?)\)\s*[;\n]/g,
    )) {
      const literal = /action:\s*['"`]([^'"`]+)['"`]/.exec(args)
      if (literal) actions.add(literal[1])
      else {
        const viaConstant = /action:\s*AUDIT_ACTIONS\.([A-Z_]+)/.exec(args)
        const resolved = viaConstant && constants.get(viaConstant[1])
        if (resolved) actions.add(resolved)
      }
      const resource = /resource:\s*'([a-z_-]+)'/.exec(args)
      if (resource) resources.add(resource[1])
    }
  }

  // Matching no actions at all means the regex has drifted from how the code is written; passing
  // silently here would mean the gate has quietly stopped working.
  if (actions.size === 0) {
    report(
      'R7',
      'scripts/gates/check-arch-rules.mjs',
      0,
      'could not extract any audit action from apps/api — R6 has stopped working',
      'The shape of audit calls may have changed; update the matching rules in checkAuditI18n().',
    )
    return
  }

  for (const [locale, json] of Object.entries(locales)) {
    const file = locale === 'zh' ? ZH_LOCALE : EN_LOCALE
    const labels = json.auditLogs ?? {}
    for (const [kind, discovered] of [
      ['actions', actions],
      ['resources', resources],
    ]) {
      const table = labels[kind] ?? {}
      const missing = [...discovered].filter((key) => !table[key]).sort()
      if (missing.length) {
        report(
          'R7',
          file,
          0,
          `auditLogs.${kind} is missing ${missing.length} string(s): ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}`,
          `apps/api writes these audit ${kind} values; add them under auditLogs.${kind} in ${file}, otherwise the audit page shows raw keys.`,
        )
      }
    }
  }
}

function main() {
  const files = listFiles()
  const allowlist = loadAllowlist()

  for (const file of files) {
    if (!isSource(file)) continue
    const content = readContent(file)
    if (content) checkImports(file, content)
  }
  checkLocales()
  checkAuditI18n()

  // Allowlist filtering: waive by rule + path prefix.
  const filtered = violations.filter((v) => {
    return !allowlist.some(
      (a) => a.rule === v.rule && (v.file === a.path || v.file.startsWith(a.path)),
    )
  })

  if (filtered.length === 0) {
    if (scanAll) console.log('[arch-rules] ✓ all sources pass R1–R8')
    process.exit(0)
  }

  console.error('\n[arch-rules] ✗ architecture gates failed:\n')
  for (const v of filtered) {
    const loc = v.line ? `${v.file}:${v.line}` : v.file
    console.error(`  [${v.rule}] ${loc}`)
    console.error(`        ${v.msg}`)
    console.error(`        → ${v.fix}\n`)
  }
  console.error(
    `${filtered.length} violation(s). For a genuinely justified exception, add { "rule", "path", "reason" } to scripts/gates/arch-rules-allowlist.json.\n`,
  )
  process.exit(1)
}

main()
