import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import type { GitConfig } from '@a2wave/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GIT_PROBE_CONCURRENCY,
  buildAuthUrl,
  checkGitConnection,
  executeGitSync,
} from '../git-sync.js'

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
}))

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

const mockExecFile = vi.mocked(execFile)
const mockMkdir = vi.mocked(mkdir)
const mockExistsSync = vi.mocked(existsSync)
const mockReaddir = vi.mocked(readdir)

/** GitConfig zod type requires autoSync/syncIntervalMin/initialSyncTimeoutMin
 * (they have defaults in the schema, so the inferred type marks them
 * required). Tests spread these defaults to satisfy the type. */
const gitConfigDefaults = {
  autoSync: false as boolean,
  syncIntervalMin: 30,
  initialSyncTimeoutMin: 60,
}

function setupExecFile(impl: (cmd: string, args: string[]) => { stdout: string; stderr: string }) {
  mockExecFile.mockImplementation(((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: unknown, result: unknown) => void
    const cmd = args[0] as string
    const cmdArgs = args[1] as string[]
    try {
      const result = impl(cmd, cmdArgs)
      cb(null, result)
    } catch (err) {
      cb(err, null)
    }
  }) as typeof execFile)
}

describe('buildAuthUrl', () => {
  it('returns original URL when no credentials provided', async () => {
    const config: GitConfig = {
      ...gitConfigDefaults,
      repoUrl: 'https://github.com/org/repo.git',
      branch: 'main',
    }
    expect(buildAuthUrl(config)).toBe('https://github.com/org/repo.git')
  })

  it('injects username and PAT into HTTPS URL', async () => {
    const config: GitConfig = {
      ...gitConfigDefaults,
      repoUrl: 'https://github.com/org/repo.git',
      branch: 'main',
      username: 'user',
      pat: 'ghp_token123',
    }
    const result = buildAuthUrl(config)
    expect(result).toContain('user:ghp_token123@')
    expect(result).toContain('github.com')
  })

  it('injects only username when PAT is absent', async () => {
    const config: GitConfig = {
      ...gitConfigDefaults,
      repoUrl: 'https://github.com/org/repo.git',
      branch: 'main',
      username: 'user',
    }
    const result = buildAuthUrl(config)
    expect(result).toContain('user@')
    expect(result).not.toContain(':@')
  })

  it('injects only PAT as password when username is absent', async () => {
    const config: GitConfig = {
      ...gitConfigDefaults,
      repoUrl: 'https://github.com/org/repo.git',
      branch: 'main',
      pat: 'ghp_token123',
    }
    const result = buildAuthUrl(config)
    expect(result).toContain(':ghp_token123@')
  })

  it('returns non-HTTPS URLs unchanged', async () => {
    const config: GitConfig = {
      ...gitConfigDefaults,
      repoUrl: 'git@github.com:org/repo.git',
      branch: 'main',
      username: 'user',
      pat: 'token',
    }
    expect(buildAuthUrl(config)).toBe('git@github.com:org/repo.git')
  })

  it('returns SSH URLs unchanged', async () => {
    const config: GitConfig = {
      ...gitConfigDefaults,
      repoUrl: 'ssh://git@github.com/org/repo.git',
      branch: 'main',
      username: 'user',
      pat: 'token',
    }
    // ssh:// is not https://, so returned as-is
    expect(buildAuthUrl(config)).toBe('ssh://git@github.com/org/repo.git')
  })

  it('handles special characters in PAT', async () => {
    const config: GitConfig = {
      ...gitConfigDefaults,
      repoUrl: 'https://gitlab.com/org/repo.git',
      branch: 'main',
      username: 'deploy',
      pat: 'glpat-abc123/def+456',
    }
    const result = buildAuthUrl(config)
    // URL constructor will percent-encode special characters
    expect(result).toContain('gitlab.com')
    expect(result).toContain('deploy')
  })

  it('handles URL with existing port', async () => {
    const config: GitConfig = {
      ...gitConfigDefaults,
      repoUrl: 'https://git.internal.com:8443/org/repo.git',
      branch: 'main',
      username: 'user',
      pat: 'token',
    }
    const result = buildAuthUrl(config)
    expect(result).toContain(':8443')
    expect(result).toContain('user:token@')
  })
})

