#!/usr/bin/env node
/**
 * Mutation check for the git-trigger fingerprint rules.
 *
 * Six review rounds produced 41 findings on this module, and the tests that were
 * meant to prevent the later ones did not: a property suite was written, then
 * "verified" by planting two defects chosen *after* the assertions existed. Both
 * died, the suite was declared effective, and the next variant of the same bug
 * walked straight through it. Testing an assertion with a defect selected to fit
 * it proves nothing.
 *
 * This script inverts the selection. Every mutant below is a defect that
 * actually shipped, taken from the review history rather than from the shape of
 * any assertion — so the tests cannot have been fitted to them. A mutant that
 * SURVIVES is a coverage hole, stated as a fact rather than an opinion.
 *
 *   node scripts/gates/check-git-trigger-mutants.mjs           # all suites
 *   node scripts/gates/check-git-trigger-mutants.mjs --property # property only
 *
 * Adding a mutant is the right response to any future fingerprint defect: it
 * makes "we fixed it" and "we can detect it again" two separate, checkable
 * claims.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DIFF = join(repoRoot, 'apps/api/src/lib/git-trigger-diff.ts')

/**
 * Each mutant reintroduces one historical defect by a literal source edit.
 * `find` must match exactly once, so a refactor that moves the code makes this
 * script fail loudly rather than silently stop testing anything.
 */
const MUTANTS = [
  {
    id: 'round1-updated-dedup-before-subscription',
    origin: 'Review round 1 (P1-4)',
    breaks:
      'A push and a comment in one tick, with only `commented` subscribed, fires nothing and advances past the comment.',
    find: `    if (prior.sha !== request.sha && wanted.has('updated')) {
      candidates.push({ event: 'updated', request })
      continue
    }`,
    replace: `    if (prior.sha !== request.sha) {
      if (wanted.has('updated')) candidates.push({ event: 'updated', request })
      continue
    }`,
  },
  {
    id: 'round6-filtered-return-before-subscription',
    origin: 'Review round 6',
    breaks:
      'Same shape on the filtered-return branch: commits made during a draft are lost when it is marked ready.',
    find: `    if (prior.filtered && wanted.has('opened')) {
      candidates.push({ event: 'opened', request })
      continue
    }`,
    replace: `    if (prior.filtered) {
      if (wanted.has('opened')) candidates.push({ event: 'opened', request })
      continue
    }`,
  },
  {
    id: 'round6-filtered-flag-never-written',
    origin: 'Review round 6 (found by the reviewer, not by this suite)',
    breaks: 'The filtered flag is never set, so "draft to ready for review" fires nothing at all.',
    find: '  if (stillOpen) return prior ? { keep: { ...prior, filtered: true } } : {}',
    replace: '  if (stillOpen) return prior ? { keep: prior } : {}',
  },
  {
    id: 'round2-retention-keyed-on-subscription',
    origin: 'Review round 2',
    breaks:
      'A merged request is retained even when the listing proved it gone, so state grows without bound.',
    find: '  if (!listingComplete) return prior ? { unprovable: prior } : {}',
    replace: '  if (true) return prior ? { unprovable: prior } : {}',
  },
  {
    id: 'round1-closed-ignores-filters',
    origin: 'Review round 1',
    breaks:
      'A request hidden by a filter is reported closed, waking the Agent for a merge that never happened.',
    find: '      if (seen.has(key) || stillOpen.has(key)) continue',
    replace: '      if (seen.has(key)) continue',
  },
]

const propertyOnly = process.argv.includes('--property')
const suites = propertyOnly
  ? [{ name: 'property', filter: 'git-trigger-invariants' }]
  : [
      { name: 'property', filter: 'git-trigger-invariants' },
      { name: 'example', filter: 'git-trigger-diff' },
    ]

function runSuite(filter) {
  try {
    execFileSync('pnpm', ['--filter', '@a2wave/api', 'test', '--', filter], {
      cwd: repoRoot,
      stdio: 'pipe',
    })
    return 'passed'
  } catch {
    return 'failed'
  }
}

const original = readFileSync(DIFF, 'utf-8')
const survivors = []

// Every anchor is validated BEFORE the first mutation. Exiting from inside the
// loop would leave mutated source on disk — which happened while writing this,
// and is exactly the kind of half-applied state a checker must never produce.
const misanchored = MUTANTS.filter((m) => original.split(m.find).length - 1 !== 1)
if (misanchored.length > 0) {
  for (const mutant of misanchored) {
    console.error(
      `[mutants] ✗ ${mutant.id}: anchor did not match exactly once.\n          The code moved; update the mutant so it keeps testing something.`,
    )
  }
  process.exit(1)
}

try {
  for (const mutant of MUTANTS) {
    writeFileSync(DIFF, original.replace(mutant.find, mutant.replace))
    const results = suites.map((suite) => ({ ...suite, result: runSuite(suite.filter) }))
    const killedBy = results.filter((r) => r.result === 'failed').map((r) => r.name)

    if (killedBy.length === 0) {
      survivors.push(mutant)
      console.error(`[mutants] ✗ SURVIVED  ${mutant.id}  (${mutant.origin})`)
      console.error(`          ${mutant.breaks}`)
    } else {
      console.log(`[mutants] ✓ killed by ${killedBy.join(' + ')}  ${mutant.id}`)
    }
  }
} finally {
  writeFileSync(DIFF, original)
}

if (survivors.length > 0) {
  console.error(
    `\n[mutants] ${survivors.length} historical defect(s) would not be detected today.\nEach one is a coverage hole: the bug is fixed, but nothing stops it returning.`,
  )
  process.exit(1)
}

console.log(`\n[mutants] ✓ all ${MUTANTS.length} historical defects are detected`)
