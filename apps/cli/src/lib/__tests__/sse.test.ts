import { describe, expect, it } from 'vitest'
import { forEachSSELine } from '../sse.js'

/** A Response whose body emits `chunks` in order. */
function streamOf(chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c))
        controller.close()
      },
    }),
  )
}

async function collect(chunks: string[]): Promise<string[]> {
  const lines: string[] = []
  await forEachSSELine(streamOf(chunks), (l) => lines.push(l))
  return lines
}

describe('forEachSSELine', () => {
  it('splits complete lines', async () => {
    expect(await collect(['a\nb\nc\n'])).toEqual(['a', 'b', 'c'])
  })

  it('rejoins a line split across chunk boundaries', async () => {
    // The reason this buffering exists: a chunk can end mid-line.
    expect(await collect(['event: up', 'date\ndata: x\n'])).toEqual(['event: update', 'data: x'])
  })

  it('emits a final line with no trailing newline', async () => {
    expect(await collect(['a\nb'])).toEqual(['a', 'b'])
  })

  it('handles CRLF', async () => {
    expect(await collect(['a\r\nb\r\n'])).toEqual(['a', 'b'])
  })

  it('keeps blank lines out of the tail flush but not the body', async () => {
    // SSE separates events with a blank line, so those must reach the handler;
    // a purely whitespace tail is padding and is dropped.
    expect(await collect(['a\n\nb\n   '])).toEqual(['a', '', 'b'])
  })

  it('rejoins a multi-byte character split across chunks', async () => {
    const bytes = new TextEncoder().encode('数据\n')
    const res = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 2)) // mid-character split
          controller.enqueue(bytes.slice(2))
          controller.close()
        },
      }),
    )
    const lines: string[] = []
    await forEachSSELine(res, (l) => lines.push(l))
    expect(lines).toEqual(['数据'])
  })

  it('throws on an empty body', async () => {
    await expect(forEachSSELine(new Response(null), () => {})).rejects.toThrow(/body is empty/)
  })
})
