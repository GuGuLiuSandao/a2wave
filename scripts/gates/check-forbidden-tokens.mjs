#!/usr/bin/env node
/**
 * Secret/credential leak scan — blocks accidentally committed secrets at pre-commit.
 * By default scans added lines in the staged diff plus staged filenames; pass --all to scan every
 * tracked file.
 *
 * A hit prints "file:line matched rule" and exits 1.
 * allowlist: scripts/gates/forbidden-tokens-allowlist.json
 *   { literals: [...exactly waived placeholder/public-key values], paths: [...path prefixes] }
 *
 * Three principles for controlling false positives:
 *   (a) Tests/examples/docs (__tests__, *.test.*, *.example, docs/**\/*.md) are treated leniently:
 *       only high-certainty rules remain, such as PEM private keys and filename blocks, which are
 *       almost certainly accidental commits.
 *   (b) The masking sentinel '********' (apps/api/.../agent-export.ts) is always waived.
 *   (c) The allowlist explicitly waives known-legitimate values such as the RSA public-key JWK in
 *       .env.example.
 */
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ALLOWLIST_PATH = resolve(ROOT, 'scripts/gates/forbidden-tokens-allowlist.json')
const scanAll = process.argv.includes('--all')

const MASK = '********' // the product's masking sentinel; always waived

