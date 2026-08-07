import { describe, expect, it } from 'vitest'
import { isAbsolutePath } from '../scm-source-form'

/**
 * The form validates `localPath` client-side so the error is translated and
 * lands on the field. The API validates the *submitted* value with
 * `node:path.isAbsolute`, so the two must agree — a value the form accepts and
 * then sends must not come back as a 400.
 */
describe('isAbsolutePath', () => {
  it('accepts posix absolute paths', () => {
    expect(isAbsolutePath('/srv/repo')).toBe(true)
  })

  it('accepts windows paths, which node:path also treats as absolute', () => {
    // The API may run on Windows; rejecting these client-side would block a
    // path the server would have taken.
    expect(isAbsolutePath('C:\\work')).toBe(true)
    expect(isAbsolutePath('C:/work')).toBe(true)
    expect(isAbsolutePath('\\\\server\\share')).toBe(true)
  })

  it('rejects relative paths and blanks', () => {
    expect(isAbsolutePath('./neptune')).toBe(false)
    expect(isAbsolutePath('neptune')).toBe(false)
    expect(isAbsolutePath('')).toBe(false)
    expect(isAbsolutePath('   ')).toBe(false)
  })

  it('accepts a padded path — which is why the value must be trimmed on submit', () => {
    // isAbsolutePath trims before testing, so "  /srv/repo" passes here. The
    // submit path therefore has to trim too: sending the raw value would fail
    // the API's untrimmed node:path.isAbsolute with a 400.
    expect(isAbsolutePath('  /srv/repo  ')).toBe(true)
    expect('  /srv/repo  '.trim()).toBe('/srv/repo')
  })
})
