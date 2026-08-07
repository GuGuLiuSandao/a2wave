/**
 * Regression: readline 的异步迭代器在消费方提前 break 时只 close 自身，
 * 不会释放底层 read stream 的 fd。读非末页（必然提前退出）的高频分页下
 * 会累积泄漏文件描述符 —— iterateNdjsonEntries 必须在 finally 里 destroy
 * 输入流。本文件包一层 node:fs 捕获所有 read stream 以断言 destroyed。
 */
import type { ReadStream } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const capturedReadStreams: ReadStream[] = []

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      const stream = actual.createReadStream(...args)
      capturedReadStreams.push(stream)
      return stream
    },
  }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { createRunLogFileWriter, readRunLogPage } from '../run-log-file.js'

let tmpRoot: string

beforeEach(() => {
  capturedReadStreams.length = 0
  tmpRoot = mkdtempSync(join(tmpdir(), 'a2wave-run-logs-fd-'))
  vi.stubEnv('A2WAVE_RUN_LOGS_DIR', tmpRoot)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('readRunLogPage — file descriptor hygiene', () => {
  it('destroys the underlying read stream when the range scan exits early', async () => {
    const writer = createRunLogFileWriter('run_fd')
    for (let i = 0; i < 2000; i++) {
      writer?.write({ type: 'assistant', text: `m${i}`, ts: i })
    }
    await writer?.close()

    // 第一次读建 totals 缓存（全量扫描，正常走到 EOF）
    await readRunLogPage('run_fd', { page: 'last', pageSize: 100 })
    // 命中缓存后读第 1 页 → readValidNdjsonRange 提前 break
    await readRunLogPage('run_fd', { page: 1, pageSize: 100 })

    expect(capturedReadStreams.length).toBeGreaterThanOrEqual(2)
    for (const stream of capturedReadStreams) {
      expect(stream.destroyed).toBe(true)
    }
  })
})
