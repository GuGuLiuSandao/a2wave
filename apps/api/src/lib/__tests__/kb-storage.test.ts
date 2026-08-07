import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const envMock = { A2WAVE_KB_STORAGE: '' }

vi.mock('../../env.js', () => ({
  get env() {
    return envMock
  },
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  getKbDocSize,
  getKbDocStoragePath,
  getKbStorageRoot,
  readKbContent,
  readKbMeta,
  removeKbStorage,
  validateKbFileSize,
  writeKbContent,
  writeKbMeta,
  writeKbOriginalFile,
} from '../kb-storage.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'kb-storage-test-'))
  envMock.A2WAVE_KB_STORAGE = tmpRoot
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('kb-storage paths', () => {
  it('returns the absolute storage root from env', async () => {
    expect(getKbStorageRoot()).toBe(path.resolve(process.cwd(), tmpRoot))
  })

  it('produces a per-doc directory under the root', async () => {
    const docDir = getKbDocStoragePath('kbd_1')
    expect(docDir).toBe(path.join(getKbStorageRoot(), 'kbd_1'))
  })
})

describe('writeKbContent / readKbContent', () => {
  it('writes content.md, creates parent dir, and round-trips read', async () => {
    writeKbContent('kbd_1', 'hello kb')
    const docDir = getKbDocStoragePath('kbd_1')
    expect(existsSync(path.join(docDir, 'content.md'))).toBe(true)
    expect(readKbContent('kbd_1')).toBe('hello kb')
  })

  it('returns null when content.md does not exist', async () => {
    expect(readKbContent('missing')).toBeNull()
  })
})

describe('writeKbMeta / readKbMeta', () => {
  it('round-trips a JSON meta payload', async () => {
    writeKbMeta('kbd_2', { title: 't', count: 1 })
    expect(readKbMeta('kbd_2')).toEqual({ title: 't', count: 1 })
  })

  it('returns null for missing meta.json', async () => {
    expect(readKbMeta('missing')).toBeNull()
  })

  it('returns null when meta.json is corrupted', async () => {
    writeKbContent('kbd_3', 'x')
    const file = path.join(getKbDocStoragePath('kbd_3'), 'meta.json')
    // Bypass the public writer to inject junk
    require('node:fs').writeFileSync(file, 'not-json{', 'utf-8')
    expect(readKbMeta('kbd_3')).toBeNull()
  })
})

describe('writeKbOriginalFile', () => {
  it('writes file content into the doc directory', async () => {
    writeKbOriginalFile('kbd_4', 'a.txt', Buffer.from('payload'))
    const file = path.join(getKbDocStoragePath('kbd_4'), 'a.txt')
    expect(readFileSync(file, 'utf-8')).toBe('payload')
  })

  it('normalizes redundant slashes and creates nested directories', async () => {
    writeKbOriginalFile('kbd_5', '/sub//dir/b.bin', Buffer.from([0x01, 0x02]))
    const file = path.join(getKbDocStoragePath('kbd_5'), 'sub', 'dir', 'b.bin')
    expect(existsSync(file)).toBe(true)
  })

  it('rejects empty or normalized-to-empty filenames', async () => {
    expect(() => writeKbOriginalFile('kbd_5', '', Buffer.alloc(0))).toThrow(/Invalid file path/)
    expect(() => writeKbOriginalFile('kbd_5', '/', Buffer.alloc(0))).toThrow(/Invalid file path/)
  })

  it('rejects parent-dir traversal attempts', async () => {
    expect(() => writeKbOriginalFile('kbd_6', '../escape.txt', Buffer.from('x'))).toThrow(
      /Invalid file path/,
    )
  })
})

describe('removeKbStorage', () => {
  it('removes the doc directory if it exists', async () => {
    writeKbContent('kbd_7', 'data')
    expect(existsSync(getKbDocStoragePath('kbd_7'))).toBe(true)
    removeKbStorage('kbd_7')
    expect(existsSync(getKbDocStoragePath('kbd_7'))).toBe(false)
  })

  it('is a no-op when the directory does not exist', async () => {
    expect(() => removeKbStorage('never-created')).not.toThrow()
  })
})

describe('getKbDocSize', () => {
  it('returns 0 when content.md is missing', async () => {
    expect(getKbDocSize('missing')).toBe(0)
  })

  it('returns the byte size of content.md', async () => {
    writeKbContent('kbd_8', 'abcdef')
    expect(getKbDocSize('kbd_8')).toBe(6)
  })
})

describe('validateKbFileSize', () => {
  it('throws when size exceeds the per-file limit', async () => {
    expect(() => validateKbFileSize(10 * 1024 * 1024 + 1)).toThrow(/A single file must not exceed/)
  })

  it('accepts sizes at or below the limit', async () => {
    expect(() => validateKbFileSize(10 * 1024 * 1024)).not.toThrow()
    expect(() => validateKbFileSize(0)).not.toThrow()
  })
})