describe('checkGitConnection — multi-repo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('falls back to single-repo when repos is empty', async () => {
    setupExecFile(() => ({
      stdout: 'abc123\trefs/heads/main\n',
      stderr: '',
    }))

    const config: GitConfig = {
      ...gitConfigDefaults,
      repoUrl: 'https://gitlab.com/org/main.git',
      branch: 'main',
      repos: [],
    }
    const result = await checkGitConnection(config)
    expect(result.ok).toBe(true)
    expect(result.message).toContain('branch "main" found')
  })

  /**
   * Probes run concurrently so the 30s-per-repo timeout is not additive, but the
   * fan-out must be bounded: `repos` comes straight from a probe request body, so
   * an unbounded `Promise.all` lets one request spawn one `git ls-remote` process
   * per entry — hundreds of subprocesses and outbound dials from a single
   * container. This test defers each callback so in-flight probes actually
   * overlap; with a synchronous mock a serial loop and an unbounded fan-out are
   * indistinguishable (which is why the earlier version of this suite could not
   * tell them apart).
   */
  it('bounds how many repo probes run at once', async () => {
    let inFlight = 0
    let peakInFlight = 0
    const pending: (() => void)[] = []
    mockExecFile.mockImplementation(((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: unknown, result: unknown) => void
      inFlight++
      peakInFlight = Math.max(peakInFlight, inFlight)
      pending.push(() => {
        inFlight--
        cb(null, { stdout: 'abc123\trefs/heads/main\n', stderr: '' })
      })
    }) as typeof execFile)

    const repoCount = 24
    const config: GitConfig = {
      ...gitConfigDefaults,
      repoUrl: '',
      branch: 'main',
      repos: Array.from({ length: repoCount }, (_, i) => ({
        repoUrl: `https://gitlab.com/org/r${i}.git`,
        branch: 'main',
        directory: `r${i}`,
      })),
    }

    let settled = 0
    // Deliberately NOT awaited yet: the probes only settle once this test drains
    // `pending` below, so awaiting here would deadlock.
    const resultPromise = checkGitConnection(config)
    // Drain in waves: settling a probe admits the next queued one, so keep
    // draining until every repo has been probed. Yield via a macrotask so the
    // awaiting workers resume and enqueue their successors before the next wave.
    while (settled < repoCount) {
      const wave = pending.splice(0, pending.length)
      for (const settle of wave) {
        settled++
        settle()
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    const result = await resultPromise
    expect(result.ok).toBe(true)
    expect(result.repos).toHaveLength(repoCount)
    // Asserted against a literal, not against GIT_PROBE_CONCURRENCY: comparing
    // the observed peak to the very constant under test would move the bar with
    // any regression (raise the cap to 999 and the assertion still "passes"),
    // pinning nothing. The literal is what makes the bound real.
    expect(peakInFlight).toBeLessThanOrEqual(8)
    expect(GIT_PROBE_CONCURRENCY).toBeLessThanOrEqual(8)
    // Guard the other direction too: a silent regression to a serial loop would
    // reintroduce the additive-timeout problem this concurrency exists to fix.
    expect(peakInFlight).toBeGreaterThan(1)
  })

  it('returns aggregated success when all repos connect', async () => {
    setupExecFile(() => ({
      stdout: 'abc123\trefs/heads/main\n',
      stderr: '',
    }))

    const config: GitConfig = {
      ...gitConfigDefaults,
      repoUrl: '',
      branch: 'main',
      username: 'user',
      pat: 'token',
      repos: [
        { repoUrl: 'https://gitlab.com/org/a.git', branch: 'main', directory: 'a' },
        { repoUrl: 'https://gitlab.com/org/b.git', branch: 'main', directory: 'b' },
        { repoUrl: 'https://gitlab.com/org/c.git', branch: 'main', directory: 'c' },
      ],
    }
    const result = await checkGitConnection(config)
    expect(result.ok).toBe(true)
    expect(result.message).toBe('3/3 repos connected')
  })

  it('returns failed directories when some repos fail', async () => {
    let callCount = 0
    setupExecFile(() => {
      callCount++
      if (callCount === 2) {
        throw new Error('Connection refused')
      }
      return { stdout: 'abc123\trefs/heads/main\n', stderr: '' }
    })

    const config: GitConfig = {
      ...gitConfigDefaults,
      repoUrl: '',
      branch: 'main',
      repos: [
        { repoUrl: 'https://gitlab.com/org/a.git', branch: 'main', directory: 'repo-a' },
        { repoUrl: 'https://gitlab.com/org/b.git', branch: 'main', directory: 'repo-b' },
        { repoUrl: 'https://gitlab.com/org/c.git', branch: 'main', directory: 'repo-c' },
      ],
    }
    const result = await checkGitConnection(config)
    expect(result.ok).toBe(false)
    expect(result.message).toBe('2/3 repos connected, failed: repo-b')
  })

  it('reports a per-repo breakdown so a failing repo names its own reason', async () => {
    let callCount = 0
    setupExecFile(() => {
      callCount++
      if (callCount === 2) {
        throw new Error('Authentication failed for https://user:secret@gitlab.com/org/b.git')
      }
      return { stdout: 'abc123\trefs/heads/main\n', stderr: '' }
    })

    const config: GitConfig = {
      ...gitConfigDefaults,
      repoUrl: '',
      branch: 'main',
      repos: [
        { repoUrl: 'https://gitlab.com/org/a.git', branch: 'main', directory: 'repo-a' },
        { repoUrl: 'https://gitlab.com/org/b.git', branch: 'main', directory: 'repo-b' },
      ],
    }
    const result = await checkGitConnection(config)

    expect(result.repos).toEqual([
      {
        directory: 'repo-a',
        repoUrl: 'https://gitlab.com/org/a.git',
        ok: true,
        message: expect.stringContaining('branch "main" found'),
      },
      {
        directory: 'repo-b',
        repoUrl: 'https://gitlab.com/org/b.git',
        ok: false,
        message: expect.stringContaining('Authentication failed'),
      },
    ])
  })

  it('never leaks an embedded credential through the per-repo breakdown', async () => {
    setupExecFile(() => {
      throw new Error('fatal: could not read from https://user:supersecret@gitlab.com/org/a.git')
    })

    const config: GitConfig = {
      ...gitConfigDefaults,
      repoUrl: '',
      branch: 'main',
      repos: [
        {
          repoUrl: 'https://user:supersecret@gitlab.com/org/a.git',
          branch: 'main',
          directory: 'repo-a',
        },
      ],
    }
    const result = await checkGitConnection(config)

    expect(JSON.stringify(result)).not.toContain('supersecret')
  })

  it('carries a repos[] breakdown for the single-repo shape too', async () => {
    setupExecFile(() => ({ stdout: 'abc123\trefs/heads/main\n', stderr: '' }))

    const config: GitConfig = {
      ...gitConfigDefaults,
      repoUrl: 'https://gitlab.com/org/solo.git',
      branch: 'main',
    }
    const result = await checkGitConnection(config)

    expect(result.ok).toBe(true)
    expect(result.repos).toEqual([
      {
        directory: '',
        repoUrl: 'https://gitlab.com/org/solo.git',
        ok: true,
        message: expect.stringContaining('branch "main" found'),
      },
    ])
  })
})

