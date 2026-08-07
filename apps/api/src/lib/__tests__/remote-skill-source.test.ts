import { Buffer } from 'node:buffer'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RemoteSkillError,
  calculateRemoteSkillDigest,
  compareRemoteSkillFiles,
  inspectRemoteSkillArchive,
  loadRemoteSkillBundle,
  mergeRemoteSkillFiles,
  parseRemoteSkillUrl,
} from '../remote-skill-source.js'

function makeRepositoryArchive(files: Record<string, string>, root = 'owner-repo-1234567'): Buffer {
  const zip = new AdmZip()
  for (const [path, content] of Object.entries(files)) {
    zip.addFile(`${root}/${path}`, Buffer.from(content))
  }
  return zip.toBuffer()
}

const VALID_SKILL_MD = `---
name: demo-skill
description: Use this skill for remote installer tests.
---

# Demo

Follow the instructions.
`

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseRemoteSkillUrl', () => {
  it('parses repository, tree, and skills.sh URL forms', async () => {
    expect(parseRemoteSkillUrl('https://github.com/acme/tools')).toMatchObject({
      owner: 'acme',
      repo: 'tools',
      requestedRef: null,
      requestedPath: '',
      catalog: null,
    })
    expect(
      parseRemoteSkillUrl('https://github.com/acme/tools/tree/main/skills/demo-skill'),
    ).toMatchObject({
      requestedRef: 'main',
      requestedPath: 'skills/demo-skill',
    })
    expect(parseRemoteSkillUrl('https://skills.sh/acme/tools/demo-skill')).toMatchObject({
      owner: 'acme',
      repo: 'tools',
      catalog: 'skills_sh',
      skillSelector: 'demo-skill',
    })
  })

  it.each([
    'http://github.com/acme/tools',
    'https://example.com/acme/tools',
    'https://token@github.com/acme/tools',
    'https://github.com/acme/tools?ref=main',
    'https://github.com/acme/tools/blob/main/SKILL.md',
    'https://skills.sh/acme/tools',
  ])('rejects unsupported URL %s', (url) => {
    expect(() => parseRemoteSkillUrl(url)).toThrow(RemoteSkillError)
  })
})

