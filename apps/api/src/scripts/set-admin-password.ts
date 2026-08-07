import path from 'node:path'
/**
 * Set admin password — prompt interactively for a new password,
 * hash it, and write it directly to the admin user. No server
 * restart required.
 *
 * Usage: pnpm run set-admin-password
 */
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Same fallback as db/migrate.ts: env.ts defaults NODE_ENV to 'production',
// whose AUTH_SECRET superRefine would fail this local admin-recovery command
// with a confusing "production" error.
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'development'
// This script writes a password hash and never signs/verifies tokens; keep it
// usable even when .env is missing (the exact recovery scenario it exists for).
if (!process.env.AUTH_SECRET) process.env.AUTH_SECRET = 'ops-script-placeholder-secret-unused'

const apiRoot = path.resolve(__dirname, '..', '..')
process.chdir(apiRoot)

function readMaskedPassword(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    const stdout = process.stdout
    if (!stdin.isTTY) {
      reject(new Error('STDIN is not a TTY — interactive password prompt is unavailable.'))
      return
    }
    stdout.write(prompt)
    const wasRaw = stdin.isRaw
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')

    let password = ''
    const cleanup = () => {
      stdin.setRawMode(wasRaw)
      stdin.pause()
      stdin.removeListener('data', onData)
    }
    // Escape-sequence progress, tracked ACROSS 'data' events. Arrow keys and
    // friends arrive as multi-byte sequences (CSI: ESC '[' ... final byte in
    // 0x40..0x7e; SS3: ESC 'O' <byte>). Dropping only the ESC byte — which a
    // bare `code < 32` check does — lets the rest ('[A', etc.) land in the
    // password, and a terminal may split one sequence over two chunks, so the
    // state has to survive the boundary.
    let escState: 'none' | 'esc' | 'csi' | 'ss3' = 'none'
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (escState === 'esc') {
          if (ch === '[') escState = 'csi'
          else if (ch === 'O') escState = 'ss3'
          else escState = 'none' // lone ESC: handle this character normally
          if (escState !== 'none') continue
        } else if (escState === 'csi') {
          if (ch >= '\x40' && ch <= '\x7e') escState = 'none'
          continue
        } else if (escState === 'ss3') {
          escState = 'none'
          continue
        }

        const code = ch.charCodeAt(0)
        if (ch === '\r' || ch === '\n') {
          cleanup()
          stdout.write('\n')
          resolve(password)
          return
        }
        if (code === 3) {
          cleanup()
          stdout.write('\n')
          reject(new Error('Cancelled by user (Ctrl-C)'))
          return
        }
        if (code === 127 || code === 8) {
          if (password.length > 0) {
            password = password.slice(0, -1)
            stdout.write('\b \b')
          }
          continue
        }
        if (code === 27) {
          escState = 'esc'
          continue
        }
        if (code < 32) continue
        password += ch
        stdout.write('*')
      }
    }
    stdin.on('data', onData)
  })
}

const { eq, sql } = await import('drizzle-orm')
const { db } = await import('../db/client.js')
const { withTransaction } = await import('../db/transaction.js')
const { users } = await import('../db/schema.js')
const { hashPassword, validatePassword } = await import('../lib/auth.js')
const { logBackgroundAudit } = await import('../lib/audit.js')
const { AUDIT_ACTIONS } = await import('../lib/audit-actions.js')

const admin = (await db.select().from(users).where(eq(users.username, 'admin')).limit(1))[0]
if (!admin) {
  console.error('Admin user not found. Run the migration first.')
  process.exit(1)
}

try {
  const first = await readMaskedPassword('New admin password:   ')
  const second = await readMaskedPassword('Confirm new password: ')

  if (first !== second) {
    console.error('Passwords do not match.')
    process.exit(1)
  }

  const validation = validatePassword(first)
  if (!validation.valid) {
    console.error(`Password does not meet policy: ${validation.message}`)
    console.error('Policy: min 8 chars, at least one uppercase, one lowercase, one digit.')
    process.exit(1)
  }

  const passwordHash = await hashPassword(first)
  // One transaction: a credential change that lands without its audit entry is
  // exactly the untraceable state Iron Rule 5 exists to prevent, and a failed
  // audit insert must not leave the operator told "failed" while the password
  // and tokenVersion have already moved.
  await withTransaction(async (tx) => {
    await tx
      .update(users)
      .set({
        passwordHash,
        // Revoke every outstanding admin token: the whole point of this script is
        // recovering from a compromised or forgotten credential, so any token
        // signed under the old password must stop working the instant the new
        // one is set — otherwise a session started before the reset (or a token
        // an attacker already holds) keeps working right through it.
        tokenVersion: sql`${users.tokenVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, admin.id))
    // Awaited: this script exits the process a few lines later, so an unawaited
    // insert can be abandoned mid-flight — and on PostgreSQL it would in any
    // case be issued after `tx` has already committed and released its client.
    // Either way the credential reset lands with no trail (Iron Rule 5).
    await logBackgroundAudit(
      {
        action: AUDIT_ACTIONS.ADMIN_PASSWORD_RESET,
        resource: 'user',
        resourceId: admin.id,
        details: { via: 'set-admin-password.ts' },
      },
      tx,
    )
  })

  console.log('Admin password updated. You can log in with the new password immediately.')
  console.log('All existing admin sessions and tokens have been revoked.')
  process.exit(0)
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