describe('executeGitSync — checkout root', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(false)
  })

  const singleRepo: GitConfig = {
    ...gitConfigDefaults,
    repoUrl: 'https://gitlab.com/org/main.git',
    branch: 'main',
  }

  it('creates the parent of the checkout root before cloning', async () => {
    setupExecFile(() => ({ stdout: '', stderr: 'Cloning...\n' }))

    const result = await executeGitSync(singleRepo, '/data/workspace/neptune')

    expect(result.ok).toBe(true)
    // The parent, not the leaf — git creates the leaf itself, and pre-creating
    // it would turn a fresh clone into a "directory already exists" failure.
    expect(mockMkdir).toHaveBeenCalledWith('/data/workspace', { recursive: true })
  })

  it('reports an unwritable checkout root as a storage problem, not a git one', async () => {
    // The volume is not mounted, so our own mkdir is what fails first.
    mockMkdir.mockRejectedValueOnce(
      Object.assign(new Error("EROFS: read-only file system, mkdir '/data/workspace'"), {
        code: 'EROFS',
      }),
    )

    const result = await executeGitSync(singleRepo, '/data/workspace/neptune')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('/data/workspace/neptune')
    expect(result.message).toContain('read-only')
    expect(result.message).toMatch(/volume is mounted/)
    // The raw git phrasing is what sent people to the wrong field.
    expect(result.message).not.toContain('could not create leading directories')
  })

  it("classifies git's own leading-directories failure the same way", async () => {
    // mkdir can succeed while the clone still cannot write one level down.
    setupExecFile((_cmd, args) => {
      if (args.includes('clone')) {
        throw Object.assign(new Error('Command failed: git clone'), {
          stderr: "fatal: could not create leading directories of '/data/workspace/neptune'",
          code: 128,
        })
      }
      return { stdout: '', stderr: '' }
    })

    const result = await executeGitSync(singleRepo, '/data/workspace/neptune')

    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/volume is mounted/)
  })

  it('does not blame storage when the git binary itself is missing', async () => {
    // `spawn git ENOENT` carries the same errno as a missing directory. Telling
    // the operator to check their volume mount would send them nowhere.
    setupExecFile((_cmd, args) => {
      if (args.includes('clone')) {
        throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
      }
      return { stdout: '', stderr: '' }
    })

    const result = await executeGitSync(singleRepo, '/data/workspace/neptune')

    expect(result.ok).toBe(false)
    expect(result.message).not.toMatch(/volume is mounted/)
  })

  it('does not blame storage for an SSH credential rejection', async () => {
    // "Permission denied (publickey)" is an auth failure whose text collides
    // with the filesystem wording.
    setupExecFile((_cmd, args) => {
      if (args.includes('clone')) {
        throw Object.assign(new Error('Command failed: git clone'), {
          stderr:
            'git@gitlab.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
          code: 128,
        })
      }
      return { stdout: '', stderr: '' }
    })

    const result = await executeGitSync(singleRepo, '/data/workspace/neptune')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('Permission denied')
    expect(result.message).not.toMatch(/volume is mounted/)
  })

  it('explains a checkout root whose parent is a regular file', async () => {
    mockMkdir.mockRejectedValueOnce(
      Object.assign(new Error("ENOTDIR: not a directory, mkdir '/data/workspace/neptune'"), {
        code: 'ENOTDIR',
      }),
    )

    const result = await executeGitSync(singleRepo, '/data/workspace/neptune')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('not a directory')
    expect(result.message).not.toMatch(/^Git sync failed: exit code/)
  })

  it('keeps the message for a filesystem errno it does not specifically phrase', async () => {
    // Without this, an fs error (errno set, no stderr) collapses to a bare
    // "exit code ENOSPC" and the path naming the problem is lost.
    mockMkdir.mockRejectedValueOnce(
      Object.assign(new Error("ENOSPC: no space left on device, mkdir '/data/workspace'"), {
        code: 'ENOSPC',
      }),
    )

    const result = await executeGitSync(singleRepo, '/data/workspace/neptune')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('no space left on device')
    expect(result.message).not.toMatch(/^Git sync failed: exit code ENOSPC$/)
  })

  it('leaves ordinary git failures untouched', async () => {
    setupExecFile((_cmd, args) => {
      if (args.includes('clone')) {
        throw Object.assign(new Error('Command failed: git clone'), {
          stderr: 'fatal: Authentication failed for https://gitlab.com/org/main.git',
          code: 128,
        })
      }
      return { stdout: '', stderr: '' }
    })

    const result = await executeGitSync(singleRepo, '/data/workspace/neptune')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('Authentication failed')
    expect(result.message).not.toMatch(/volume is mounted/)
  })
})

