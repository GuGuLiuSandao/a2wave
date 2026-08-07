import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readSecret } from '../prompt.js'

/**
 * Fake TTY stdin: readSecret drives raw mode and consumes 'data' events, so the
 * test needs to emit chunks and observe the raw-mode transitions.
 */
class FakeStdin extends EventEmitter {
  isTTY = true
  isRaw = false
  setRawMode = vi.fn((raw: boolean) => {
    this.isRaw = raw
    return this as unknown as NodeJS.ReadStream
  })
  resume = vi.fn(() => this as unknown as NodeJS.ReadStream)
  pause = vi.fn(() => this as unknown as NodeJS.ReadStream)
  setEncoding = vi.fn(() => this as unknown as NodeJS.ReadStream)
}

let fake: FakeStdin
let written: string[]
const realStdin = process.stdin
const realWrite = process.stdout.write

beforeEach(() => {
  fake = new FakeStdin()
  written = []
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true })
  process.stdout.write = ((s: string) => {
    written.push(String(s))
    return true
  }) as typeof process.stdout.write
})

afterEach(() => {
  Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true })
  process.stdout.write = realWrite
  vi.restoreAllMocks()
})

describe('readSecret', () => {
  it('rejects without a TTY instead of echoing the secret in the clear', async () => {
    fake.isTTY = false
    await expect(readSecret('Password: ')).rejects.toThrow(/not a terminal/i)
    // The prompt must not even be printed on the non-TTY path
    expect(written.join('')).toBe('')
  })

  it('never echoes the typed characters', async () => {
    const p = readSecret('Password: ')
    fake.emit('data', 'hunter2\r')
    await expect(p).resolves.toBe('hunter2')
    expect(written.join('')).toBe('Password: \n')
  })

  it('treats a multi-character chunk as individual keystrokes (paste)', async () => {
    // One 'data' event carrying the whole line + newline: matching the chunk as
    // a unit would fold "\r" into the secret.
    const p = readSecret('Password: ')
    fake.emit('data', 'Str0ngPass\r')
    await expect(p).resolves.toBe('Str0ngPass')
  })

  it('stops at the first newline inside a chunk, ignoring trailing bytes', async () => {
    const p = readSecret('Password: ')
    fake.emit('data', 'first\rsecond\r')
    await expect(p).resolves.toBe('first')
  })

  it('handles DEL and backspace as erase', async () => {
    const p = readSecret('Password: ')
    fake.emit('data', 'abc\x7f')
    fake.emit('data', 'd\b')
    fake.emit('data', 'Z\r')
    await expect(p).resolves.toBe('abZ')
  })

  it('does not underflow when erasing an empty secret', async () => {
    const p = readSecret('Password: ')
    fake.emit('data', '\x7f\x7f\x7fok1\r')
    await expect(p).resolves.toBe('ok1')
  })

  it('consumes an arrow-key CSI sequence whole, not just the ESC byte', async () => {
    // Down arrow: ESC '[' 'B'. Dropping only the ESC would leave '[B' to fall
    // through as ordinary characters and land in the secret.
    const p = readSecret('Password: ')
    fake.emit('data', 'a\x1b[Bb\r')
    await expect(p).resolves.toBe('ab')
  })

  it('consumes an SS3 sequence whole (e.g. a numpad key)', async () => {
    const p = readSecret('Password: ')
    fake.emit('data', 'x\x1bOPy\r')
    await expect(p).resolves.toBe('xy')
  })

  it('carries CSI state across chunks when the final byte arrives separately', async () => {
    // A terminal may split one keypress over two 'data' events. Scanning each
    // chunk in isolation let the trailing final byte through: 'ESC [' + 'A'
    // yielded "aA". The escape state has to survive the boundary.
    const p = readSecret('Password: ')
    fake.emit('data', 'a\x1b[')
    fake.emit('data', 'A')
    fake.emit('data', 'b\r')
    await expect(p).resolves.toBe('ab')
  })

  it('carries CSI state across chunks with parameter bytes split up', async () => {
    // ESC [ 1 ; 5 D (ctrl+left) fragmented three ways
    const p = readSecret('Password: ')
    fake.emit('data', 'x\x1b[1')
    fake.emit('data', ';5')
    fake.emit('data', 'Dy\r')
    await expect(p).resolves.toBe('xy')
  })

  it('carries SS3 state across chunks', async () => {
    const p = readSecret('Password: ')
    fake.emit('data', 'a\x1bO')
    fake.emit('data', 'Pb\r')
    await expect(p).resolves.toBe('ab')
  })

  it('treats ESC split from its introducer as a sequence, not literal text', async () => {
    const p = readSecret('Password: ')
    fake.emit('data', 'a\x1b')
    fake.emit('data', '[B')
    fake.emit('data', 'b\r')
    await expect(p).resolves.toBe('ab')
  })

  it('drops a lone stray ESC without swallowing the next real character', async () => {
    const p = readSecret('Password: ')
    fake.emit('data', 'a\x1bZb\r')
    await expect(p).resolves.toBe('aZb')
  })

  it('restores the previous raw mode and detaches its listener when done', async () => {
    const p = readSecret('Password: ')
    expect(fake.setRawMode).toHaveBeenCalledWith(true)
    fake.emit('data', 'pw\r')
    await p
    expect(fake.setRawMode).toHaveBeenLastCalledWith(false)
    expect(fake.pause).toHaveBeenCalled()
    expect(fake.listenerCount('data')).toBe(0)
  })

  it('leaves an already-raw terminal in raw mode', async () => {
    fake.isRaw = true
    const p = readSecret('Password: ')
    fake.emit('data', 'pw\r')
    await p
    expect(fake.setRawMode).toHaveBeenLastCalledWith(true)
  })

  it('restores the terminal before exiting on Ctrl-C', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exited')
    }) as never)
    readSecret('Password: ')
    expect(() => fake.emit('data', '\x03')).toThrow('exited')
    // Restoring first is the point: exiting straight from raw mode leaves the
    // parent shell with no echo and no line editing.
    expect(fake.setRawMode).toHaveBeenLastCalledWith(false)
    expect(exit).toHaveBeenCalledWith(130)
  })

  it('supports two sequential calls without leaking listeners', async () => {
    const first = readSecret('Password: ')
    fake.emit('data', 'one1AAA\r')
    await expect(first).resolves.toBe('one1AAA')
    expect(fake.listenerCount('data')).toBe(0)

    const second = readSecret('Confirm: ')
    fake.emit('data', 'two2BBB\r')
    await expect(second).resolves.toBe('two2BBB')
    expect(fake.listenerCount('data')).toBe(0)
  })
})
