import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanupFeishuMessageResourceDownloadRoot } from '../feishu-service.js'

async function exists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false)
}

describe('cleanupFeishuMessageResourceDownloadRoot', () => {
  it('removes the run directory and an empty parent directory with the real filesystem', async () => {
    const base = await mkdtemp(join(tmpdir(), 'a2wave-feishu-cleanup-'))
    try {
      const parent = join(base, 'feishu-files')
      const runDir = join(parent, 'run_test')
      await mkdir(runDir, { recursive: true })
      await writeFile(join(runDir, 'readme.txt'), 'hello')

      await cleanupFeishuMessageResourceDownloadRoot(runDir)

      expect(await exists(runDir)).toBe(false)
      expect(await exists(parent)).toBe(false)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('keeps the parent directory when another run directory still exists', async () => {
    const base = await mkdtemp(join(tmpdir(), 'a2wave-feishu-cleanup-'))
    try {
      const parent = join(base, 'feishu-files')
      const runDir = join(parent, 'run_a')
      const siblingDir = join(parent, 'run_b')
      await mkdir(runDir, { recursive: true })
      await mkdir(siblingDir, { recursive: true })
      await writeFile(join(runDir, 'a.txt'), 'a')
      await writeFile(join(siblingDir, 'b.txt'), 'b')

      await cleanupFeishuMessageResourceDownloadRoot(runDir)

      expect(await exists(runDir)).toBe(false)
      expect(await exists(parent)).toBe(true)
      expect(await exists(siblingDir)).toBe(true)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})