describe('executeGitSync — multi-repo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('falls back to single-repo when repos is empty', async () => {
    setupExecFile((_cmd, args) => {
      if (args.includes('clone')) {
        return { stdout: '', stderr: 'Cloning...\n' }
      }
      return { stdout: '', stderr: '' }
    })

    const config: GitConfig = {
      ...gitConfigDefaults,
      repoUrl: 'https://gitlab.com/org/main.git',
      branch: 'main',
      repos: [],
    }
    const result = await executeGitSync(config, '/tmp/work')
    expect(result.ok).toBe(true)
    expect(result.message).toContain('Cloned successfully')
  })

  it('syncs all repos into subdirectories and aggregates results', async () => {
    setupExecFile((_cmd, args) => {
      if (args.includes('clone')) {
        return { stdout: '', stderr: 'Cloning...\n' }
      }
      return { stdout: '', stderr: '' }
    })

    const config: GitConfig = {
      ...gitConfigDefaults,
      repoUrl: '',
      branch: 'main',
      username: 'user',
      pat: 'token',
      repos: [
        { repoUrl: 'https://gitlab.com/org/a.git', branch: 'main', directory: 'proj-a' },
        { repoUrl: 'https://gitlab.com/org/b.git', branch: 'dev', directory: 'proj-b' },
      ],
    }
    const result = await executeGitSync(config, '/tmp/workspace')

    expect(mockMkdir).toHaveBeenCalledWith('/tmp/workspace', { recursive: true })
    expect(result.ok).toBe(true)
    expect(result.message).toBe('2/2 repos synced, 0 files updated')
  })

  it('reports partial failure with failed directory names', async () => {
    let cloneCallCount = 0
    setupExecFile((_cmd, args) => {
      if (args.includes('clone')) {
        cloneCallCount++
        if (cloneCallCount === 2) {
          throw new Error('Repository not found')
        }
        return { stdout: '', stderr: 'Cloning...\n' }
      }
      return { stdout: '', stderr: '' }
    })

    const config: GitConfig = {
      ...gitConfigDefaults,
      repoUrl: '',
      branch: 'main',
      repos: [
        { repoUrl: 'https://gitlab.com/org/good.git', branch: 'main', directory: 'good' },
        { repoUrl: 'https://gitlab.com/org/bad.git', branch: 'main', directory: 'bad-repo' },
        { repoUrl: 'https://gitlab.com/org/ok.git', branch: 'main', directory: 'ok' },
      ],
    }
    const result = await executeGitSync(config, '/tmp/workspace')
    expect(result.ok).toBe(false)
    expect(result.message).toBe('2/3 repos synced, failed: bad-repo')
  })

  it('creates parent directory before cloning in multi-repo mode', async () => {
    setupExecFile(() => ({ stdout: '', stderr: '' }))

    const config: GitConfig = {
      ...gitConfigDefaults,
      repoUrl: '',
      branch: 'main',
      repos: [{ repoUrl: 'https://gitlab.com/org/x.git', branch: 'main', directory: 'x' }],
    }
    await executeGitSync(config, '/tmp/multi')

    expect(mockMkdir).toHaveBeenCalledWith('/tmp/multi', { recursive: true })
  })
})

