import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks ──────────────────────────────────────────────────────────────────

const { mockDbInsert, mockDbSelect, mockDbDelete } = vi.hoisted(() => {
  const mockDbInsert = vi.fn()
  const mockDbSelect = vi.fn()
  const mockDbDelete = vi.fn()
  return { mockDbInsert, mockDbSelect, mockDbDelete }
})

vi.mock('../../db/client.js', () => ({
  db: {
    insert: mockDbInsert,
    select: mockDbSelect,
    delete: mockDbDelete,
  },
}))

vi.mock('../../db/schema.js', () => ({
  artifacts: { id: 'id', runId: 'run_id', expiresAt: 'expires_at' },
  artifactShares: {
    id: 'id',
    artifactId: 'artifact_id',
    revokedAt: 'revoked_at',
    expiresAt: 'expires_at',
  },
}))

// 分享服务在 deleteExpiredArtifacts 中被调用，独立单测见 artifact-share.test.ts
vi.mock('../artifact-share.js', () => ({
  deleteStaleShares: vi.fn(),
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../id.js', () => ({
  createId: vi.fn().mockReturnValue('art_test123'),
}))

let mockStoragePath = ''
let mockRetentionHours = '24'

vi.mock('../settings.js', () => ({
  getSetting: vi.fn((category: string, key: string) => {
    if (category === 'artifacts' && key === 'storagePath') return mockStoragePath
    if (category === 'artifacts' && key === 'retentionHours') return mockRetentionHours
    return undefined
  }),
}))

// drizzle-orm mocks
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val, op: 'eq' })),
  lt: vi.fn((col: unknown, val: unknown) => ({ col, val, op: 'lt' })),
  gt: vi.fn((col: unknown, val: unknown) => ({ col, val, op: 'gt' })),
  and: vi.fn((...args: unknown[]) => ({ args, op: 'and' })),
  isNull: vi.fn((col: unknown) => ({ col, op: 'isNull' })),
  notExists: vi.fn((sub: unknown) => ({ sub, op: 'notExists' })),
}))

// ── Import after mocks ─────────────────────────────────────────────────────

import {
  deleteExpiredArtifacts,
  getArtifactDir,
  getArtifactRetentionMs,
  getArtifactsStorageRoot,
  scanAndRegisterArtifacts,
} from '../artifact-storage.js'

import { asyncQuery } from '../../test/async-query.js'
import { deleteStaleShares } from '../artifact-share.js'

// ── Test fixtures ──────────────────────────────────────────────────────────

let testRoot: string

