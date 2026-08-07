import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// getAttachmentSettings is mocked so tests control the staging root + limits.
const stagingRootHolder = { path: '' }
vi.mock('../settings.js', () => ({
  getAttachmentSettings: () => ({
    stagingPath: stagingRootHolder.path,
    stagingTtlHours: 24,
    maxFileSizeBytes: 10 * 1024 * 1024,
    maxFilesPerRequest: 10,
    allowedExtensions: new Set(['png', 'pdf']),
  }),
}))

import {
  deleteExpiredStagedAttachments,
  deleteStagedAttachment,
  resolveStagedAttachment,
  safeDiskFileName,
  stageAttachment,
} from '../attachment-storage.js'

beforeEach(() => {
  stagingRootHolder.path = mkdtempSync(join(tmpdir(), 'att-store-'))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('safeDiskFileName', () => {
  it('strips traversal + illegal chars', async () => {
    expect(safeDiskFileName('../../etc/passwd')).toBe('passwd')
    expect(safeDiskFileName('a b/c.png')).toBe('c.png')
    expect(safeDiskFileName('...hidden')).toBe('hidden')
    expect(safeDiskFileName(undefined)).toBe('attachment')
    expect(safeDiskFileName('')).toBe('attachment')
  })

  it('truncates over-long names by bytes, keeping extension', async () => {
    const long = `${'a'.repeat(500)}.png`
    const out = safeDiskFileName(long)
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(200)
    expect(out.endsWith('.png')).toBe(true)
  })
})

describe('stage → resolve round trip', () => {
  it('stores bytes + meta and resolves them back', async () => {
    const { token, meta } = await stageAttachment(Buffer.from('hello'), 'pic.png', 'image/png')
    expect(token).toMatch(/^att_/)
    expect(meta).toMatchObject({ name: 'pic.png', mimeType: 'image/png', size: 5 })

    const resolved = await resolveStagedAttachment(token)
    expect(resolved).not.toBeNull()
    expect((await resolved)?.meta.name).toBe('pic.png')
    expect((await resolved)?.path.endsWith('pic.png')).toBe(true)
  })

  it('sanitizes stored filename', async () => {
    const { token } = await stageAttachment(Buffer.from('x'), '../evil name.pdf', 'application/pdf')
    const resolved = await resolveStagedAttachment(token)
    expect((await resolved)?.path.endsWith('evil_name.pdf')).toBe(true)
  })
})

describe('resolveStagedAttachment guards', () => {
  it('rejects path-traversal tokens', async () => {
    expect(await resolveStagedAttachment('../foo')).toBeNull()
    expect(await resolveStagedAttachment('a/b')).toBeNull()
    expect(await resolveStagedAttachment('')).toBeNull()
  })

  it('returns null for unknown token', async () => {
    expect(await resolveStagedAttachment('att_missing')).toBeNull()
  })
})

describe('deleteStagedAttachment', () => {
  it('removes the staged dir', async () => {
    const { token } = await stageAttachment(Buffer.from('x'), 'a.png', 'image/png')
    expect(await resolveStagedAttachment(token)).not.toBeNull()
    await deleteStagedAttachment(token)
    expect(await resolveStagedAttachment(token)).toBeNull()
  })

  it('is a no-op for bad tokens', async () => {
    expect(() => deleteStagedAttachment('../x')).not.toThrow()
  })
})

describe('deleteExpiredStagedAttachments', () => {
  it('reaps only dirs older than ttl', async () => {
    const fresh = await stageAttachment(Buffer.from('f'), 'fresh.png', 'image/png')
    const old = await stageAttachment(Buffer.from('o'), 'old.png', 'image/png')

    // Age the "old" one by rewriting its meta.json createdAt to 48h ago.
    const oldDir = join(stagingRootHolder.path, (await old).token)
    const twoDaysAgo = new Date(Date.now() - 48 * 3600_000).toISOString()
    writeFileSync(
      join(oldDir, 'meta.json'),
      JSON.stringify({ name: 'old.png', mimeType: 'image/png', size: 1, createdAt: twoDaysAgo }),
    )

    const removed = await deleteExpiredStagedAttachments(24 * 3600_000)
    expect(removed).toBe(1)
    expect(await resolveStagedAttachment((await fresh).token)).not.toBeNull()
    expect(await resolveStagedAttachment((await old).token)).toBeNull()
  })

  it('safety sentinel: dir with corrupt/missing meta.json is NOT deleted', async () => {
    const { token } = await stageAttachment(Buffer.from('x'), 'a.png', 'image/png')
    const dir = join(stagingRootHolder.path, token)
    writeFileSync(join(dir, 'meta.json'), '{bad json') // 损坏 meta
    const past = new Date(Date.now() - 72 * 3600_000)
    utimesSync(dir, past, past)

    // 没有合法 meta.json → 不认为是附件目录，保守跳过（防误删非附件数据）。
    expect(await deleteExpiredStagedAttachments(24 * 3600_000)).toBe(0)
    expect(readdirSync(stagingRootHolder.path)).toContain(token)
  })

  it('safety sentinel: non-att_ named entries are skipped', async () => {
    // 模拟 stagingPath 误配到含其它数据的目录：一个非 att_ 前缀的旧文件。
    const foreign = join(stagingRootHolder.path, 'db.sqlite')
    writeFileSync(foreign, 'important')
    const past = new Date(Date.now() - 72 * 3600_000)
    utimesSync(foreign, past, past)

    expect(await deleteExpiredStagedAttachments(24 * 3600_000)).toBe(0)
    expect(readdirSync(stagingRootHolder.path)).toContain('db.sqlite')
  })

  it('safety sentinel: other-prefix ID dir with meta.json is NOT deleted (strict att_)', async () => {
    // review 的确切场景：kbd_ 等其它前缀 ID 目录，哪怕含 meta.json，也绝不被误删。
    const kbdDir = join(stagingRootHolder.path, 'kbd_something')
    require('node:fs').mkdirSync(kbdDir, { recursive: true })
    writeFileSync(
      join(kbdDir, 'meta.json'),
      JSON.stringify({ createdAt: new Date(Date.now() - 72 * 3600_000).toISOString() }),
    )
    expect(await deleteExpiredStagedAttachments(24 * 3600_000)).toBe(0)
    expect(readdirSync(stagingRootHolder.path)).toContain('kbd_something')
  })

  it('pin: token referenced by an active run is not reaped', async () => {
    const old = await stageAttachment(Buffer.from('o'), 'old.png', 'image/png', 'usr_test')
    const oldDir = join(stagingRootHolder.path, (await old).token)
    writeFileSync(
      join(oldDir, 'meta.json'),
      JSON.stringify({
        name: 'old.png',
        mimeType: 'image/png',
        size: 1,
        createdAt: new Date(Date.now() - 72 * 3600_000).toISOString(),
      }),
    )
    // 被 pin → 不删。
    expect(
      await deleteExpiredStagedAttachments(24 * 3600_000, async (t) => t === (await old).token),
    ).toBe(0)
    expect(await resolveStagedAttachment((await old).token)).not.toBeNull()
    // 不 pin → 删。
    expect(await deleteExpiredStagedAttachments(24 * 3600_000)).toBe(1)
  })

  it('returns 0 when root does not exist', async () => {
    stagingRootHolder.path = join(tmpdir(), 'att-nonexistent-xyz')
    expect(await deleteExpiredStagedAttachments(1000)).toBe(0)
  })

  /**
   * The predicate is declared `boolean | Promise<boolean>`, and the real sweeper
   * passes an async one (it queries runs). An **un-awaited** Promise is always
   * truthy, so `if (isPinned?.(token))` treated every token as pinned: the
   * sweeper silently became a no-op, `removed` stayed 0 so even the log line
   * never fired, and the staging directory grew without bound.
   *
   * The pinned case above cannot catch that on its own — "expected 0, got 0"
   * passes either way. Only an async predicate returning **false** distinguishes
   * an awaited call from an un-awaited one, so that is what these pin down.
   */
  async function stageExpired(name: string): Promise<string> {
    const staged = await stageAttachment(Buffer.from('o'), name, 'image/png', 'usr_test')
    writeFileSync(
      join(stagingRootHolder.path, staged.token, 'meta.json'),
      JSON.stringify({
        name,
        mimeType: 'image/png',
        size: 1,
        createdAt: new Date(Date.now() - 72 * 3600_000).toISOString(),
      }),
    )
    return staged.token
  }

  it('pin: an ASYNC predicate resolving false still reaps the expired token', async () => {
    const token = await stageExpired('old.png')
    const isPinned = vi.fn(async () => false)

    // Un-awaited, the returned Promise is truthy and this returns 0.
    expect(await deleteExpiredStagedAttachments(24 * 3600_000, isPinned)).toBe(1)
    expect(isPinned).toHaveBeenCalledWith(token)
    expect(await resolveStagedAttachment(token)).toBeNull()
  })

  it('pin: an ASYNC predicate resolving true keeps the expired token', async () => {
    const token = await stageExpired('kept.png')

    expect(await deleteExpiredStagedAttachments(24 * 3600_000, async () => true)).toBe(0)
    expect(await resolveStagedAttachment(token)).not.toBeNull()
  })

  it('pin: an ASYNC predicate reaps only the tokens it does not pin', async () => {
    // Both expired; the predicate resolves true for one and false for the other.
    // An un-awaited call cannot tell them apart and would keep both.
    const pinned = await stageExpired('pinned.png')
    const loose = await stageExpired('loose.png')

    const removed = await deleteExpiredStagedAttachments(24 * 3600_000, async (t) => t === pinned)

    expect(removed).toBe(1)
    expect(await resolveStagedAttachment(pinned)).not.toBeNull()
    expect(await resolveStagedAttachment(loose)).toBeNull()
  })

  it('pin: a SYNC predicate returning false still reaps, so both signatures work', async () => {
    const token = await stageExpired('sync.png')

    // `await` on a non-Promise is a no-op, so the sync half of the union must
    // keep behaving identically.
    expect(await deleteExpiredStagedAttachments(24 * 3600_000, () => false)).toBe(1)
    expect(await resolveStagedAttachment(token)).toBeNull()
  })
})
