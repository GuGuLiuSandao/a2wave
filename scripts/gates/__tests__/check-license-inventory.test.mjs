import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  existingGeneratedOn,
  findForbidden,
  firstDifference,
  readLicenseReport,
  renderInventory,
  summarise,
} from '../check-license-inventory.mjs'

const REPORT = {
  MIT: [
    { name: 'zod', versions: ['3.25.76', '4.4.3'] },
    { name: 'hono', versions: ['4.12.34'] },
  ],
  'Apache-2.0': [{ name: 'typescript', versions: ['5.9.3'] }],
}

test('summarise flattens pnpm output into sorted packages and counts', () => {
  const { packages, summary, total } = summarise(REPORT)

  assert.equal(total, 3)
  assert.deepEqual(
    packages.map((p) => p.name),
    ['hono', 'typescript', 'zod'],
  )
  assert.equal(packages.find((p) => p.name === 'zod').versions, '3.25.76, 4.4.3')
  assert.deepEqual(summary, [
    ['MIT', 2],
    ['Apache-2.0', 1],
  ])
})

test('summarise deduplicates repeated versions of one package', () => {
  const { packages } = summarise({ ISC: [{ name: 'semver', versions: ['7.7.4', '7.7.4'] }] })
  assert.equal(packages[0].versions, '7.7.4')
})

test('summarise counts a dual-licensed package once per license', () => {
  const { total, summary } = summarise({
    MIT: [{ name: 'dual', versions: ['1.0.0'] }],
    ISC: [{ name: 'dual', versions: ['1.0.0'] }],
  })
  assert.equal(total, 2)
  assert.deepEqual(summary, [
    ['ISC', 1],
    ['MIT', 1],
  ])
})

test('findForbidden accepts a clean permissive tree', () => {
  assert.deepEqual(findForbidden(summarise(REPORT)), [])
})

test('findForbidden rejects copyleft licenses', () => {
  for (const license of ['GPL-3.0', 'AGPL-3.0-only', 'LGPL-2.1', 'SSPL-1.0']) {
    const violations = findForbidden(
      summarise({ [license]: [{ name: 'bad', versions: ['1.0.0'] }] }),
    )
    assert.equal(violations.length, 1, `${license} must be rejected`)
    assert.equal(violations[0].reason, 'copyleft license')
  }
})

test('findForbidden rejects unknown and unlicensed packages', () => {
  const violations = findForbidden(
    summarise({ Unknown: [{ name: 'mystery', versions: ['1.0.0'] }] }),
  )
  assert.equal(violations.length, 1)
  assert.equal(violations[0].reason, 'unknown license')
})

test('findForbidden does not mistake permissive licenses for copyleft', () => {
  // MPL-2.0 is file-level copyleft and deliberately allowed; the substring "GPL" must not
  // false-positive on names that merely contain it.
  const clean = summarise({
    'MPL-2.0': [{ name: 'lightningcss', versions: ['1.30.2'] }],
    '(MIT OR CC0-1.0)': [{ name: 'type-fest', versions: ['4.41.0'] }],
    'BlueOak-1.0.0': [{ name: 'sax', versions: ['1.6.0'] }],
  })
  assert.deepEqual(findForbidden(clean), [])
})

test('renderInventory is deterministic for a fixed date', () => {
  const data = summarise(REPORT)
  assert.equal(renderInventory(data, '2026-08-07'), renderInventory(data, '2026-08-07'))
})

test('renderInventory records the total and every package row', () => {
  const rendered = renderInventory(summarise(REPORT), '2026-08-07')
  assert.match(rendered, /Generated: 2026-08-07 .* 3 packages/)
  assert.match(rendered, /\| zod \| 3\.25\.76, 4\.4\.3 \| MIT \|/)
  assert.match(rendered, /\| typescript \| 5\.9\.3 \| Apache-2\.0 \|/)
  assert.ok(rendered.endsWith('\n'), 'file must end with a trailing newline')
})

test('existingGeneratedOn recovers the committed stamp, or null when absent', () => {
  assert.equal(existingGeneratedOn(renderInventory(summarise(REPORT), '2026-01-02')), '2026-01-02')
  assert.equal(existingGeneratedOn('# No stamp here\n'), null)
})

test('firstDifference reports nothing for identical content', () => {
  const rendered = renderInventory(summarise(REPORT), '2026-08-07')
  assert.equal(firstDifference(rendered, rendered), null)
})

test('firstDifference pinpoints the drifting line', () => {
  const diff = firstDifference('a\nb\nc\n', 'a\nX\nc\n')
  assert.deepEqual(diff, { line: 2, committed: 'X', regenerated: 'b' })
})

test('firstDifference handles truncated files', () => {
  assert.deepEqual(firstDifference('a\nb\n', 'a\n'), {
    line: 2,
    committed: '',
    regenerated: 'b',
  })
})

test('readLicenseReport tags a cold pnpm store as an environment problem', () => {
  const error = Object.assign(new Error('command failed'), {
    stderr: 'ERR_PNPM_MISSING_PACKAGE_INDEX_FILE  Package index file not found',
  })
  assert.throws(
    () =>
      readLicenseReport(() => {
        throw error
      }),
    (thrown) => thrown.environment === true,
  )
})

test('readLicenseReport rethrows unrelated failures unchanged', () => {
  assert.throws(
    () =>
      readLicenseReport(() => {
        throw new Error('pnpm: command not found')
      }),
    (thrown) => thrown.environment === undefined && /command not found/.test(thrown.message),
  )
})

test('readLicenseReport parses a successful run', () => {
  assert.deepEqual(
    readLicenseReport(() => JSON.stringify(REPORT)),
    REPORT,
  )
})