beforeEach(() => {
  testRoot = join(tmpdir(), `artifact-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(testRoot, { recursive: true })
  mockStoragePath = testRoot
  mockRetentionHours = '24'
  vi.clearAllMocks()
  mockDbInsert.mockReturnValue(
    asyncQuery({ values: vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() })) }),
  )
  mockDbDelete.mockReturnValue(
    asyncQuery({ where: vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() })) }),
  )
})

afterEach(() => {
  if (existsSync(testRoot)) {
    rmSync(testRoot, { recursive: true })
  }
})

// ── Tests ──────────────────────────────────────────────────────────────────

describe('getArtifactsStorageRoot', () => {
  it('returns absolute path based on storagePath setting', async () => {
    const root = await getArtifactsStorageRoot()
    expect(root).toBe(resolve(process.cwd(), testRoot))
  })

  it('falls back to ./data/artifacts when setting is empty', async () => {
    mockStoragePath = ''
    const root = await getArtifactsStorageRoot()
    // resolve('') gives cwd, so combined: resolve(cwd, './data/artifacts')
    expect(root).toBe(resolve(process.cwd(), './data/artifacts'))
  })
})

describe('getArtifactRetentionMs', () => {
  it('converts 24 hours to milliseconds', async () => {
    mockRetentionHours = '24'
    expect(getArtifactRetentionMs()).toBe(24 * 60 * 60 * 1000)
  })

  it('converts 1 hour to milliseconds', async () => {
    mockRetentionHours = '1'
    expect(getArtifactRetentionMs()).toBe(60 * 60 * 1000)
  })

  it('returns 0 when retentionHours is 0', async () => {
    mockRetentionHours = '0'
    expect(getArtifactRetentionMs()).toBe(0)
  })

  it('handles decimal hours', async () => {
    mockRetentionHours = '0.5'
    expect(getArtifactRetentionMs()).toBe(0.5 * 60 * 60 * 1000)
  })
})

describe('getArtifactDir', () => {
  it('constructs path as root/agentId/userHash/runId', async () => {
    const agentId = 'agt_abc'
    const userId = 'usr_xyz'
    const runId = 'run_123'

    const dir = await getArtifactDir(agentId, userId, runId)

    const expectedHash = createHash('sha256').update(userId).digest('hex').slice(0, 12)
    const storageRoot = resolve(process.cwd(), testRoot)
    expect(dir).toBe(join(storageRoot, agentId, expectedHash, runId))
  })

  it('produces same hash for same userId (consistent)', async () => {
    const userId = 'usr_consistent'
    const dir1 = await getArtifactDir('agt_1', userId, 'run_1')
    const dir2 = await getArtifactDir('agt_1', userId, 'run_2')

    // Both dirs share the same userHash segment
    const parts1 = (await dir1).split('/')
    const parts2 = (await dir2).split('/')
    const hashIdx1 = parts1.indexOf('agt_1') + 1
    const hashIdx2 = parts2.indexOf('agt_1') + 1
    expect(parts1[hashIdx1]).toBe(parts2[hashIdx2])
    expect(parts1[hashIdx1]).toHaveLength(12)
  })

  it('produces different hash for different userId', async () => {
    const dir1 = await getArtifactDir('agt_1', 'usr_alice', 'run_1')
    const dir2 = await getArtifactDir('agt_1', 'usr_bob', 'run_1')
    expect(dir1).not.toBe(dir2)
  })
})

describe('scanAndRegisterArtifacts', () => {
  it('does nothing when workDir/artifacts does not exist', async () => {
    const workDir = join(testRoot, 'no_artifacts_workdir')
    mkdirSync(workDir, { recursive: true })
    // No artifacts/ subdir

    const result = await scanAndRegisterArtifacts('run_1', 'agt_1', 'usr_1', workDir)
    expect(mockDbInsert).not.toHaveBeenCalled()
    expect(result).toEqual([])
  })

  it('does nothing when artifacts dir is empty', async () => {
    const workDir = join(testRoot, 'empty_workdir')
    mkdirSync(join(workDir, 'artifacts'), { recursive: true })

    const result = await scanAndRegisterArtifacts('run_1', 'agt_1', 'usr_1', workDir)
    expect(mockDbInsert).not.toHaveBeenCalled()
    expect(result).toEqual([])
  })

  it('copies files and inserts DB records for each artifact', async () => {
    const workDir = join(testRoot, 'workdir1')
    const artifactsDir = join(workDir, 'artifacts')
    mkdirSync(artifactsDir, { recursive: true })
    writeFileSync(join(artifactsDir, 'report.md'), '# Report\nHello')
    writeFileSync(join(artifactsDir, 'data.json'), '{"key":"value"}')

    const mockValues = vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() }))
    mockDbInsert.mockReturnValue(asyncQuery({ values: mockValues }))

    const result = await scanAndRegisterArtifacts('run_1', 'agt_1', 'usr_1', workDir)

    expect(mockDbInsert).toHaveBeenCalledTimes(2)

    const calls = mockValues.mock.calls
    const filenames = calls.map((c: unknown[]) => (c[0] as { filename: string }).filename).sort()
    expect(filenames).toEqual(['data.json', 'report.md'])

    expect(result).toHaveLength(2)
    const returnedFilenames = result.map((r) => r.filename).sort()
    expect(returnedFilenames).toEqual(['data.json', 'report.md'])
    expect(result.every((r) => r.id === 'art_test123')).toBe(true)
    expect(result.every((r) => typeof r.storagePath === 'string' && r.storagePath.length > 0)).toBe(
      true,
    )
  })

  it('copies file content to storage dir correctly', async () => {
    const workDir = join(testRoot, 'workdir_copy')
    const artifactsDir = join(workDir, 'artifacts')
    mkdirSync(artifactsDir, { recursive: true })
    writeFileSync(join(artifactsDir, 'output.txt'), 'artifact content')

    const mockValues = vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() }))
    mockDbInsert.mockReturnValue(asyncQuery({ values: mockValues }))

    await scanAndRegisterArtifacts('run_copy', 'agt_1', 'usr_1', workDir)

    // The stored file should have the same content
    const storedPath = (mockValues.mock.calls[0][0] as { storagePath: string }).storagePath
    expect(existsSync(storedPath)).toBe(true)
    expect(readFileSync(storedPath, 'utf-8')).toBe('artifact content')
  })

  it('sets correct MIME type for known extensions', async () => {
    const workDir = join(testRoot, 'workdir_mime')
    const artifactsDir = join(workDir, 'artifacts')
    mkdirSync(artifactsDir, { recursive: true })
    writeFileSync(join(artifactsDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    writeFileSync(join(artifactsDir, 'doc.json'), '{}')

    const mockValues = vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() }))
    mockDbInsert.mockReturnValue(asyncQuery({ values: mockValues }))

    await scanAndRegisterArtifacts('run_mime', 'agt_1', 'usr_1', workDir)

    const records = mockValues.mock.calls.map(
      (c: unknown[]) => c[0] as { filename: string; mimeType: string },
    )
    const png = records.find((r) => r.filename === 'image.png')
    const json = records.find((r) => r.filename === 'doc.json')
    expect(png?.mimeType).toBe('image/png')
    expect(json?.mimeType).toBe('application/json')
  })

  it('sets expiresAt based on retentionHours', async () => {
    mockRetentionHours = '24'
    const workDir = join(testRoot, 'workdir_expiry')
    const artifactsDir = join(workDir, 'artifacts')
    mkdirSync(artifactsDir, { recursive: true })
    writeFileSync(join(artifactsDir, 'file.txt'), 'data')

    const mockValues = vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() }))
    mockDbInsert.mockReturnValue(asyncQuery({ values: mockValues }))

    const before = Date.now()
    await scanAndRegisterArtifacts('run_exp', 'agt_1', 'usr_1', workDir)
    const after = Date.now()

    const record = mockValues.mock.calls[0][0] as { expiresAt: Date }
    const expiresMs = record.expiresAt.getTime()
    expect(expiresMs).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000)
    expect(expiresMs).toBeLessThanOrEqual(after + 24 * 60 * 60 * 1000)
  })

  it('sets null expiresAt when retentionHours is 0', async () => {
    mockRetentionHours = '0'
    const workDir = join(testRoot, 'workdir_noexpiry')
    const artifactsDir = join(workDir, 'artifacts')
    mkdirSync(artifactsDir, { recursive: true })
    writeFileSync(join(artifactsDir, 'file.txt'), 'data')

    const mockValues = vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() }))
    mockDbInsert.mockReturnValue(asyncQuery({ values: mockValues }))

    await scanAndRegisterArtifacts('run_0h', 'agt_1', 'usr_1', workDir)

    const record = mockValues.mock.calls[0][0] as { expiresAt: unknown }
    expect(record.expiresAt).toBeUndefined()
  })

  it('skips empty subdirectories inside artifacts dir', async () => {
    const workDir = join(testRoot, 'workdir_subdir')
    const artifactsDir = join(workDir, 'artifacts')
    mkdirSync(join(artifactsDir, 'subdir'), { recursive: true })
    writeFileSync(join(artifactsDir, 'file.txt'), 'ok')

    const mockValues = vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() }))
    mockDbInsert.mockReturnValue(asyncQuery({ values: mockValues }))

    await scanAndRegisterArtifacts('run_sub', 'agt_1', 'usr_1', workDir)

    // Only the file should be registered, not the empty subdir
    expect(mockDbInsert).toHaveBeenCalledTimes(1)
    const record = mockValues.mock.calls[0][0] as { filename: string }
    expect(record.filename).toBe('file.txt')
  })

  it('registers a non-empty subdirectory as a directory artifact with recursive size', async () => {
    const workDir = join(testRoot, 'workdir_dir_artifact')
    const artifactsDir = join(workDir, 'artifacts')
    const siteDir = join(artifactsDir, 'site')
    mkdirSync(join(siteDir, 'assets'), { recursive: true })
    writeFileSync(join(siteDir, 'index.html'), '<html>hi</html>')
    writeFileSync(join(siteDir, 'assets', 'app.css'), 'body{}')

    const mockValues = vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() }))
    mockDbInsert.mockReturnValue(asyncQuery({ values: mockValues }))

    const result = await scanAndRegisterArtifacts('run_dir', 'agt_1', 'usr_1', workDir)

    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('directory')
    expect(result[0].filename).toBe('site')
    const record = mockValues.mock.calls[0][0] as {
      kind: string
      mimeType: string | null
      size: number
    }
    expect(record.kind).toBe('directory')
    expect(record.mimeType).toBeNull()
    expect(record.size).toBe(Buffer.byteLength('<html>hi</html>') + Buffer.byteLength('body{}'))
    // 嵌套文件被复制到隔离存储
    expect(existsSync(join(result[0].storagePath, 'index.html'))).toBe(true)
    expect(existsSync(join(result[0].storagePath, 'assets', 'app.css'))).toBe(true)
  })

  it('skips symlinks nested inside a directory artifact', async () => {
    const workDir = join(testRoot, 'workdir_dir_symlink')
    const artifactsDir = join(workDir, 'artifacts')
    const pkgDir = join(artifactsDir, 'pkg')
    mkdirSync(pkgDir, { recursive: true })
    const sensitiveFile = join(testRoot, 'nested-sensitive.txt')
    writeFileSync(sensitiveFile, 'secret data')
    symlinkSync(sensitiveFile, join(pkgDir, 'leak.txt'))
    writeFileSync(join(pkgDir, 'real.txt'), 'real')

    const mockValues = vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() }))
    mockDbInsert.mockReturnValue(asyncQuery({ values: mockValues }))

    const result = await scanAndRegisterArtifacts('run_dir_sym', 'agt_1', 'usr_1', workDir)

    expect(result).toHaveLength(1)
    expect(existsSync(join(result[0].storagePath, 'real.txt'))).toBe(true)
    expect(existsSync(join(result[0].storagePath, 'leak.txt'))).toBe(false)
  })

  it('skips stale directory artifacts that predate the current run start time', async () => {
    const workDir = join(testRoot, 'workdir_dir_stale')
    const artifactsDir = join(workDir, 'artifacts')
    const oldDir = join(artifactsDir, 'old-report')
    mkdirSync(oldDir, { recursive: true })
    writeFileSync(join(oldDir, 'old.txt'), 'stale')

    const mockValues = vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() }))
    mockDbInsert.mockReturnValue(asyncQuery({ values: mockValues }))

    // registeredAfterMs 在未来：目录内所有文件都视为陈旧
    const result = await scanAndRegisterArtifacts('run_dir_stale', 'agt_1', 'usr_1', workDir, {
      registeredAfterMs: Date.now() + 60_000,
    })

    expect(result).toHaveLength(0)
    expect(mockDbInsert).not.toHaveBeenCalled()
  })

  it('skips symlinks in artifacts dir', async () => {
    const workDir = join(testRoot, 'workdir_symlink')
    const artifactsDir = join(workDir, 'artifacts')
    mkdirSync(artifactsDir, { recursive: true })
    // Create a real file outside artifacts dir (simulating sensitive file)
    const sensitiveFile = join(testRoot, 'sensitive.txt')
    writeFileSync(sensitiveFile, 'secret data')
    // Create a symlink pointing to the sensitive file
    symlinkSync(sensitiveFile, join(artifactsDir, 'symlink.txt'))
    // Also create a legit file
    writeFileSync(join(artifactsDir, 'legit.txt'), 'legit content')

    const mockValues = vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() }))
    mockDbInsert.mockReturnValue(asyncQuery({ values: mockValues }))

    const result = await scanAndRegisterArtifacts('run_sym', 'agt_1', 'usr_1', workDir)

    // Only the legit file should be registered
    expect(mockDbInsert).toHaveBeenCalledTimes(1)
    const record = mockValues.mock.calls[0][0] as { filename: string }
    expect(record.filename).toBe('legit.txt')
    expect(result.map((r) => r.filename)).not.toContain('symlink.txt')
  })

  it('records correct size for each file', async () => {
    const workDir = join(testRoot, 'workdir_size')
    const artifactsDir = join(workDir, 'artifacts')
    mkdirSync(artifactsDir, { recursive: true })
    const content = 'hello world'
    writeFileSync(join(artifactsDir, 'sized.txt'), content)

    const mockValues = vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() }))
    mockDbInsert.mockReturnValue(asyncQuery({ values: mockValues }))

    await scanAndRegisterArtifacts('run_size', 'agt_1', 'usr_1', workDir)

    const record = mockValues.mock.calls[0][0] as { size: number }
    expect(record.size).toBe(Buffer.byteLength(content))
  })

  it('skips stale artifacts that predate the current run start time', async () => {
    const workDir = join(testRoot, 'workdir_since')
    const artifactsDir = join(workDir, 'artifacts')
    mkdirSync(artifactsDir, { recursive: true })

    const oldFile = join(artifactsDir, 'old-report.md')
    writeFileSync(oldFile, 'stale artifact')
    const runStartedAt = Date.now()
    utimesSync(oldFile, new Date(runStartedAt - 10_000), new Date(runStartedAt - 10_000))

    const newFile = join(artifactsDir, 'new-report.md')
    writeFileSync(newFile, 'fresh artifact')
    // Pin the fresh file's mtime the same way the stale one is pinned, instead
    // of trusting the write to land at or after `runStartedAt`. Filesystem
    // timestamp granularity is coarser than Date.now() on some Linux setups, so
    // the mtime could round *below* runStartedAt and the file the test calls
    // "fresh" would be filtered as stale — green on macOS, red on the CI runner.
    utimesSync(newFile, new Date(runStartedAt + 1_000), new Date(runStartedAt + 1_000))

    const mockValues = vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() }))
    mockDbInsert.mockReturnValue(asyncQuery({ values: mockValues }))

    const result = await scanAndRegisterArtifacts('run_since', 'agt_1', 'usr_1', workDir, {
      registeredAfterMs: runStartedAt,
    })

    expect(mockDbInsert).toHaveBeenCalledTimes(1)
    const record = mockValues.mock.calls[0][0] as { filename: string }
    expect(record.filename).toBe('new-report.md')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 'art_test123', filename: 'new-report.md' })
    expect(result[0].storagePath).toBeTruthy()
  })
})

describe('deleteExpiredArtifacts', () => {
  it('does nothing when no expired artifacts', async () => {
    mockDbSelect.mockReturnValue(
      asyncQuery({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(asyncQuery({ all: vi.fn().mockReturnValue([]) })),
        }),
      }),
    )

    await deleteExpiredArtifacts()
    expect(mockDbDelete).not.toHaveBeenCalled()
  })

  it('deletes file from disk and DB for each expired artifact', async () => {
    const artifactFile = join(testRoot, 'expired_file.txt')
    writeFileSync(artifactFile, 'old data')
    expect(existsSync(artifactFile)).toBe(true)

    const mockWhere = vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() }))
    mockDbDelete.mockReturnValue(asyncQuery({ where: mockWhere }))
    mockDbSelect.mockReturnValue(
      asyncQuery({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(
            asyncQuery({
              all: vi.fn().mockReturnValue([{ id: 'art_expired1', storagePath: artifactFile }]),
            }),
          ),
        }),
      }),
    )

    await deleteExpiredArtifacts()

    // File should be removed from disk
    expect(existsSync(artifactFile)).toBe(false)
    // DB delete should be called
    expect(mockDbDelete).toHaveBeenCalledTimes(1)
    expect(mockWhere).toHaveBeenCalledTimes(1)
  })

  it('handles multiple expired artifacts', async () => {
    const file1 = join(testRoot, 'exp1.txt')
    const file2 = join(testRoot, 'exp2.txt')
    writeFileSync(file1, 'a')
    writeFileSync(file2, 'b')

    const mockWhere = vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() }))
    mockDbDelete.mockReturnValue(asyncQuery({ where: mockWhere }))
    mockDbSelect.mockReturnValue(
      asyncQuery({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(
            asyncQuery({
              all: vi.fn().mockReturnValue([
                { id: 'art_1', storagePath: file1 },
                { id: 'art_2', storagePath: file2 },
              ]),
            }),
          ),
        }),
      }),
    )

    await deleteExpiredArtifacts()

    expect(existsSync(file1)).toBe(false)
    expect(existsSync(file2)).toBe(false)
    expect(mockDbDelete).toHaveBeenCalledTimes(2)
  })

  // Regression: deleteStaleShares became async during the PostgreSQL migration
  // but the call site kept firing it without await. The notExists(...) exemption
  // in the expired-artifact query reads artifact_shares, so it still saw the
  // stale rows and every expired artifact stayed exempt from collection.
  it('finishes collapsing stale shares before querying expired artifacts', async () => {
    let selectCallsWhenSweepFinished: number | undefined
    vi.mocked(deleteStaleShares).mockImplementationOnce(async () => {
      // Yield so an unawaited caller would have raced ahead to the select.
      await new Promise((resolve) => setTimeout(resolve, 0))
      selectCallsWhenSweepFinished = mockDbSelect.mock.calls.length
    })
    mockDbSelect.mockReturnValue(
      asyncQuery({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(asyncQuery({ all: vi.fn().mockReturnValue([]) })),
        }),
      }),
    )

    await deleteExpiredArtifacts()

    // The exemption subquery must not have run against un-collapsed share rows.
    expect(selectCallsWhenSweepFinished).toBe(0)
    expect(mockDbSelect).toHaveBeenCalled()
  })

  it('continues cleanup even when a file is missing from disk', async () => {
    const missingPath = join(testRoot, 'nonexistent_file.txt')
    // Do NOT create the file

    const mockWhere = vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() }))
    mockDbDelete.mockReturnValue(asyncQuery({ where: mockWhere }))
    mockDbSelect.mockReturnValue(
      asyncQuery({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(
            asyncQuery({
              all: vi.fn().mockReturnValue([{ id: 'art_missing', storagePath: missingPath }]),
            }),
          ),
        }),
      }),
    )

    // Should not reject even though file doesn't exist
    await expect(deleteExpiredArtifacts()).resolves.not.toThrow()
    expect(mockDbDelete).toHaveBeenCalledTimes(1)
  })
})
