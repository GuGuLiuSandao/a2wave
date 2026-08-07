/**
 * Regression tests for .gitleaks.toml.
 *
 * The dangerous failure mode is silent: a gitleaks allowlist defaults to `condition = "OR"`, so
 * listing a path suppresses every finding in that file forever. The repo would still scan clean
 * — while no longer detecting a real credential committed to those same test files. These tests
 * assert the AND condition survives, without requiring the gitleaks binary to be installed.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const CONFIG = readFileSync(resolve(ROOT, '.gitleaks.toml'), 'utf8')

/** Split the config into `[[rules.allowlists]]` blocks without pulling in a TOML parser. */
function allowlistBlocks() {
  return CONFIG.split(/^\[\[rules\.allowlists\]\]$/m)
    .slice(1)
    .map((block) => block.split(/^\[\[/m)[0])
}

test('every allowlist requires path AND placeholder to match', () => {
  const blocks = allowlistBlocks()
  assert.ok(blocks.length > 0, 'expected at least one allowlist block')

  for (const block of blocks) {
    assert.match(
      block,
      /condition\s*=\s*"AND"/,
      `an allowlist without condition = "AND" suppresses the whole file:\n${block}`,
    )
    assert.match(block, /paths\s*=/, `allowlist must be path-scoped:\n${block}`)
    assert.match(block, /regexes\s*=/, `allowlist must match a specific placeholder:\n${block}`)
  }
})

test('no allowlist is scoped to a bare directory or wildcard-everything path', () => {
  for (const block of allowlistBlocks()) {
    const paths = /paths\s*=\s*\[([\s\S]*?)\]/.exec(block)?.[1] ?? ''
    assert.doesNotMatch(
      paths,
      /'''\s*(\.\*|\.\+)?\s*'''/,
      `a catch-all path defeats the point of scoping:\n${paths}`,
    )
    // Each path must name a concrete file, not just a folder prefix.
    assert.match(paths, /\\\.(ts|md|json|mjs|yaml|yml)/, `path must target a file:\n${paths}`)
  }
})

test('config extends the gitleaks defaults rather than replacing them', () => {
  assert.match(CONFIG, /\[extend\][\s\S]*useDefault\s*=\s*true/)
})

test('no blanket ignore mechanisms are used', () => {
  // `[allowlist]` at top level (as opposed to `[rules.allowlist]`) applies globally, and
  // `stopwords`/global `paths` would silence entire trees.
  assert.doesNotMatch(CONFIG, /^\[allowlist\]$/m, 'global allowlist would apply to every rule')
  assert.doesNotMatch(CONFIG, /^\[\[allowlists\]\]$/m, 'global allowlists apply to every rule')
})

test('every overridden rule restates a regex and keywords', () => {
  // Redefining a default rule id replaces it wholesale; forgetting the pattern would disable
  // that detection entirely while looking like a narrow allowlist.
  const ruleBlocks = CONFIG.split(/^\[\[rules\]\]$/m)
    .slice(1)
    .map((block) => block.split(/^\[\[rules\.allowlists\]\]$/m)[0])

  assert.ok(ruleBlocks.length > 0)
  for (const block of ruleBlocks) {
    assert.match(block, /^id\s*=/m, `rule needs an id:\n${block}`)
    assert.match(block, /^regex\s*=/m, `overridden rule must restate its regex:\n${block}`)
    assert.match(block, /^keywords\s*=/m, `overridden rule must restate its keywords:\n${block}`)
  }
})

test('the known placeholders are the only excused values', () => {
  const expected = [
    'test-secret-with-sufficient-entropy-for-tests',
    'eyJabcdefghijk1234',
    'Bearer\\s+YOUR_API_KEY',
  ]
  const found = [...CONFIG.matchAll(/regexes\s*=\s*\['''(.+?)'''\]/g)].map((m) => m[1])
  assert.deepEqual(found.sort(), expected.sort())
})
