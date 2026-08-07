import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import matter from 'gray-matter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getSkillStoragePathMock = vi.fn()
vi.mock('../../lib/skill-storage.js', () => ({
  getSkillStoragePath: (id: string) => getSkillStoragePathMock(id),
}))

vi.mock('../../lib/slug.js', () => ({
  slugify: (s: string) => s.toLowerCase().replace(/\s+/g, '-'),
}))

import type { SkillFile } from '../skill-sync.js'
import { syncSkillsToWorkspaceAsync } from '../skill-sync.js'

const SKILLS_DIR = '.cursor/skills'
let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'skill-sync-async-test-'))
  getSkillStoragePathMock.mockReset()
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** 原始读取（不解析），用于附加文件与需要看 frontmatter 的断言。 */
function readRaw(slug: string, file = 'SKILL.md') {
  return readFileSync(path.join(tmp, SKILLS_DIR, slug, file), 'utf-8')
}

/**
 * 读取 managed SKILL.md 的正文（剥掉 composeSkillMd 注入的 frontmatter）。
 * 同步产物一定带 frontmatter，正文类断言用此 helper；frontmatter 由底部专门用例覆盖。
 */
function readSkillBody(slug: string, file = 'SKILL.md') {
  return matter(readRaw(slug, file)).content.trim()
}

describe('syncSkillsToWorkspaceAsync', () => {
  it('creates the skills root and writes a SKILL.md + marker per skill', async () => {
    const skills: SkillFile[] = [{ name: 'Skill One', content: '# one' }]
    await syncSkillsToWorkspaceAsync(tmp, SKILLS_DIR, skills)
    expect(existsSync(path.join(tmp, SKILLS_DIR, 'skill-one'))).toBe(true)
    expect(readSkillBody('skill-one')).toBe('# one')
    expect(existsSync(path.join(tmp, SKILLS_DIR, 'skill-one', '.a2wave-managed'))).toBe(true)
  })

  it('removes a previous managed skill dir on re-sync but leaves user-owned dirs', async () => {
    // Pre-existing managed dir
    const managedDir = path.join(tmp, SKILLS_DIR, 'old-managed')
    mkdirSync(managedDir, { recursive: true })
    writeFileSync(path.join(managedDir, '.a2wave-managed'), '')
    writeFileSync(path.join(managedDir, 'SKILL.md'), 'stale')

    // Pre-existing user-owned dir (no marker)
    const userDir = path.join(tmp, SKILLS_DIR, 'user-owned')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(path.join(userDir, 'SKILL.md'), 'kept')

    await syncSkillsToWorkspaceAsync(tmp, SKILLS_DIR, [{ name: 'fresh', content: 'new' }])

    expect(existsSync(managedDir)).toBe(false)
    expect(readFileSync(path.join(userDir, 'SKILL.md'), 'utf-8')).toBe('kept')
    expect(readSkillBody('fresh')).toBe('new')
  })

  it('renames the managed dir with --a2w when colliding with a user dir', async () => {
    const userDir = path.join(tmp, SKILLS_DIR, 'sharedname')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(path.join(userDir, 'SKILL.md'), 'user content')

    await syncSkillsToWorkspaceAsync(tmp, SKILLS_DIR, [{ name: 'sharedname', content: 'managed' }])

    expect(readFileSync(path.join(userDir, 'SKILL.md'), 'utf-8')).toBe('user content')
    expect(readSkillBody('sharedname--a2w')).toBe('managed')
  })

  it('copies extra storage files (except SKILL.md) into the skill dir', async () => {
    const storageDir = path.join(tmp, 'storage', 'skl_1')
    mkdirSync(storageDir, { recursive: true })
    writeFileSync(path.join(storageDir, 'extra.txt'), 'extra')
    writeFileSync(path.join(storageDir, 'SKILL.md'), 'storage version (should be ignored)')

    getSkillStoragePathMock.mockReturnValue(storageDir)

    await syncSkillsToWorkspaceAsync(tmp, SKILLS_DIR, [
      { name: 'with extras', content: 'main', storagePath: 'skl_1' },
    ])
    const slug = 'with-extras'
    expect(readRaw(slug, 'extra.txt')).toBe('extra')
    // SKILL.md 正文来自 DB content，而非 storage 的 SKILL.md
    expect(readSkillBody(slug)).toBe('main')
  })

  it('writes frontmatter-only SKILL.md when content is null (empty body)', async () => {
    await syncSkillsToWorkspaceAsync(tmp, SKILLS_DIR, [{ name: 'empty', content: null }])
    // null content 仍写出带 name frontmatter 的文件，正文为空
    expect(readRaw('empty')).toContain('name: empty')
    expect(readSkillBody('empty')).toBe('')
  })

  it('silently skips copy when storagePath has no corresponding source dir', async () => {
    getSkillStoragePathMock.mockReturnValue(path.join(tmp, 'no-such-dir'))
    await syncSkillsToWorkspaceAsync(tmp, SKILLS_DIR, [
      { name: 'orphan', content: 'x', storagePath: 'missing' },
    ])
    expect(readSkillBody('orphan')).toBe('x')
  })

  it('injects name/description frontmatter into the synced SKILL.md', async () => {
    await syncSkillsToWorkspaceAsync(tmp, SKILLS_DIR, [
      { name: 'Fronted', description: 'use me when X', content: '# body' },
    ])
    const raw = readRaw('fronted')
    expect(raw.startsWith('---\n')).toBe(true)
    expect(raw).toContain('name: Fronted')
    expect(raw).toContain('description: use me when X')
    expect(readSkillBody('fronted')).toBe('# body')
  })

  // 生产实际走 async 路径（base-engine.ts:79），下面两条把 sync 套件里的强不变量
  // 也锁定在 async 路径上（两路径共享 composeSkillMd）。
  it('rebuilds frontmatter without crashing when body opens with an invalid YAML --- block', async () => {
    await syncSkillsToWorkspaceAsync(tmp, SKILLS_DIR, [
      { name: 'Bad YAML', description: 'desc', content: '---\nfoo: [unclosed\n---\nbody text' },
    ])
    const raw = readRaw('bad-yaml')
    expect(raw.startsWith('---\n')).toBe(true)
    expect(raw).toContain('name: Bad YAML')
    expect(raw).toContain('foo: [unclosed') // 原正文作为 body 保留
  })

  it('injects DB name even when body opens with a non-name frontmatter block', async () => {
    await syncSkillsToWorkspaceAsync(tmp, SKILLS_DIR, [
      { name: 'Has Name', content: '---\nfoo: bar\n---\nbody' },
    ])
    const fm = matter(readRaw('has-name')).data
    expect(fm.name).toBe('Has Name')
    // 真守卫「序列化不解析 content」：foo 必须留在 body、不上浮进权威 frontmatter
    expect(fm.foo).toBeUndefined()
    expect(readRaw('has-name')).toContain('---\nfoo: bar\n---')
  })
})
