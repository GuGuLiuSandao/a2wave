import { gitConfigSchema, gitRepoEntrySchema } from '@a2wave/shared'
import { describe, expect, it } from 'vitest'

describe('gitRepoEntrySchema', () => {
  it('accepts a valid repo entry', async () => {
    const result = gitRepoEntrySchema.safeParse({
      repoUrl: 'https://github.com/org/repo.git',
      directory: 'my-repo',
    })
    expect(result.success).toBe(true)
  })

  it('defaults branch to "main"', async () => {
    const result = gitRepoEntrySchema.parse({
      repoUrl: 'https://github.com/org/repo.git',
      directory: 'my-repo',
    })
    expect(result.branch).toBe('main')
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
      directory: '../escape',
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
})

describe('gitConfigSchema - multi-repo support', () => {
  const baseConfig = {
    repoUrl: 'https://github.com/org/repo.git',
  }

  it('accepts a full config with repos', async () => {
    const result = gitConfigSchema.safeParse({
      ...baseConfig,
      repos: [
        { repoUrl: 'https://github.com/org/a.git', directory: 'repo-a' },
        { repoUrl: 'https://github.com/org/b.git', directory: 'repo-b', branch: 'develop' },
      ],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.repos).toHaveLength(2)
      expect(result.data.repos![1].branch).toBe('develop')
    }
  })

  it('accepts config without repos (backward compat)', async () => {
    const result = gitConfigSchema.safeParse(baseConfig)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.repos).toBeUndefined()
    }
  })

  it('accepts empty repos array', async () => {
    const result = gitConfigSchema.safeParse({ ...baseConfig, repos: [] })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.repos).toEqual([])
    }
  })

  it('accepts empty repoUrl in multi-repo mode', async () => {
    const result = gitConfigSchema.safeParse({
      repoUrl: '',
      repos: [{ repoUrl: 'https://github.com/org/a.git', directory: 'repo-a' }],
    })
    expect(result.success).toBe(true)
  })

  it('rejects repos entry with invalid directory containing "/"', async () => {
    const result = gitConfigSchema.safeParse({
      ...baseConfig,
      repos: [{ repoUrl: 'https://github.com/org/a.git', directory: 'bad/dir' }],
    })
    expect(result.success).toBe(false)
  })
})
