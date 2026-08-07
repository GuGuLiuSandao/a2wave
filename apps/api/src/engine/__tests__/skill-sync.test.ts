import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import matter from 'gray-matter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let STORAGE_ROOT = ''
vi.mock('../../lib/skill-storage.js', () => ({
  getSkillStoragePath: (storagePath: string) => join(STORAGE_ROOT, storagePath),
}))

import { type SkillFile, syncSkillsToWorkspaceAsync } from '../skill-sync.js'

let TEST_ROOT = ''

function readDir(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : []
}

/** 原始读取文件内容（不做任何解析）。用于附加文件、用户自有文件、以及需要看 frontmatter 的断言。 */
function readFile(path: string): string {
  return readFileSync(path, 'utf-8')
}

/**
 * 读取 managed SKILL.md 的正文（剥掉 composeSkillMd 注入的 name/description frontmatter）。
 * 同步产物现在一定带 frontmatter，正文类断言用此 helper；frontmatter 本身由底部专门用例覆盖。
 */
function readSkillBody(path: string): string {
  return matter(readFileSync(path, 'utf-8')).content.trim()
}

describe('syncSkillsToWorkspaceAsync', () => {
  beforeEach(() => {
    TEST_ROOT = mkdtempSync(join(tmpdir(), 'a2w-skill-sync-'))
    STORAGE_ROOT = mkdtempSync(join(tmpdir(), 'a2w-skill-storage-'))
  })

  afterEach(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true })
    rmSync(STORAGE_ROOT, { recursive: true, force: true })
  })

  it('creates skillsDir and writes skill directories with SKILL.md', async () => {
    const skills: SkillFile[] = [
      { name: 'Clean Code', content: '# Clean Code\nWrite clean code.' },
      { name: 'TDD', content: '# TDD\nTest first.' },
    ]

    await syncSkillsToWorkspaceAsync(TEST_ROOT, '.cursor/skills', skills)

    const targetDir = join(TEST_ROOT, '.cursor', 'skills')
    expect(existsSync(targetDir)).toBe(true)

    const files = readDir(targetDir)
    expect(files).toEqual(['clean-code', 'tdd'])

    expect(readSkillBody(join(targetDir, 'clean-code', 'SKILL.md'))).toBe(
      '# Clean Code\nWrite clean code.',
    )
    expect(readSkillBody(join(targetDir, 'tdd', 'SKILL.md'))).toBe('# TDD\nTest first.')
  })

  it('cleans up old managed skill directories before writing new ones', async () => {
    const targetDir = join(TEST_ROOT, '.cursor', 'skills')
    mkdirSync(targetDir, { recursive: true })

    await syncSkillsToWorkspaceAsync(TEST_ROOT, '.cursor/skills', [
      { name: 'Old Skill', content: 'old content' },
    ])

    const skills: SkillFile[] = [{ name: 'New Skill', content: 'new content' }]

    await syncSkillsToWorkspaceAsync(TEST_ROOT, '.cursor/skills', skills)

    const files = readDir(targetDir)
    expect(files).toEqual(['new-skill'])
    expect(readSkillBody(join(targetDir, 'new-skill', 'SKILL.md'))).toBe('new content')
  })

  it('preserves user-created directories (without managed marker)', async () => {
    const targetDir = join(TEST_ROOT, '.cursor', 'skills')
    mkdirSync(targetDir, { recursive: true })

    const userDir = join(targetDir, 'my-custom-skill')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'SKILL.md'), 'user content')

    await syncSkillsToWorkspaceAsync(TEST_ROOT, '.cursor/skills', [
      { name: 'Fresh', content: 'fresh content' },
    ])

    const files = readDir(targetDir)
    expect(files).toContain('my-custom-skill')
    expect(files).toContain('fresh')
    // 用户自有文件原样保留，不经 composeSkillMd，故无 frontmatter
    expect(readFile(join(targetDir, 'my-custom-skill', 'SKILL.md'))).toBe('user content')
  })

  it('avoids overwriting user-owned skill directory with same slug', async () => {
    const targetDir = join(TEST_ROOT, '.cursor', 'skills')
    const userDir = join(targetDir, 'clean-code')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'SKILL.md'), 'user-defined content')

    await syncSkillsToWorkspaceAsync(TEST_ROOT, '.cursor/skills', [
      { name: 'Clean Code', content: 'managed content' },
    ])

    const files = readDir(targetDir)
    expect(files).toContain('clean-code')
    expect(files).toContain('clean-code--a2w')
    expect(readFile(join(userDir, 'SKILL.md'))).toBe('user-defined content')
    expect(readSkillBody(join(targetDir, 'clean-code--a2w', 'SKILL.md'))).toBe('managed content')
  })

  it('supports different skillsDir paths (e.g. .gemini/skills)', async () => {
    await syncSkillsToWorkspaceAsync(TEST_ROOT, '.gemini/skills', [
      { name: 'Gemini Skill', content: 'gemini content' },
    ])

    const targetDir = join(TEST_ROOT, '.gemini', 'skills')
    expect(existsSync(targetDir)).toBe(true)

    const files = readDir(targetDir)
    expect(files).toEqual(['gemini-skill'])
    expect(readSkillBody(join(targetDir, 'gemini-skill', 'SKILL.md'))).toBe('gemini content')
  })

  it('handles empty skills array (cleans up all managed skill directories)', async () => {
    const targetDir = join(TEST_ROOT, '.cursor', 'skills')
    mkdirSync(targetDir, { recursive: true })
    await syncSkillsToWorkspaceAsync(TEST_ROOT, '.cursor/skills', [
      { name: 'Stale', content: 'stale' },
    ])
    const userDir = join(targetDir, 'user-owned')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'SKILL.md'), 'keep me')

    await syncSkillsToWorkspaceAsync(TEST_ROOT, '.cursor/skills', [])

    const files = readDir(targetDir)
    expect(files).toEqual(['user-owned'])
  })

  it('writes frontmatter-only SKILL.md when content is null (empty body)', async () => {
    await syncSkillsToWorkspaceAsync(TEST_ROOT, '.cursor/skills', [
      { name: 'Empty Skill', content: null },
    ])

    const targetDir = join(TEST_ROOT, '.cursor', 'skills')
    const files = readDir(targetDir)
    expect(files).toEqual(['empty-skill'])
    // null content 仍写出带 name frontmatter 的文件（保证引擎不报 missing frontmatter），正文为空
    const skillPath = join(targetDir, 'empty-skill', 'SKILL.md')
    expect(readFile(skillPath)).toContain('name: Empty Skill')
    expect(readSkillBody(skillPath)).toBe('')
  })

  it('writes Claude skills in official .claude/skills/<name>/SKILL.md structure', async () => {
    await syncSkillsToWorkspaceAsync(TEST_ROOT, '.claude/skills', [
      { name: 'Code Review', content: '# Review' },
      { name: 'Spec Plan', content: '# Plan' },
    ])

    const claudeRoot = join(TEST_ROOT, '.claude', 'skills')
    const folders = readDir(claudeRoot)
    expect(folders).toEqual(['code-review', 'spec-plan'])
    expect(readSkillBody(join(claudeRoot, 'code-review', 'SKILL.md'))).toBe('# Review')
    expect(readSkillBody(join(claudeRoot, 'spec-plan', 'SKILL.md'))).toBe('# Plan')
  })

  it('cleans only managed Claude skill directories', async () => {
    const claudeRoot = join(TEST_ROOT, '.claude', 'skills')
    const userDir = join(claudeRoot, 'user-owned')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'SKILL.md'), 'user skill')

    await syncSkillsToWorkspaceAsync(TEST_ROOT, '.claude/skills', [
      { name: 'Managed', content: 'managed v1' },
    ])
    await syncSkillsToWorkspaceAsync(TEST_ROOT, '.claude/skills', [
      { name: 'Managed', content: 'managed v2' },
    ])

    const folders = readDir(claudeRoot)
    expect(folders).toContain('user-owned')
    expect(folders).toContain('managed')
    expect(readSkillBody(join(claudeRoot, 'managed', 'SKILL.md'))).toBe('managed v2')
    expect(readFile(join(claudeRoot, 'user-owned', 'SKILL.md'))).toBe('user skill')
  })

  it('copies scripts/, references/, templates/ from skill storage', async () => {
    const storageDir = join(STORAGE_ROOT, 'skl_abc')
    mkdirSync(join(storageDir, 'scripts'), { recursive: true })
    mkdirSync(join(storageDir, 'references'), { recursive: true })
    mkdirSync(join(storageDir, 'templates'), { recursive: true })
    writeFileSync(join(storageDir, 'SKILL.md'), '---\nname: With Files\n---\nold body')
    writeFileSync(join(storageDir, 'scripts', 'run.sh'), '#!/bin/bash\necho hello')
    writeFileSync(join(storageDir, 'references', 'guide.md'), '# Guide')
    writeFileSync(join(storageDir, 'templates', 'output.tpl'), '{{result}}')

    await syncSkillsToWorkspaceAsync(TEST_ROOT, '.cursor/skills', [
      { name: 'With Files', content: 'db content', storagePath: 'skl_abc' },
    ])

    const targetDir = join(TEST_ROOT, '.cursor', 'skills', 'with-files')
    expect(readSkillBody(join(targetDir, 'SKILL.md'))).toBe('db content')
    expect(readFile(join(targetDir, 'scripts', 'run.sh'))).toBe('#!/bin/bash\necho hello')
    expect(readFile(join(targetDir, 'references', 'guide.md'))).toBe('# Guide')
    expect(readFile(join(targetDir, 'templates', 'output.tpl'))).toBe('{{result}}')
  })

  it('skips storage copy when storagePath is null/undefined', async () => {
    await syncSkillsToWorkspaceAsync(TEST_ROOT, '.cursor/skills', [
      { name: 'No Storage', content: 'content only' },
      { name: 'Null Storage', content: 'also content', storagePath: null },
    ])

    const targetDir = join(TEST_ROOT, '.cursor', 'skills')
    expect(readSkillBody(join(targetDir, 'no-storage', 'SKILL.md'))).toBe('content only')
    expect(readSkillBody(join(targetDir, 'null-storage', 'SKILL.md'))).toBe('also content')
  })

  it('handles non-existent storage path gracefully', async () => {
    await syncSkillsToWorkspaceAsync(TEST_ROOT, '.cursor/skills', [
      { name: 'Missing Storage', content: 'body', storagePath: 'skl_nonexistent' },
    ])

    const targetDir = join(TEST_ROOT, '.cursor', 'skills', 'missing-storage')
    expect(readSkillBody(join(targetDir, 'SKILL.md'))).toBe('body')
  })

  it('DB content takes precedence over SKILL.md in storage', async () => {
    const storageDir = join(STORAGE_ROOT, 'skl_override')
    mkdirSync(storageDir, { recursive: true })
    writeFileSync(join(storageDir, 'SKILL.md'), 'stale storage content')

    await syncSkillsToWorkspaceAsync(TEST_ROOT, '.cursor/skills', [
      { name: 'Override Test', content: 'fresh db content', storagePath: 'skl_override' },
    ])

    const targetDir = join(TEST_ROOT, '.cursor', 'skills', 'override-test')
    const raw = readFile(join(targetDir, 'SKILL.md'))
    // 产物完全由 DB 重建：正文取 DB content、frontmatter 取 DB name，storage 原 SKILL.md 被忽略
    expect(raw).not.toContain('stale storage content')
    expect(raw).toContain('name: Override Test')
    expect(readSkillBody(join(targetDir, 'SKILL.md'))).toBe('fresh db content')
  })

  it('copies nested directory structures from storage', async () => {
    const storageDir = join(STORAGE_ROOT, 'skl_nested')
    mkdirSync(join(storageDir, 'scripts', 'utils'), { recursive: true })
    writeFileSync(join(storageDir, 'SKILL.md'), 'nested skill')
    writeFileSync(join(storageDir, 'scripts', 'main.sh'), 'main')
    writeFileSync(join(storageDir, 'scripts', 'utils', 'helper.sh'), 'helper')

    await syncSkillsToWorkspaceAsync(TEST_ROOT, '.cursor/skills', [
      { name: 'Nested', content: 'nested body', storagePath: 'skl_nested' },
    ])

    const targetDir = join(TEST_ROOT, '.cursor', 'skills', 'nested')
    expect(readFile(join(targetDir, 'scripts', 'main.sh'))).toBe('main')
    expect(readFile(join(targetDir, 'scripts', 'utils', 'helper.sh'))).toBe('helper')
  })

  it('injects YAML frontmatter (name + description) into the synced SKILL.md', async () => {
    await syncSkillsToWorkspaceAsync(TEST_ROOT, '.cursor/skills', [
      { name: 'Front Matter', description: 'when to use this skill', content: '# body' },
    ])
    const skillPath = join(TEST_ROOT, '.cursor', 'skills', 'front-matter', 'SKILL.md')
    const raw = readFile(skillPath)
    expect(raw.startsWith('---\n')).toBe(true)
    expect(raw).toContain('name: Front Matter')
    expect(raw).toContain('description: when to use this skill')
    expect(readSkillBody(skillPath)).toBe('# body')
  })

  it('does not double-wrap content that already has frontmatter', async () => {
    const withFm = '---\nname: Already\n---\n# body'
    await syncSkillsToWorkspaceAsync(TEST_ROOT, '.cursor/skills', [
      { name: 'Already', content: withFm },
    ])
    const raw = readFile(join(TEST_ROOT, '.cursor', 'skills', 'already', 'SKILL.md'))
    expect(raw).toBe(withFm)
  })

  it('rebuilds frontmatter without crashing when body opens with an invalid YAML --- block', async () => {
    // parseSkillMd 只剥首个 frontmatter，DB 正文可能以非法 YAML 的 --- 块开头。
    // matter() 会抛 YAMLException；composeSkillMd 必须吞掉并照常重建，
    // 否则异常越过 executeStream 的 fallback 直接判 run 失败。
    const badYaml = '---\nfoo: [unclosed\n---\nbody text'
    await expect(
      syncSkillsToWorkspaceAsync(TEST_ROOT, '.cursor/skills', [
        { name: 'Bad YAML', description: 'desc', content: badYaml },
      ]),
    ).resolves.not.toThrow()
    const raw = readFile(join(TEST_ROOT, '.cursor', 'skills', 'bad-yaml', 'SKILL.md'))
    expect(raw.startsWith('---\n')).toBe(true)
    expect(raw).toContain('name: Bad YAML')
    expect(raw).toContain('foo: [unclosed') // 原正文作为 body 保留
  })

  it('injects DB name even when body opens with a non-name frontmatter block', async () => {
    // 正文以「合法但无 name」的 frontmatter 开头：不能误判为幂等而跳过，否则产物缺 name。
    await syncSkillsToWorkspaceAsync(TEST_ROOT, '.cursor/skills', [
      { name: 'Has Name', content: '---\nfoo: bar\n---\nbody' },
    ])
    const raw = readFile(join(TEST_ROOT, '.cursor', 'skills', 'has-name', 'SKILL.md'))
    const fm = matter(raw).data
    // 产物首个 frontmatter 必须含 DB 注入的 name
    expect(fm.name).toBe('Has Name')
    // 真守卫「序列化不解析 content」：content 首段的 foo 必须留在 body、不上浮进权威
    // frontmatter——若退回 stringify(content) 会把 foo 合并进首段，此断言即失败（不依赖 cache）。
    expect(fm.foo).toBeUndefined()
    expect(raw).toContain('---\nfoo: bar\n---')
  })
})
