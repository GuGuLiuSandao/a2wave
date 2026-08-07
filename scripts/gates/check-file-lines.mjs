#!/usr/bin/env node
/**
 * Per-file line-count gate — blocks oversized source files and stops "god files" from growing.
 * By default only staged sources are scanned (for pre-commit, reading the index); pass --all to scan
 * every tracked source file (for a baseline sweep).
 *
 * Rule: a single source file (ts/tsx/js/jsx/mjs/cjs) must not exceed MAX_LINES lines.
 * The current cap of 3000 lines is already an unhealthy level; it is only a stop-the-bleeding line
 * and should be lowered over time.
 *
 * Exceeding it prints "file lines/limit + a split hint" and exits 1.
 * allowlist: scripts/gates/file-lines-allowlist.json
 *   [{ path, maxLines, reason }]
 *   Pre-existing oversized files are frozen at a baseline here (maxLines near the current count):
 *   they may only shrink, never grow;
 *   once split, the corresponding entry should be removed from the allowlist.
 */
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ALLOWLIST_PATH = resolve(ROOT, 'scripts/gates/file-lines-allowlist.json')

const MAX_LINES = 3000
const scanAll = process.argv.includes('--all')

/** Only source files are checked; lockfiles and build output are not in tracked source directories,
 * so no extra exclusion is needed. */
function isSource(file) {
  return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)
}

function listFiles() {
  const cmd = scanAll
    ? 'git -c core.quotepath=false ls-files'
    : 'git -c core.quotepath=false diff --cached --name-only --diff-filter=ACMR'
  const out = execSync(cmd, { cwd: ROOT, encoding: 'utf8' })
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter(isSource)
}

/** Read staged or working-tree content (--all uses the working tree, pre-commit the index). */
function readContent(file) {
  try {
    if (scanAll) return readFileSync(resolve(ROOT, file), 'utf8')
    return execFileSync('git', ['show', `:${file}`], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch {
    return null
  }
}

function countLines(text) {
  if (text.length === 0) return 0
  const lines = text.split('\n')
  return text.endsWith('\n') ? lines.length - 1 : lines.length
}

function loadAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return []
  try {
    const j = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'))
    return Array.isArray(j) ? j : []
  } catch {
    return []
  }
}

const allowlist = loadAllowlist()

/** The effective line limit for a file (a frozen allowlist baseline takes precedence). */
function limitFor(file) {
  const entry = allowlist.find((e) => e.path === file)
  if (entry && Number.isFinite(entry.maxLines)) return entry.maxLines
  return MAX_LINES
}

function main() {
  const hits = []
  for (const file of listFiles()) {
    const text = readContent(file)
    if (text === null) continue
    const lines = countLines(text)
    const limit = limitFor(file)
    if (lines > limit) hits.push({ file, lines, limit })
  }

  if (hits.length === 0) {
    if (scanAll) console.log(`[file-lines] ✓ no source file exceeds ${MAX_LINES} lines`)
    process.exit(0)
  }

  console.error('\n[file-lines] ✗ oversized source file(s) detected:\n')
  for (const h of hits.sort((a, b) => b.lines - a.lines)) {
    console.error(`  ${h.file}`)
    console.error(`     lines: ${h.lines} (limit ${h.limit})\n`)
  }
  console.error(
    'Split the file along single-responsibility lines (extract submodules/helpers, or split by domain)\n' +
      'rather than appending to it.\n' +
      'If this is pre-existing debt that cannot be split now: freeze a baseline in\n' +
      'scripts/gates/file-lines-allowlist.json ({ "path": "...", "maxLines": <current count>,\n' +
      '"reason": "..." }); from then on it may only shrink, never grow.\n',
  )
  process.exit(1)
}

main()