describe('executeGitSync — fetch refspec & HEAD on configured branch after switch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fetches target branch with explicit refspec and moves HEAD onto the configured branch', async () => {
    mockExistsSync.mockImplementation((p) => String(p).endsWith('.git'))

    const execCalls: Array<{ cmd: string; args: string[] }> = []
    setupExecFile((cmd, args) => {
      execCalls.push({ cmd, args })
      if (args[0] === 'rev-parse') return { stdout: 'abcdef0\n', stderr: '' }
      if (args[0] === 'diff') {
        return { stdout: ' 1 file changed, 1 insertion(+)\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const branch = 'feature/new-branch-after-clone'
    const config: GitConfig = {
      ...gitConfigDefaults,
      repoUrl: 'https://gitlab.com/org/repo.git',
      branch,
      username: 'user',
      pat: 'token',
    }

    const result = await executeGitSync(config, '/tmp/single')
    expect(result.ok).toBe(true)

    const fetchCall = execCalls.find((c) => c.args[0] === 'fetch')
    expect(fetchCall).toBeDefined()
    expect(fetchCall!.args).toEqual([
      'fetch',
      'origin',
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ])

    // 关键断言：必须用 `checkout -f -B`，让 HEAD 指向配置的本地分支，
    // 而不是 `reset --hard`（后者只会动当前分支指针，HEAD 仍在旧分支上）。
    const checkoutCall = execCalls.find((c) => c.args[0] === 'checkout')
    expect(checkoutCall).toBeDefined()
    expect(checkoutCall!.args).toEqual(['checkout', '-f', '-B', branch, `origin/${branch}`])

    // 防倒退：确认整条链里没有 `reset --hard origin/*`。
    const strayReset = execCalls.find(
      (c) => c.args[0] === 'reset' && c.args.some((a) => a.startsWith('origin/')),
    )
    expect(strayReset).toBeUndefined()
  })
})

describe('executeGitSync — mode conflict detection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects multi-repo sync when localPath has .git from single-repo mode', async () => {
    mockExistsSync.mockImplementation((p) => {
      if (String(p).endsWith('.git')) return true
      return false
    })

    const config: GitConfig = {
      ...gitConfigDefaults,
      repoUrl: '',
      branch: 'main',
      repos: [{ repoUrl: 'https://gitlab.com/org/a.git', branch: 'main', directory: 'a' }],
    }
    const result = await executeGitSync(config, '/tmp/workspace')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Mode conflict')
    expect(result.message).toContain('.git directory from single-repo mode')
  })

  it('allows single-repo sync regardless of directory state', async () => {
    mockExistsSync.mockReturnValue(false)
    setupExecFile((_cmd, args) => {
      if (args.includes('clone')) return { stdout: '', stderr: 'Cloning...\n' }
      return { stdout: '', stderr: '' }
    })

    const config: GitConfig = {
      ...gitConfigDefaults,
      repoUrl: 'https://gitlab.com/org/main.git',
      branch: 'main',
    }
    const result = await executeGitSync(config, '/tmp/workspace')
    expect(result.ok).toBe(true)
  })
})

