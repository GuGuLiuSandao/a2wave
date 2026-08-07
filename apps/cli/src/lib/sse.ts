import { CliError } from '../errors.js'

/**
 * Read an SSE response line by line.
 *
 * The transport half of consuming a stream — reading chunks, decoding them, and
 * splitting on line boundaries that a chunk may land in the middle of. The
 * INTERPRETATION half stays with each caller, because `runs` and `chat` handle
 * the same event names differently on purpose: a failed run aborts the command,
 * while a failed chat turn is reported and the session stays open.
 *
 * Extracted because both callers had reimplemented the same buffering, and a
 * bug in it (a chunk boundary mid-line, or a final line with no trailing
 * newline) would have had to be found and fixed twice.
 */
export async function forEachSSELine(
  response: Response,
  onLine: (line: string) => void,
): Promise<void> {
  const body = response.body
  if (!body) throw new CliError('Response body is empty')

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    // `stream: true` keeps a multi-byte character split across chunks intact.
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    // The last element is a partial line unless the chunk ended on a break;
    // hold it back until more bytes arrive.
    buffer = lines.pop() ?? ''
    for (const line of lines) onLine(line)
  }

  // A stream that ends without a trailing newline leaves its final line here.
  if (buffer.trim()) onLine(buffer)
}
