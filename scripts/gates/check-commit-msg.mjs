#!/usr/bin/env node
/**
 * commit-msg gate — enforces Conventional Commits (zero dependencies; no @commitlint).
 * Usage: node scripts/gates/check-commit-msg.mjs <commit-msg-file> (husky passes $1).
 *
 * Rule: the first line must match type(scope)!?: subject
 *   type comes from the standard set (AGENTS.md L470 only lists feat/fix/refactor as examples; the
 *   conventional whitelist is used here).
 *   git-generated messages such as merge/revert/fixup/squash are waived.
 */
import { existsSync, readFileSync } from 'node:fs'

const TYPES = [
  'feat',
  'fix',
  'refactor',
  'docs',
  'test',
  'chore',
  'style',
  'perf',
  'build',
  'ci',
  'revert',
]

// scope is optional; an empty scope `type(): x` is allowed ([^)]* matches 0 characters) to avoid
// pointless rejections.
const PATTERN = new RegExp(`^(${TYPES.join('|')})(\\([^)]*\\))?!?: .+`)

function main() {
  const file = process.argv[2]
  if (!file || !existsSync(file)) {
    console.error('[commit-msg] commit message file not found')
    process.exit(1)
  }

  const raw = readFileSync(file, 'utf8')
  // Take the first non-empty, non-comment line as the subject.
  const firstLine =
    raw
      .split('\n')
      .map((l) => l.trimEnd())
      .find((l) => l.length > 0 && !l.startsWith('#')) ?? ''

  // Waive git-generated / merge-type messages.
  if (/^(Merge |Revert "|Revert |fixup! |squash! |amend! )/.test(firstLine)) {
    process.exit(0)
  }

  if (PATTERN.test(firstLine)) {
    process.exit(0)
  }

  console.error('\n[commit-msg] ✗ commit message does not follow Conventional Commits:\n')
  console.error(`  actual: ${firstLine || '(empty)'}\n`)
  console.error('  expected: <type>(<scope>)?: <subject>')
  console.error(`  allowed types: ${TYPES.join(', ')}`)
  console.error('\n  examples:')
  console.error('    feat(api): add oauth sessions')
  console.error('    fix: stop Feishu long connections from preempting each other')
  console.error('    refactor(web)!: rework routing (breaking change)\n')
  process.exit(1)
}

main()