describe('executeGitSync — orphan directory warning', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('warns about orphan git directories not in repos config', async () => {
    mockExistsSync.mockImplementation((p) => {
      const s = String(p)
      if (s === '/tmp/workspace/.git') return false
      if (s === '/tmp/workspace/old-project/.git') return true
      if (s === '/tmp/workspace/active/.git') return true
      return false
    })

    setupExecFile((_cmd, args) => {
      if (args.includes('clone')) return { stdout: '', stderr: 'Cloning...\n' }
      return { stdout: '', stderr: '' }
    })

    mockReaddir.mockResolvedValue([
      { name: 'active', isDirectory: () => true },
      { name: 'old-project', isDirectory: () => true },
      { name: '.hidden', isDirectory: () => true },
      { name: 'somefile.txt', isDirectory: () => false },
    ] as unknown as Awaited<ReturnType<typeof readdir>>)

    const config: GitConfig = {
      ...gitConfigDefaults,
      repoUrl: '',
      branch: 'main',
      repos: [{ repoUrl: 'https://gitlab.com/org/a.git', branch: 'main', directory: 'active' }],
    }
    const result = await executeGitSync(config, '/tmp/workspace')
    expect(result.ok).toBe(true)
    expect(result.message).toContain('orphan directories found: old-project')
  })

  it('does not warn when no orphan directories exist', async () => {
    mockExistsSync.mockReturnValue(false)
    setupExecFile((_cmd, args) => {
      if (args.includes('clone')) return { stdout: '', stderr: 'Cloning...\n' }
      return { stdout: '', stderr: '' }
    })

    mockReaddir.mockResolvedValue([
      { name: 'proj-a', isDirectory: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>)

    const config: GitConfig = {
      ...gitConfigDefaults,
      repoUrl: '',
      branch: 'main',
      repos: [{ repoUrl: 'https://gitlab.com/org/a.git', branch: 'main', directory: 'proj-a' }],
    }
    const result = await executeGitSync(config, '/tmp/workspace')
    expect(result.ok).toBe(true)
    expect(result.message).not.toContain('orphan')
  })
})
