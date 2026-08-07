import { Hono } from 'hono'
import { AUDIT_ACTIONS } from '../lib/audit-actions.js'
import { logAudit } from '../lib/audit.js'
import {
  CliInstallError,
  claimInstallSlot,
  ensureLockLoaded,
  installCli,
  listInstallStates,
  resolveInstallRoot,
  uninstallCli,
} from '../lib/cli-installer.js'
import { logger } from '../lib/logger.js'

/**
 * Runtime management of the Agent CLIs. The image ships none of them — see
 * lib/cli-installer.ts for why — so these endpoints are how a deployment gets a
 * working execution engine.
 *
 * Admin-only; auth is applied at mount time in index.ts.
 */
const app = new Hono()

/** GET /provider-clis — every managed CLI with its probed install state. */
app.get('/', async (c) => {
  const data = await listInstallStates()
  return c.json({
    data,
    meta: { installRoot: resolveInstallRoot() },
  })
})

function errorStatus(code: CliInstallError['code']): 400 | 404 | 409 | 500 {
  if (code === 'unknown_kind') return 404
  if (code === 'already_running') return 409
  if (code === 'not_installed') return 400
  return 500
}

/**
 * POST /provider-clis/:kind/install — install at the locked version.
 *
 * Returns 202 and installs in the background: a large CLI takes tens of seconds
 * to minutes, well past a sensible request timeout. Progress is persisted on the
 * row, so the UI polls and the outcome survives a page reload or a restart.
 */
app.post('/:kind/install', async (c) => {
  const kind = c.req.param('kind')

  // Load the lock first so the claim below needs no await of its own.
  await ensureLockLoaded()

  // Resolve the kind and claim the slot in one synchronous step. Any await between
  // the status read and the `installing` write reopens the window where two rapid
  // clicks are both accepted — the earlier version probed versions in between and
  // duly returned 202 twice for one install.
  let claim: { lockedVersion: string }
  try {
    claim = await claimInstallSlot(kind)
  } catch (err) {
    if (err instanceof CliInstallError) {
      return c.json({ error: err.message, code: err.code }, errorStatus(err.code))
    }
    throw err
  }

  logAudit(c, {
    action: AUDIT_ACTIONS.PROVIDER_CLI_INSTALL,
    resource: 'provider_cli',
    resourceId: kind,
    // Version only — never credentials; this is rendered verbatim to admins.
    details: { kind, version: claim.lockedVersion },
  })

  void installCli(kind).catch((err) => {
    // The failure is already persisted on the row for the UI to read; this log is
    // for operators. Swallowing it here keeps an unhandled rejection from taking
    // the process down.
    logger.warn(
      { kind, err: err instanceof Error ? err.message : String(err) },
      'CLI install failed',
    )
  })

  return c.json({ data: { kind, status: 'installing' } }, 202)
})

/** POST /provider-clis/:kind/uninstall — remove the CLI's files. */
app.post('/:kind/uninstall', async (c) => {
  const kind = c.req.param('kind')

  try {
    await uninstallCli(kind)
  } catch (err) {
    if (err instanceof CliInstallError) {
      return c.json({ error: err.message, code: err.code }, errorStatus(err.code))
    }
    throw err
  }

  logAudit(c, {
    action: AUDIT_ACTIONS.PROVIDER_CLI_UNINSTALL,
    resource: 'provider_cli',
    resourceId: kind,
    details: { kind },
  })

  return c.json({ data: { kind, status: 'idle' } })
})

export default app
