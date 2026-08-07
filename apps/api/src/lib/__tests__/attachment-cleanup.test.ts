import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const settingsHolder = { stagingPath: '', stagingTtlHours: 24 }

vi.mock('../settings.js', () => ({
  getAttachmentSettings: () => ({
    stagingPath: settingsHolder.stagingPath,
    stagingTtlHours: settingsHolder.stagingTtlHours,
    maxFileSizeBytes: 10 * 1024 * 1024,
    maxFilesPerRequest: 10,
    allowedExtensions: new Set(['png']),
  }),
}))

import { deleteExpiredStagedAttachments, stageAttachment } from '../attachment-storage.js'

beforeEach(() => {
  settingsHolder.stagingPath = mkdtempSync(join(tmpdir(), 'att-cleanup-'))
  settingsHolder.stagingTtlHours = 24
})

afterEach(() => vi.restoreAllMocks())

describe('attachment cleanup sweeper', () => {
  it('deleteExpiredStagedAttachments reads TTL and reaps aged dirs', async () => {
    const old = await stageAttachment(Buffer.from('o'), 'old.png', 'image/png')
    const fresh = await stageAttachment(Buffer.from('f'), 'fresh.png', 'image/png')

    const oldDir = join(settingsHolder.stagingPath, (await old).token)
    writeFileSync(
      join(oldDir, 'meta.json'),
      JSON.stringify({
        name: 'old.png',
        mimeType: 'image/png',
        size: 1,
        createdAt: new Date(Date.now() - 30 * 3600_000).toISOString(),
      }),
    )

    // The sweeper computes ttlMs from settings.stagingTtlHours; emulate its call.
    const ttlMs = settingsHolder.stagingTtlHours * 3600_000
    const removed = await deleteExpiredStagedAttachments(ttlMs)

    expect(removed).toBe(1)
    // fresh survives
    const { resolveStagedAttachment } = await import('../attachment-storage.js')
    expect(await resolveStagedAttachment((await fresh).token)).not.toBeNull()
    expect(await resolveStagedAttachment((await old).token)).toBeNull()
  })

  it('a shorter TTL reaps more aggressively', async () => {
    const { token } = await stageAttachment(Buffer.from('x'), 'a.png', 'image/png')
    const dir = join(settingsHolder.stagingPath, token)
    // Backdate createdAt by 2h; a 1h TTL should reap it.
    writeFileSync(
      join(dir, 'meta.json'),
      JSON.stringify({
        name: 'a.png',
        mimeType: 'image/png',
        size: 1,
        createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
      }),
    )
    expect(await deleteExpiredStagedAttachments(1 * 3600_000)).toBe(1)
  })
})
