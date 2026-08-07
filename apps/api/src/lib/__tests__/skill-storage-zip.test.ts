/**
 * Covers extractZipToSkill / writeSkillFile / validateSkillTotalSize /
 * getSkillsStorageRoot — the parts skill-storage.test.ts doesn't reach.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const envMock = { A2WAVE_SKILLS_STORAGE: '' }
vi.mock('../../env.js', () => ({
  get env() {
    return envMock
  },
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  MAX_SKILL_TOTAL_UPLOAD_BYTES,
  extractZipToSkill,
  getSkillStoragePath,
  getSkillsStorageRoot,
  validateSkillTotalSize,
  writeSkillFile,
} from '../skill-storage.js'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'skill-storage-zip-'))
  envMock.A2WAVE_SKILLS_STORAGE = tmp
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('getSkillsStorageRoot', () => {
  it('returns the resolved env path', async () => {
    expect(getSkillsStorageRoot()).toBe(path.resolve(process.cwd(), tmp))
  })
})

describe('writeSkillFile', () => {
  it('writes a file into the skill directory and creates parents', async () => {
    writeSkillFile('skl_1', 'docs/inner/note.txt', Buffer.from('hello'))
    expect(
      readFileSync(path.join(getSkillStoragePath('skl_1'), 'docs/inner/note.txt'), 'utf-8'),
    ).toBe('hello')
  })

  it('normalizes Windows-style separators', async () => {
    writeSkillFile('skl_2', 'a\\b\\c.txt', Buffer.from('x'))
    expect(existsSync(path.join(getSkillStoragePath('skl_2'), 'a/b/c.txt'))).toBe(true)
  })

  it('rejects empty paths', async () => {
    expect(() => writeSkillFile('skl_3', '', Buffer.alloc(0))).toThrow(/Invalid file path/)
    expect(() => writeSkillFile('skl_3', '/', Buffer.alloc(0))).toThrow(/Invalid file path/)
  })

  it('rejects parent-dir traversal', async () => {
    expect(() => writeSkillFile('skl_3', '../escape.txt', Buffer.from('x'))).toThrow(
      /Invalid file path/,
    )
  })
})

describe('validateSkillTotalSize', () => {
  it('accepts a size at the limit', async () => {
    expect(() => validateSkillTotalSize(MAX_SKILL_TOTAL_UPLOAD_BYTES)).not.toThrow()
  })

  it('rejects sizes above the limit', async () => {
    expect(() => validateSkillTotalSize(MAX_SKILL_TOTAL_UPLOAD_BYTES + 1)).toThrow(
      /Total folder upload size/,
    )
  })
})

describe('extractZipToSkill', () => {
  function buildZip(files: Record<string, string | Buffer>): Buffer {
    const z = new AdmZip()
    for (const [p, content] of Object.entries(files)) {
      z.addFile(p, typeof content === 'string' ? Buffer.from(content) : content)
    }
    return z.toBuffer()
  }

  it('extracts a flat ZIP containing only SKILL.md and parses frontmatter', async () => {
    const md = '---\nname: My Skill\ndescription: a desc\n---\n\nBody'
    const result = extractZipToSkill(buildZip({ 'SKILL.md': md }), 'skl_1')
    expect(result).toEqual({ name: 'My Skill', description: 'a desc', body: 'Body' })
    expect(existsSync(path.join(getSkillStoragePath('skl_1'), 'SKILL.md'))).toBe(true)
  })

  it('extracts a nested SKILL.md (prefers the deepest match in this simple case)', async () => {
    const md = '---\nname: Nested\n---\n\nBody'
    const buf = buildZip({ 'pkg/SKILL.md': md, 'pkg/extra.txt': 'hi' })
    const result = extractZipToSkill(buf, 'skl_2')
    expect(result.name).toBe('Nested')
    expect(readFileSync(path.join(getSkillStoragePath('skl_2'), 'pkg/extra.txt'), 'utf-8')).toBe(
      'hi',
    )
  })

  it('rejects ZIPs without a SKILL.md', async () => {
    expect(() => extractZipToSkill(buildZip({ 'README.md': 'no skill' }), 'skl_3')).toThrow(
      /No SKILL\.md file found/,
    )
  })

  it('rejects ZIPs whose total uncompressed size exceeds the cap', async () => {
    // We can't easily fake header.size on AdmZip without internal poking, but a
    // genuinely large payload triggers the per-entry header.size aggregation.
    const huge = Buffer.alloc(MAX_SKILL_TOTAL_UPLOAD_BYTES + 1, 0x42)
    expect(() => extractZipToSkill(buildZip({ 'SKILL.md': huge }), 'skl_4')).toThrow(/exceeds/)
  })

  // AdmZip aggressively normalizes entryName at construction, so we can't easily
  // round-trip a malicious "../" path through a real ZIP buffer. The traversal
  // checks are still exercised in extractZipToSkill via the resolve-prefix guard
  // below the buffer scan; covering them requires patching AdmZip internals,
  // which is out of scope for a unit test.
})