describe('inspectRemoteSkillArchive', () => {
  it('discovers a Skill package and excludes a nested Skill package', async () => {
    const archive = makeRepositoryArchive({
      'skills/demo-skill/SKILL.md': VALID_SKILL_MD,
      'skills/demo-skill/scripts/run.sh': '#!/bin/sh',
      'skills/demo-skill/nested-skill/SKILL.md': `---
name: nested-skill
description: Nested test skill.
---
Nested`,
      'skills/demo-skill/nested-skill/reference.md': 'nested',
    })
    const parsed = parseRemoteSkillUrl('https://github.com/acme/tools/tree/main/skills/demo-skill')

    const packages = inspectRemoteSkillArchive(archive, parsed)

    expect(packages).toHaveLength(2)
    expect(packages[0]).toMatchObject({
      name: 'demo-skill',
      path: 'skills/demo-skill',
      fileCount: 2,
    })
    expect(packages[0].files.map((file) => file.path)).toEqual(['scripts/run.sh', 'SKILL.md'])
    expect(packages[0].digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(packages[1]).toMatchObject({ name: 'nested-skill', fileCount: 2 })
  })

  it('uses the skills.sh slug to select one Skill', async () => {
    const archive = makeRepositoryArchive({
      'skills/demo-skill/SKILL.md': VALID_SKILL_MD,
      'skills/other-skill/SKILL.md': `---
name: other-skill
description: Another test skill.
---
Other`,
    })
    const parsed = parseRemoteSkillUrl('https://skills.sh/acme/tools/demo-skill')

    expect(inspectRemoteSkillArchive(archive, parsed).map((candidate) => candidate.name)).toEqual([
      'demo-skill',
    ])
  })

  it('rejects frontmatter names that do not match the directory', async () => {
    const archive = makeRepositoryArchive({
      'skills/wrong-directory/SKILL.md': VALID_SKILL_MD,
    })
    const parsed = parseRemoteSkillUrl('https://github.com/acme/tools')

    expect(() => inspectRemoteSkillArchive(archive, parsed)).toThrow(
      'must match its directory name',
    )
  })

  it('rejects symbolic links before materializing a package', async () => {
    const zip = new AdmZip()
    zip.addFile('owner-repo-123/skills/demo-skill/SKILL.md', Buffer.from(VALID_SKILL_MD))
    zip.addFile('owner-repo-123/skills/demo-skill/link', Buffer.from('target'))
    const link = zip.getEntry('owner-repo-123/skills/demo-skill/link')
    if (!link) throw new Error('test link entry missing')
    ;(link as unknown as { attr: number }).attr = (0o120777 << 16) >>> 0

    expect(() =>
      inspectRemoteSkillArchive(
        zip.toBuffer(),
        parseRemoteSkillUrl('https://github.com/acme/tools'),
      ),
    ).toThrow('symlink')
  })

  it('ignores symbolic links outside the selected Skill package', async () => {
    const zip = new AdmZip()
    zip.addFile('owner-repo-123/AGENTS.md', Buffer.from('shared/AGENTS.md'))
    zip.addFile('owner-repo-123/skills/demo-skill/SKILL.md', Buffer.from(VALID_SKILL_MD))
    const link = zip.getEntry('owner-repo-123/AGENTS.md')
    if (!link) throw new Error('test link entry missing')
    ;(link as unknown as { attr: number }).attr = (0o120777 << 16) >>> 0

    const packages = inspectRemoteSkillArchive(
      zip.toBuffer(),
      parseRemoteSkillUrl('https://github.com/acme/tools'),
    )

    expect(packages).toHaveLength(1)
    expect(packages[0].files.map((file) => file.path)).toEqual(['SKILL.md'])
  })

  it('rejects a Skill with more than the file-count limit', async () => {
    const files: Record<string, string> = {
      'skills/demo-skill/SKILL.md': VALID_SKILL_MD,
    }
    for (let index = 0; index < 500; index++) {
      files[`skills/demo-skill/references/${index}.md`] = `${index}`
    }

    expect(() =>
      inspectRemoteSkillArchive(
        makeRepositoryArchive(files),
        parseRemoteSkillUrl('https://github.com/acme/tools'),
      ),
    ).toThrow('more than 500 files')
  })

  it('rejects repositories whose selected Skill packages exceed the materialization budget', async () => {
    const files: Record<string, string> = {}
    for (const name of ['skill-one', 'skill-two', 'skill-three']) {
      files[`skills/${name}/SKILL.md`] = `---
name: ${name}
description: Materialization budget test.
---
Test`
      files[`skills/${name}/payload.txt`] = 'x'.repeat(7 * 1024 * 1024)
    }
    const archive = makeRepositoryArchive(files)

    expect(() =>
      inspectRemoteSkillArchive(archive, parseRemoteSkillUrl('https://github.com/acme/tools')),
    ).toThrow('expand beyond 20MB')

    expect(
      inspectRemoteSkillArchive(
        archive,
        parseRemoteSkillUrl('https://github.com/acme/tools/tree/main/skills/skill-one'),
      ).map((candidate) => candidate.name),
    ).toEqual(['skill-one'])
  })
})

describe('loadRemoteSkillBundle', () => {
  it('resolves the default branch and downloads an immutable revision', async () => {
    const archive = makeRepositoryArchive({
      'skills/demo-skill/SKILL.md': VALID_SKILL_MD,
    })
    const revision = 'a'.repeat(40)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ default_branch: 'main' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sha: revision }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response(archive as unknown as BodyInit, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await loadRemoteSkillBundle('https://github.com/acme/tools')

    expect(result.inspection).toMatchObject({
      repository: 'acme/tools',
      requestedRef: 'main',
      revision,
    })
    expect(result.inspection.candidates).toHaveLength(1)
    expect(fetchMock.mock.calls[2][0]).toContain(`/zipball/${revision}`)
  })

  it('fails clearly when the public repository does not exist', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })))

    await expect(loadRemoteSkillBundle('https://github.com/acme/missing')).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('uses the longest matching branch name in a GitHub tree URL', async () => {
    const archive = makeRepositoryArchive({
      'skills/demo-skill/SKILL.md': VALID_SKILL_MD,
    })
    const revision = 'c'.repeat(40)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { ref: 'refs/heads/feature' },
            { ref: 'refs/heads/feature/remote-skills' },
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: revision }), { status: 200 }))
      .mockResolvedValueOnce(new Response(archive as unknown as BodyInit, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await loadRemoteSkillBundle(
      'https://github.com/acme/tools/tree/feature/remote-skills/skills/demo-skill',
    )

    expect(result.inspection).toMatchObject({
      requestedRef: 'feature/remote-skills',
      revision,
    })
    expect(result.inspection.candidates.map((candidate) => candidate.path)).toEqual([
      'skills/demo-skill',
    ])
    expect(fetchMock.mock.calls[2][0]).toContain('feature%2Fremote-skills')
  })
})

describe('remote Skill file comparison and merge', () => {
  const file = (path: string, content: string) => ({ path, content: Buffer.from(content) })
  const base = [file('SKILL.md', 'base'), file('shared.txt', 'base'), file('old.txt', 'old')]
  const local = [
    file('SKILL.md', 'local'),
    file('shared.txt', 'local-shared'),
    file('local.txt', 'local'),
  ]
  const latest = [
    file('SKILL.md', 'remote'),
    file('shared.txt', 'remote-shared'),
    file('remote.txt', 'remote'),
  ]

  it('reports local, remote, and conflicting file changes', async () => {
    expect(compareRemoteSkillFiles(base, local, latest)).toEqual([
      { path: 'local.txt', localChange: 'added', remoteChange: null, conflict: false },
      { path: 'old.txt', localChange: 'deleted', remoteChange: 'deleted', conflict: false },
      { path: 'remote.txt', localChange: null, remoteChange: 'added', conflict: false },
      {
        path: 'shared.txt',
        localChange: 'modified',
        remoteChange: 'modified',
        conflict: true,
      },
      {
        path: 'SKILL.md',
        localChange: 'modified',
        remoteChange: 'modified',
        conflict: true,
      },
    ])
  })

  it('aborts, preserves local conflicts, or overwrites them explicitly', async () => {
    expect(() => mergeRemoteSkillFiles(base, local, latest, 'abort')).toThrow(
      'conflicts at shared.txt',
    )

    const preserved = mergeRemoteSkillFiles(base, local, latest, 'preserve_local')
    expect(preserved.preservedLocalChanges).toBe(true)
    expect(preserved.files.map((entry) => [entry.path, entry.content.toString()])).toEqual([
      ['local.txt', 'local'],
      ['remote.txt', 'remote'],
      ['shared.txt', 'local-shared'],
      ['SKILL.md', 'local'],
    ])

    const overwritten = mergeRemoteSkillFiles(base, local, latest, 'overwrite')
    expect(overwritten.preservedLocalChanges).toBe(false)
    expect(calculateRemoteSkillDigest(overwritten.files)).toBe(calculateRemoteSkillDigest(latest))
  })
})