/** High-certainty rules: blocked even in tests/examples (almost certainly an accidental commit). */
const STRICT_RULES = [
  {
    id: 'pem',
    desc: 'PEM private key block',
    re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
]

/** Standard rules: skipped in tests/examples/docs to avoid false positives on fixture tokens. */
const RULES = [
  {
    id: 'anthropic-oat',
    desc: 'Anthropic OAuth token',
    re: /(?<![\w-])sk-ant-oat01-[A-Za-z0-9_-]{20,}/,
  },
  {
    id: 'anthropic-key',
    desc: 'Anthropic API key',
    re: /(?<![\w-])sk-ant-api03-[A-Za-z0-9_-]{20,}/,
  },
  // The body is pure alnum (a real key's random section has no hyphens) with a left boundary, so
  // kebab-case strings like --sk-button-... / sk-a-b-c do not false-positive.
  { id: 'openai-key', desc: 'OpenAI/Codex API key', re: /(?<![\w-])sk-(?:proj-)?[A-Za-z0-9]{20,}/ },
  {
    id: 'kubeconfig-cert',
    desc: 'inline certificate/private key in kubeconfig',
    re: /(?:client-key-data|client-certificate-data|certificate-authority-data):\s*[A-Za-z0-9+/]{40,}={0,2}/,
  },
  {
    id: 'jwt',
    desc: 'JWT (suspected access token)',
    re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
  {
    id: 'git-pat-url',
    desc: 'user:token credentials embedded in a URL',
    re: /https:\/\/[^:@/\s]+:[^@/\s]{8,}@/,
  },
  { id: 'aws-akid', desc: 'AWS Access Key ID', re: /AKIA[0-9A-Z]{16}/ },
  { id: 'github-pat', desc: 'GitHub PAT', re: /ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}/ },
  {
    id: 'feishu-app-secret',
    desc: 'Feishu App Secret assignment',
    re: /app_?secret["'\s:=]+[A-Za-z0-9]{20,}/i,
  },
]

const SENSITIVE_ENV_NAMES =
  'AUTH_SECRET|ADMIN_PASSWORD|CURSOR_API_KEY|OPENAI_API_KEY|CODEX_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|SCM_P4_PASSWD|SCM_GIT_PAT'
// Only "sensitive variable = quoted literal" counts. Bare identifier assignments (normal code such
// as env.X = resolvedKey that injects a variable's value into env), comparisons (==/===), and shell
// expansions (${..}) do not.
const SENSITIVE_ENV_RE = new RegExp(
  `\\b(?:${SENSITIVE_ENV_NAMES})\\s*=\\s*(?!=)(?:"([^"$\\\\]{8,})"|'([^'$\\\\]{8,})')`,
)

/** Obvious placeholder/example value prefixes (used to filter out false positives). */
const PLACEHOLDER_PREFIX_RE =
  /^(change|your[-_]?|xxx+|placeholder|todo|example|dummy|fake|test|user|admin|<|\{)/i
const PLACEHOLDER_ANY_RE = /change[-_]?me|dev-secret|example\.(com|org|net)|localhost|127\.0\.0\.1/i

function looksPlaceholder(value) {
  return PLACEHOLDER_PREFIX_RE.test(value) || PLACEHOLDER_ANY_RE.test(value)
}

/** Whether a line assigns a real literal to a sensitive env var (rather than referencing a variable,
 * comparing, or expanding). */
function isSensitiveEnvLeak(text) {
  const m = SENSITIVE_ENV_RE.exec(text)
  if (!m) return false
  const value = (m[1] ?? m[2] ?? '').trim()
  if (looksPlaceholder(value)) return false
  return value.length >= 8
}

/** `*.example` filenames (anchored to the extension so directories like my.example.config/ are not
 * misjudged). */
function isExampleFile(file) {
  return /\.example$/.test(file) || /\.example\.[^/]+$/.test(file)
}

/** Filename blocks (these should never enter the repository). */
const FORBIDDEN_NAMES = [
  { re: /(^|\/)[^/]*\.kubeconfig$/, desc: 'kubeconfig file' },
  { re: /(^|\/)kubeconfig$/, desc: 'kubeconfig file' },
  { re: /(^|\/)\.credentials\.json$/, desc: 'credential cache file' },
  { re: /(^|\/)auth\.json$/, desc: 'auth.json credential file' },
  { re: /-oauth\.json$/, desc: 'OAuth token cache' },
  { re: /(^|\/)\.a2wave\/config\.json$/, desc: 'a2wave CLI token cache' },
  { re: /\.(pem|key|p12|pfx)$/, desc: 'private key/certificate file' },
  { re: /(^|\/)id_rsa(\.|$)/, desc: 'SSH private key' },
]

function isExampleOrTest(file) {
  return (
    /(^|\/)__tests__\//.test(file) ||
    /\.test\.[cm]?[jt]sx?$/.test(file) ||
    /\.example$/.test(file) ||
    /\.example\.[^/]+$/.test(file) ||
    (/^docs\//.test(file) && /\.md$/.test(file))
  )
}

function loadAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return { literals: [], paths: [] }
  try {
    const j = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'))
    return { literals: j.literals ?? [], paths: j.paths ?? [] }
  } catch {
    return { literals: [], paths: [] }
  }
}

const allowlist = loadAllowlist()

function isAllowed(file, line) {
  if (allowlist.paths.some((p) => file === p || file.startsWith(p))) return true
  if (allowlist.literals.some((lit) => line.includes(lit))) return true
  return false
}

/** Returns [{file, addedLines: [{n, text}]}]; addedLines are the added lines (or the whole file with --all). */
function collectFiles() {
  if (scanAll) {
    const files = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    return files.map((file) => {
      const abs = resolve(ROOT, file)
      let text = ''
      try {
        text = readFileSync(abs, 'utf8')
      } catch {
        return { file, addedLines: [] }
      }
      // Skip binary files (those containing NUL bytes)
      if (text.indexOf(String.fromCharCode(0)) !== -1) return { file, addedLines: [] }
      return { file, addedLines: text.split('\n').map((t, i) => ({ n: i + 1, text: t })) }
    })
  }

  // staged: parse git diff --cached -U0, taking each hunk's added lines and their new line numbers.
  // -c core.quotepath=false stops non-ASCII paths from being C-quoted (otherwise parsing +++ b/ fails
  // and the file is skipped).
  // --diff-filter=ACMR includes R (renames); without it a `git mv` to id_rsa/*.pem would bypass the scan.
  const diff = execSync(
    'git -c core.quotepath=false diff --cached -U0 --diff-filter=ACMR --no-color',
    {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  )
  if (!diff.trim()) return []
  const result = new Map()
  let curFile = null
  let newLineNo = 0
  for (const raw of diff.split('\n')) {
    // A pure rename (no content change) has only a `rename to` header and no +++/hunk: register the
    // filename so the filename blocks still apply.
    if (raw.startsWith('rename to ')) {
      const renamed = raw.slice('rename to '.length)
      if (!result.has(renamed)) result.set(renamed, [])
      continue
    }
    if (raw.startsWith('+++ b/')) {
      curFile = raw.slice(6)
      if (!result.has(curFile)) result.set(curFile, [])
      continue
    }
    if (raw.startsWith('@@')) {
      // @@ -a,b +c,d @@
      const m = raw.match(/\+(\d+)(?:,\d+)?/)
      newLineNo = m ? Number(m[1]) : 0
      continue
    }
    if (curFile && raw.startsWith('+') && !raw.startsWith('+++')) {
      result.get(curFile).push({ n: newLineNo, text: raw.slice(1) })
      newLineNo++
    } else if (curFile && !raw.startsWith('-') && !raw.startsWith('\\')) {
      // Context lines (rare under -U0); keep the line number in sync
      newLineNo++
    }
  }
  return [...result.entries()].map(([file, addedLines]) => ({ file, addedLines }))
}

const hits = []
function main() {
  const files = collectFiles()

  // Waive only the gate's own two allowlist configs (which necessarily contain example secret
  // patterns); every other gates script is scanned as usual, so a real secret pasted under
  // scripts/gates/ is still caught.
  const GATE_ALLOWLIST_FILES = new Set([
    'scripts/gates/forbidden-tokens-allowlist.json',
    'scripts/gates/arch-rules-allowlist.json',
  ])

  for (const { file, addedLines } of files) {
    if (GATE_ALLOWLIST_FILES.has(file)) continue

    // Filename blocks (no need to inspect content)
    for (const fn of FORBIDDEN_NAMES) {
      if (fn.re.test(file) && !isExampleFile(file)) {
        if (!isAllowed(file, file)) {
          hits.push({ file, line: 0, rule: `filename: ${fn.desc}`, snippet: file })
        }
        break
      }
    }

    const lenient = isExampleOrTest(file)
    for (const { n, text } of addedLines) {
      if (text.includes(MASK)) continue
      if (isAllowed(file, text)) continue

      for (const r of STRICT_RULES) {
        if (!r.re.test(text)) continue
        // In test/example files, a PEM fixture marked FAKE/EXAMPLE/DUMMY is treated as fake and waived
        // (so a multi-line fake private key does not block the gate forever).
        if (r.id === 'pem' && lenient && /\b(FAKE|EXAMPLE|DUMMY|TEST|PLACEHOLDER)\b/i.test(text)) {
          continue
        }
        hits.push({ file, line: n, rule: r.desc, snippet: trim(text) })
      }
      if (lenient) continue

      for (const r of RULES) {
        if (!r.re.test(text)) continue
        // Credentials embedded in a URL: skip obvious placeholders/examples (user:password@, localhost, …).
        if (r.id === 'git-pat-url' && looksPlaceholder(text)) continue
        hits.push({ file, line: n, rule: r.desc, snippet: trim(text) })
      }
      // Sensitive env vars are blocked only in non-example files, and only when the right-hand side is
      // a real literal
      if (!isExampleFile(file) && isSensitiveEnvLeak(text)) {
        hits.push({
          file,
          line: n,
          rule: 'a sensitive environment variable is assigned a suspected real literal',
          snippet: trim(text),
        })
      }
    }
  }

  if (hits.length === 0) {
    if (scanAll) console.log('[forbidden-tokens] ✓ no suspected secret leaks found')
    process.exit(0)
  }

  console.error('\n[forbidden-tokens] ✗ suspected secrets/credentials detected:\n')
  for (const h of hits) {
    const loc = h.line ? `${h.file}:${h.line}` : h.file
    console.error(`  ${loc}`)
    console.error(`     rule: ${h.rule}`)
    console.error(`     content: ${h.snippet}\n`)
  }
  console.error(
    'If this really is an accidental commit: remove the value (switch to an environment variable or\n' +
      'encrypted storage if needed).\n' +
      'If it is a placeholder / test fixture / public key: add the value to `literals` in\n' +
      'scripts/gates/forbidden-tokens-allowlist.json, or add its path to `paths`.\n',
  )
  process.exit(1)
}

function trim(text) {
  const t = text.trim()
  return t.length > 100 ? `${t.slice(0, 100)}…` : t
}

main()
