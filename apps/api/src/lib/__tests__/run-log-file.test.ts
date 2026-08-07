import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import {
  createRunLogFileWriter,
  deleteExpiredRunLogs,
  getRunLogFilePath,
  getRunLogsRoot,
  readRunLogPage,
  runLogFileExists,
} from '../run-log-file.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'a2wave-run-logs-'))
  vi.stubEnv('A2WAVE_RUN_LOGS_DIR', tmpRoot)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(tmpRoot, { recursive: true, force: true })
})

function readLines(runId: string): unknown[] {
  const path = getRunLogFilePath(runId)
  if (!path) throw new Error('invalid runId in test')
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

describe('getRunLogFilePath', () => {
  it('resolves under the configured root', async () => {
    expect(getRunLogFilePath('run_abc')).toBe(join(getRunLogsRoot(), 'run_abc.ndjson'))
  })

  it('rejects runIds with path traversal characters', async () => {
    expect(getRunLogFilePath('../etc/passwd')).toBeNull()
    expect(getRunLogFilePath('a/b')).toBeNull()
    expect(getRunLogFilePath('a\\b')).toBeNull()
    expect(getRunLogFilePath('')).toBeNull()
  })
})

describe('createRunLogFileWriter', () => {
  it('appends entries as NDJSON lines and closes cleanly', async () => {
    const writer = createRunLogFileWriter('run_w1')
    expect(writer).not.toBeNull()
    writer?.write({ type: 'assistant', text: 'hello', ts: 1 })
    writer?.write({ type: 'tool_call', subtype: 'started', callId: 'c1', toolName: 'Bash', ts: 2 })
    await writer?.close()

    const lines = readLines('run_w1')
    expect(lines).toEqual([
      { type: 'assistant', text: 'hello', ts: 1 },
      { type: 'tool_call', subtype: 'started', callId: 'c1', toolName: 'Bash', ts: 2 },
    ])
  })

  it('does not truncate beyond MAX_STREAM_LOGS — keeps every entry', async () => {
    const writer = createRunLogFileWriter('run_many')
    for (let i = 0; i < 1500; i++) {
      writer?.write({ type: 'assistant', text: `m${i}`, ts: i })
    }
    await writer?.close()
    expect(readLines('run_many')).toHaveLength(1500)
  })

  it('appends across two writer sessions for the same runId', async () => {
    const w1 = createRunLogFileWriter('run_app')
    w1?.write({ type: 'assistant', text: 'first', ts: 1 })
    await w1?.close()

    const w2 = createRunLogFileWriter('run_app')
    w2?.write({ type: 'assistant', text: 'second', ts: 2 })
    await w2?.close()

    expect(readLines('run_app').map((e) => (e as { text: string }).text)).toEqual([
      'first',
      'second',
    ])
  })

  it('stops writing after the size cap and appends a marker entry', async () => {
    vi.stubEnv('A2WAVE_RUN_LOG_MAX_BYTES', '120')
    const writer = createRunLogFileWriter('run_cap')
    for (let i = 0; i < 50; i++) {
      writer?.write({ type: 'assistant', text: `payload-${i}`, ts: i })
    }
    await writer?.close()

    const lines = readLines('run_cap') as Array<{ type: string; subtype?: string }>
    const last = lines[lines.length - 1]
    expect(last).toMatchObject({ type: 'system', subtype: 'log_file_size_capped' })
    // 远小于 50 条 —— cap 之后全部丢弃
    expect(lines.length).toBeLessThan(10)
  })

  it('returns null for an invalid runId', async () => {
    expect(createRunLogFileWriter('../oops')).toBeNull()
  })

  it('ignores writes after close', async () => {
    const writer = createRunLogFileWriter('run_closed')
    writer?.write({ type: 'assistant', text: 'kept', ts: 1 })
    await writer?.close()
    writer?.write({ type: 'assistant', text: 'dropped', ts: 2 })
    await writer?.close()
    expect(readLines('run_closed')).toHaveLength(1)
  })
})

describe('runLogFileExists', () => {
  it('reflects file presence', async () => {
    expect(runLogFileExists('run_e1')).toBe(false)
    const writer = createRunLogFileWriter('run_e1')
    writer?.write({ type: 'assistant', text: 'x', ts: 1 })
    await writer?.close()
    expect(runLogFileExists('run_e1')).toBe(true)
  })

  it('returns false for invalid runIds', async () => {
    expect(runLogFileExists('../etc')).toBe(false)
  })
})

describe('readRunLogPage', () => {
  async function writeMessages(runId: string, count: number, startAt = 0): Promise<void> {
    const writer = createRunLogFileWriter(runId)
    for (let i = startAt; i < startAt + count; i++) {
      writer?.write({ type: 'assistant', text: `m${i}`, ts: i })
    }
    await writer?.close()
  }

  function texts(entries: unknown[] | undefined): string[] {
    return (entries ?? []).map((e) => (e as { text: string }).text)
  }

  it('serves a partial last page correctly from the cold-cache single scan', async () => {
    await writeMessages('run_pg_last', 1250)

    const result = await readRunLogPage('run_pg_last', { page: 'last', pageSize: 500 })

    expect(result?.totalEntries).toBe(1250)
    expect(result?.totalPages).toBe(3)
    expect(result?.page).toBe(3)
    expect(result?.entries).toHaveLength(250)
    expect(texts(result?.entries)[0]).toBe('m1000')
    expect(texts(result?.entries)[249]).toBe('m1249')
  })

  it('clamps an out-of-range page to the last page with correct entries', async () => {
    await writeMessages('run_pg_clamp', 1250)

    const result = await readRunLogPage('run_pg_clamp', { page: 99, pageSize: 500 })

    expect(result?.page).toBe(3)
    expect(texts(result?.entries)[0]).toBe('m1000')
  })

  it('reads a middle page via the range scan', async () => {
    await writeMessages('run_pg_mid', 1250)

    const result = await readRunLogPage('run_pg_mid', { page: 2, pageSize: 500 })

    expect(result?.entries).toHaveLength(500)
    expect(texts(result?.entries)[0]).toBe('m500')
    expect(texts(result?.entries)[499]).toBe('m999')
  })

  it('invalidates cached totals when the file grows', async () => {
    await writeMessages('run_pg_grow', 10)
    const first = await readRunLogPage('run_pg_grow', { page: 'last', pageSize: 500 })
    expect(first?.totalEntries).toBe(10)

    await writeMessages('run_pg_grow', 5, 10)
    const second = await readRunLogPage('run_pg_grow', { page: 'last', pageSize: 500 })

    expect(second?.totalEntries).toBe(15)
    expect(texts(second?.entries)[14]).toBe('m14')
  })

  it('returns identical results on repeated (cached) reads', async () => {
    await writeMessages('run_pg_repeat', 750)
    const first = await readRunLogPage('run_pg_repeat', { page: 2, pageSize: 500 })
    const second = await readRunLogPage('run_pg_repeat', { page: 2, pageSize: 500 })

    expect(second).toEqual(first)
  })

  it('filters entries and keeps stats over the whole file', async () => {
    const writer = createRunLogFileWriter('run_pg_filter')
    for (let i = 0; i < 20; i++) {
      writer?.write({ type: 'assistant', text: `a${i}`, ts: i })
      writer?.write({
        type: 'tool_call',
        subtype: i % 5 === 0 ? 'failed' : 'completed',
        callId: `c${i}`,
        toolName: 'Bash',
        ts: i,
      })
    }
    await writer?.close()

    const result = await readRunLogPage('run_pg_filter', {
      page: 'last',
      pageSize: 500,
      filter: 'problems',
    })

    expect(result?.totalEntries).toBe(4) // 4 个 failed tool_call
    expect(result?.entries.every((e) => e.type === 'tool_call' && e.subtype === 'failed')).toBe(
      true,
    )
    expect(result?.stats.total).toBe(40) // stats 始终覆盖全量
  })

  it('returns null for a missing file or invalid runId', async () => {
    expect(await readRunLogPage('run_pg_missing', { page: 1, pageSize: 10 })).toBeNull()
    expect(await readRunLogPage('../etc', { page: 1, pageSize: 10 })).toBeNull()
  })

  it('keeps summary stats consistent with the corresponding filter counts', async () => {
    const writer = createRunLogFileWriter('run_pg_stats')
    writer?.write({ type: 'assistant', text: '', ts: 1 }) // 空文本 assistant 也算消息
    writer?.write({ type: 'assistant', text: 'hi', ts: 2 })
    writer?.write({ type: 'retry', attempt: 1, nextAttemptIn: 100, ts: 3 }) // retry 计入 errors
    writer?.write({ type: 'error', message: 'boom', ts: 4 })
    writer?.write({ type: 'tool_call', subtype: 'failed', callId: 'c', toolName: 'Bash', ts: 5 })
    await writer?.close()

    const messagesPage = await readRunLogPage('run_pg_stats', {
      page: 'last',
      pageSize: 50,
      filter: 'messages',
    })
    expect(messagesPage?.totalEntries).toBe(2)
    expect(messagesPage?.stats.messages).toBe(messagesPage?.totalEntries)

    const problemsPage = await readRunLogPage('run_pg_stats', {
      page: 'last',
      pageSize: 50,
      filter: 'problems',
    })
    expect(problemsPage?.totalEntries).toBe(3)
    expect(problemsPage?.stats.errors).toBe(problemsPage?.totalEntries)
  })
})

describe('deleteExpiredRunLogs', () => {
  it('removes files older than retention and keeps fresh ones', async () => {
    const wOld = createRunLogFileWriter('run_old')
    wOld?.write({ type: 'assistant', text: 'old', ts: 1 })
    await wOld?.close()
    const wNew = createRunLogFileWriter('run_new')
    wNew?.write({ type: 'assistant', text: 'new', ts: 1 })
    await wNew?.close()

    const oldPath = getRunLogFilePath('run_old')
    if (!oldPath) throw new Error('unexpected')
    const fifteenDaysAgo = (Date.now() - 15 * 24 * 60 * 60 * 1000) / 1000
    utimesSync(oldPath, fifteenDaysAgo, fifteenDaysAgo)
    expect(statSync(oldPath).mtimeMs).toBeLessThan(Date.now() - 14 * 24 * 60 * 60 * 1000)

    deleteExpiredRunLogs()

    expect(runLogFileExists('run_old')).toBe(false)
    expect(runLogFileExists('run_new')).toBe(true)
  })

  it('is a no-op when the root does not exist', async () => {
    rmSync(tmpRoot, { recursive: true, force: true })
    expect(existsSync(tmpRoot)).toBe(false)
    expect(() => deleteExpiredRunLogs()).not.toThrow()
  })
})
