import { gitConfigSchema, gitRepoEntrySchema, scmSourceTypeEnum } from '@a2wave/shared'
import { describe, expect, it } from 'vitest'

describe('scmSourceTypeEnum', () => {
  it('keeps Git and Perforce as the only source types', async () => {
    expect(scmSourceTypeEnum.options).toEqual(['p4', 'git'])
  })
})

describe('gitRepoEntrySchema', () => {
  it('accepts a valid repo entry', async () => {
    const result = gitRepoEntrySchema.safeParse({
      repoUrl: 'https://github.com/org/repo.git',
      branch: 'develop',
      directory: 'my-repo',
    })
    expect(result.success).toBe(true)
  })

  it('rejects directory containing "/"', async () => {
    const result = gitRepoEntrySchema.safeParse({
      repoUrl: 'https://github.com/org/repo.git',
      directory: 'sub/dir',
    })
    expect(result.success).toBe(false)
  })

  it('rejects directory containing ".."', async () => {
    const result = gitRepoEntrySchema.safeParse({
      repoUrl: 'https://github.com/org/repo.git',
      directory: 'repo..',
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty directory', async () => {
    const result = gitRepoEntrySchema.safeParse({
      repoUrl: 'https://github.com/org/repo.git',
      directory: '',
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty repoUrl', async () => {
    const result = gitRepoEntrySchema.safeParse({
      repoUrl: '',
      directory: 'my-repo',
    })
    expect(result.success).toBe(false)
  })

  it('defaults branch to "main"', async () => {
    const result = gitRepoEntrySchema.parse({
      repoUrl: 'https://github.com/org/repo.git',
      directory: 'my-repo',
    })
    expect(result.branch).toBe('main')
  })
})

describe('gitConfigSchema - multi-repo support', () => {
  const baseConfig = {
    repoUrl: 'https://github.com/org/repo.git',
    branch: 'main',
  }

  it('accepts config with repos', async () => {
    const result = gitConfigSchema.safeParse({
      ...baseConfig,
      repos: [
        { repoUrl: 'https://github.com/org/a.git', directory: 'repo-a' },
        { repoUrl: 'https://github.com/org/b.git', directory: 'repo-b' },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('accepts config without repos (backward compat)', async () => {
    const result = gitConfigSchema.safeParse(baseConfig)
    expect(result.success).toBe(true)
  })

  it('accepts CodeGraph indexing flag', async () => {
    const result = gitConfigSchema.safeParse({ ...baseConfig, codegraphEnabled: true })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.codegraphEnabled).toBe(true)
  })

  it('accepts empty repoUrl for multi-repo mode', async () => {
    const result = gitConfigSchema.safeParse({
      repoUrl: '',
      repos: [{ repoUrl: 'https://github.com/org/a.git', directory: 'repo-a' }],
    })
    expect(result.success).toBe(true)
  })

  it('accepts empty repos array', async () => {
    const result = gitConfigSchema.safeParse({
      ...baseConfig,
      repos: [],
    })
    expect(result.success).toBe(true)
  })

  it('rejects repos with invalid directory', async () => {
    const result = gitConfigSchema.safeParse({
      ...baseConfig,
      repos: [{ repoUrl: 'https://github.com/org/a.git', directory: 'bad/dir' }],
    })
    expect(result.success).toBe(false)
  })
})
