import { CliError } from '../errors.js'

/**
 * Read a line from stdin with the echo suppressed, so a typed secret never
 * lands in the terminal scrollback (nor in a screen share or a recorded
 * session). Shared by `a2wave login --password` and `a2wave setup`.
 *
 * Requires a TTY: raw mode is unavailable on a pipe, and without it the input
 * would be echoed in the clear. Enforced here rather than left to callers, so
 * a new call site cannot silently leak the secret or crash on setRawMode.
 */
export function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { stdin } = process
    if (!stdin.isTTY) {
      reject(
        new CliError(
          'Cannot read a secret: stdin is not a terminal, so the input could not be hidden.',
        ),
      )
      return
    }
    process.stdout.write(prompt)
    const wasRaw = stdin.isRaw
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')

    let secret = ''
    const restore = () => {
      stdin.setRawMode(wasRaw ?? false)
      stdin.pause()
      stdin.removeListener('data', onData)
    }

    // Escape-sequence progress, tracked ACROSS 'data' events. A terminal is free
    // to split a single keypress over two chunks — `ESC [` in one, the final `A`
    // in the next — so scanning each chunk in isolation would let the tail land
    // in the secret. 'none' = ordinary input, 'esc' = just saw ESC, 'csi' =
    // inside `ESC [ ... final`, 'ss3' = expecting the one byte after `ESC O`.
    let escState: 'none' | 'esc' | 'csi' | 'ss3' = 'none'

    // A single 'data' event can carry many characters — a paste, or fast typing.
    // Matching the whole chunk against '\r' would append the newline and every
    // control byte straight into the secret, so walk it character by character.
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        // Mid-escape-sequence: swallow until the sequence terminates, so no part
        // of an arrow key or function key reaches the secret.
        if (escState === 'esc') {
          if (ch === '[') escState = 'csi'
          else if (ch === 'O') escState = 'ss3'
          // Anything else was a lone ESC followed by ordinary input: fall
          // through below so this character is handled normally.
          else {
            escState = 'none'
          }
          if (escState !== 'none') continue
        } else if (escState === 'csi') {
          // CSI runs until a final byte in 0x40..0x7e; parameter/intermediate
          // bytes before it are all swallowed.
          if (ch >= '\x40' && ch <= '\x7e') escState = 'none'
          continue
        } else if (escState === 'ss3') {
          escState = 'none'
          continue
        }

        // Control characters are written as escapes, never as literal bytes: a
        // raw DEL/ETX in the source is invisible in most editors and collapses
        // to an empty string on a careless copy — exactly how backspace and
        // Ctrl-C silently stopped working in the original inline reader.
        if (ch === '\r' || ch === '\n') {
          restore()
          process.stdout.write('\n')
          resolve(secret)
          return
        }
        if (ch === '\x03') {
          // Restore the terminal before exiting, or the parent shell is left in
          // raw mode with no echo and no line editing.
          restore()
          process.stdout.write('\n')
          process.exit(130)
        }
        if (ch === '\x7f' || ch === '\b') {
          if (secret.length > 0) secret = secret.slice(0, -1)
          continue
        }
        if (ch === '\x1b') {
          escState = 'esc'
          continue
        }
        // Drop any remaining control characters (stray Ctrl-combos) instead of
        // embedding them in the secret.
        if (ch < ' ') continue
        secret += ch
      }
    }
    stdin.on('data', onData)
  })
}
