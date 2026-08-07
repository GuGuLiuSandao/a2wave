import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getKbDocStoragePathMock = vi.fn()
vi.mock('../../lib/kb-storage.js', () => ({
  getKbDocStoragePath: (id: string) => getKbDocStoragePathMock(id),
}))

import { syncKbDocsToWorkspaceAsync } from '../kb-sync.js'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'kb-sync-test-'))
  getKbDocStoragePathMock.mockReset()
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('syncKbDocsToWorkspaceAsync', () => {
  function workspaceWith(name: string) {
    const dir = path.join(tmp, name)
    require('node:fs').mkdirSync(dir, { recursive: true })
    return dir
  }

  function storageWithContent(docId: string, body = 'content body') {
    const dir = path.join(tmp, 'storage', docId)
    require('node:fs').mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'content.md'), body)
    return dir
  }

  it('creates .kb/ with managed marker and copies content.md for each doc', async () => {
    const workDir = workspaceWith('ws-a')
    const storageA = storageWithContent('kbd_AAA', 'doc A')
    const storageB = storageWithContent('kbd_BBB', 'doc B')

    getKbDocStoragePathMock.mockImplementation((id: string) =>
      id === 'kbd_AAA' ? storageA : storageB,
    )

    await syncKbDocsToWorkspaceAsync(workDir, [
      { id: 'kbd_AAA', name: 'My Doc!', storagePath: 'kbd_AAA' },
      { id: 'kbd_BBB', name: '中文 文档', storagePath: 'kbd_BBB' },
    ])

    const kbRoot = path.join(workDir, '.kb')
    expect(existsSync(path.join(kbRoot, '.a2wave-kb-managed'))).toBe(true)
    expect(readFileSync(path.join(kbRoot, 'my-doc-AAA.md'), 'utf-8')).toBe('doc A')
    expect(readFileSync(path.join(kbRoot, '中文-文档-BBB.md'), 'utf-8')).toBe('doc B')
  })

  it('falls back to "doc" slug when the name has no usable characters', async () => {
    const workDir = workspaceWith('ws-b')
    const storage = storageWithContent('kbd_X', 'x')
    getKbDocStoragePathMock.mockReturnValue(storage)

    await syncKbDocsToWorkspaceAsync(workDir, [{ id: 'kbd_X', name: '!!!', storagePath: 'kbd_X' }])
    expect(existsSync(path.join(workDir, '.kb', 'doc-X.md'))).toBe(true)
  })

  it('skips docs that have no storagePath', async () => {
    const workDir = workspaceWith('ws-c')
    await syncKbDocsToWorkspaceAsync(workDir, [{ id: 'kbd_1', name: 'a', storagePath: null }])
    const kbRoot = path.join(workDir, '.kb')
    expect(existsSync(path.join(kbRoot, '.a2wave-kb-managed'))).toBe(true)
    // No files other than the marker
    expect(require('node:fs').readdirSync(kbRoot)).toEqual(['.a2wave-kb-managed'])
  })

  it('skips docs whose source content.md does not exist', async () => {
    const workDir = workspaceWith('ws-d')
    const emptyStorage = path.join(tmp, 'storage', 'empty')
    require('node:fs').mkdirSync(emptyStorage, { recursive: true })
    getKbDocStoragePathMock.mockReturnValue(emptyStorage)

    await syncKbDocsToWorkspaceAsync(workDir, [{ id: 'kbd_1', name: 'a', storagePath: 'empty' }])
    expect(require('node:fs').readdirSync(path.join(workDir, '.kb'))).toEqual([
      '.a2wave-kb-managed',
    ])
  })

  it('wipes a previous managed .kb/ before populating again', async () => {
    const workDir = workspaceWith('ws-e')
    const kbRoot = path.join(workDir, '.kb')
    await mkdir(kbRoot, { recursive: true })
    writeFileSync(path.join(kbRoot, '.a2wave-kb-managed'), '')
    writeFileSync(path.join(kbRoot, 'stale.md'), 'old content')

    const storage = storageWithContent('kbd_NEW', 'new')
    getKbDocStoragePathMock.mockReturnValue(storage)

    await syncKbDocsToWorkspaceAsync(workDir, [
      { id: 'kbd_NEW', name: 'fresh', storagePath: 'kbd_NEW' },
    ])
    expect(existsSync(path.join(kbRoot, 'stale.md'))).toBe(false)
    expect(existsSync(path.join(kbRoot, 'fresh-NEW.md'))).toBe(true)
  })

  it('leaves an unmanaged existing .kb/ intact (only adds marker + new files)', async () => {
    const workDir = workspaceWith('ws-f')
    const kbRoot = path.join(workDir, '.kb')
    await mkdir(kbRoot, { recursive: true })
    writeFileSync(path.join(kbRoot, 'user-owned.md'), 'do not delete')

    const storage = storageWithContent('kbd_NEW', 'managed body')
    getKbDocStoragePathMock.mockReturnValue(storage)

    await syncKbDocsToWorkspaceAsync(workDir, [
      { id: 'kbd_NEW', name: 'managed', storagePath: 'kbd_NEW' },
    ])
    expect(readFileSync(path.join(kbRoot, 'user-owned.md'), 'utf-8')).toBe('do not delete')
    expect(existsSync(path.join(kbRoot, '.a2wave-kb-managed'))).toBe(true)
    expect(readFileSync(path.join(kbRoot, 'managed-NEW.md'), 'utf-8')).toBe('managed body')
  })

  it('keeps the filename within the 255-byte NAME_MAX for a long CJK name', async () => {
    // Names are bounded at 200 UTF-16 units, but ext4 counts UTF-8 bytes — 200 CJK
    // characters is 600. Without the byte clamp `cp` throws ENAMETOOLONG, and that
    // rejection escapes base-engine's try/catch and fails the whole run.
    const workDir = workspaceWith('ws-long')
    const storage = storageWithContent('kbd_LONGID000', 'body')
    getKbDocStoragePathMock.mockReturnValue(storage)

    await syncKbDocsToWorkspaceAsync(workDir, [
      { id: 'kbd_LONGID000', name: '知'.repeat(200), storagePath: 'kbd_LONGID000' },
    ])

    const written = require('node:fs')
      .readdirSync(path.join(workDir, '.kb'))
      .filter((f: string) => f.endsWith('.md'))
    expect(written).toHaveLength(1)
    expect(Buffer.byteLength(written[0], 'utf-8')).toBeLessThanOrEqual(255)
    // Truncation must not split a character — a lone replacement char means it did.
    expect(written[0]).not.toContain('�')
    expect(written[0].endsWith('-LONGID000.md')).toBe(true)
  })

  it('still produces a usable filename when truncation empties the slug', async () => {
    const workDir = workspaceWith('ws-trunc')
    const storage = storageWithContent('kbd_X', 'body')
    getKbDocStoragePathMock.mockReturnValue(storage)

    await syncKbDocsToWorkspaceAsync(workDir, [
      { id: 'kbd_X', name: '～'.repeat(200), storagePath: 'kbd_X' },
    ])
    expect(existsSync(path.join(workDir, '.kb', 'doc-X.md'))).toBe(true)
  })
})
