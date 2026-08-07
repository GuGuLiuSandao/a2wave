import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listInstallStates = vi.fn()
const claimInstallSlot = vi.fn()
const installCli = vi.fn()
const uninstallCli = vi.fn()
const logAudit = vi.fn()

class FakeCliInstallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

vi.mock('../../lib/cli-installer.js', () => ({
  CliInstallError: FakeCliInstallError,
  claimInstallSlot: (kind: string) => claimInstallSlot(kind),
  ensureLockLoaded: () => Promise.resolve(),
  listInstallStates: () => listInstallStates(),
  installCli: (kind: string) => installCli(kind),
  uninstallCli: (kind: string) => uninstallCli(kind),
  resolveInstallRoot: () => '/home/appuser/.a2wave',
}))

vi.mock('../../lib/audit.js', () => ({
  logAudit: (...args: unknown[]) => logAudit(...args),
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const providerClis = (await import('../provider-clis.js')).default

const app = new Hono()
app.route('/api/provider-clis', providerClis)

const STATE = {
  kind: 'claude-code',
  binary: 'claude',
  lockedVersion: '2.1.212',
  installType: 'npm' as const,
  installed: false,
  installedVersion: null,
  matchesLock: null,
  status: 'idle' as const,
  lastError: null,
  lastOutput: null,
}

beforeEach(() => {
  listInstallStates.mockReset()
  claimInstallSlot.mockReset()
  installCli.mockReset()
  uninstallCli.mockReset()
  logAudit.mockReset()
  listInstallStates.mockResolvedValue([STATE])
  claimInstallSlot.mockReturnValue({ lockedVersion: '2.1.212' })
  installCli.mockResolvedValue(undefined)
  uninstallCli.mockResolvedValue(undefined)
})

describe('GET /api/provider-clis', () => {
  it('returns every managed CLI with its install state', async () => {
    const res = await app.request('/api/provider-clis')

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toMatchObject({ kind: 'claude-code', installed: false })
  })

  it('reports the install root so the UI can explain where CLIs land', async () => {
    const res = await app.request('/api/provider-clis')

    expect((await res.json()).meta.installRoot).toBe('/home/appuser/.a2wave')
  })
})

describe('POST /api/provider-clis/:kind/install', () => {
  it('accepts with 202 and installs in the background', async () => {
    // A large CLI takes minutes; holding the request open would time out.
    const res = await app.request('/api/provider-clis/claude-code/install', { method: 'POST' })

    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ data: { kind: 'claude-code', status: 'installing' } })
    expect(installCli).toHaveBeenCalledWith('claude-code')
  })

  it('audits the install with the version but no credentials', async () => {
    await app.request('/api/provider-clis/claude-code/install', { method: 'POST' })

    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'provider_cli.install',
        resource: 'provider_cli',
        resourceId: 'claude-code',
        details: { kind: 'claude-code', version: '2.1.212' },
      }),
    )
  })

  it('404s an unknown kind instead of accepting a job that cannot run', async () => {
    claimInstallSlot.mockImplementation(() => {
      throw new FakeCliInstallError('unknown_kind', 'Unknown CLI: not-a-cli')
    })

    const res = await app.request('/api/provider-clis/not-a-cli/install', { method: 'POST' })

    expect(res.status).toBe(404)
    expect(installCli).not.toHaveBeenCalled()
  })

  it('409s when an install for that CLI is already running', async () => {
    claimInstallSlot.mockImplementation(() => {
      throw new FakeCliInstallError('already_running', 'claude-code is already installing')
    })

    const res = await app.request('/api/provider-clis/claude-code/install', { method: 'POST' })

    expect(res.status).toBe(409)
    expect(installCli).not.toHaveBeenCalled()
  })

  it('claims the slot before accepting, so a double-click cannot be accepted twice', async () => {
    // Regression: deciding from the pre-read status left a window before the
    // background task wrote `installing`, so two rapid POSTs both got 202 and
    // both wrote an audit entry for one install.
    let claimed = false
    claimInstallSlot.mockImplementation(() => {
      if (claimed) throw new FakeCliInstallError('already_running', 'already installing')
      claimed = true
      return { lockedVersion: '2.1.212' }
    })

    const first = await app.request('/api/provider-clis/claude-code/install', { method: 'POST' })
    const second = await app.request('/api/provider-clis/claude-code/install', { method: 'POST' })

    expect(first.status).toBe(202)
    expect(second.status).toBe(409)
    expect(logAudit).toHaveBeenCalledTimes(1)
  })

  it('does not audit an install that was rejected as a duplicate', async () => {
    claimInstallSlot.mockImplementation(() => {
      throw new FakeCliInstallError('already_running', 'already installing')
    })

    await app.request('/api/provider-clis/claude-code/install', { method: 'POST' })

    expect(logAudit).not.toHaveBeenCalled()
  })

  it('still returns 202 when the background install later fails', async () => {
    // The failure is persisted on the row for the UI to poll; it must not surface
    // as an unhandled rejection or a 500 on the accept response.
    installCli.mockRejectedValue(new Error('checksum mismatch'))

    const res = await app.request('/api/provider-clis/claude-code/install', { method: 'POST' })

    expect(res.status).toBe(202)
  })
})

describe('POST /api/provider-clis/:kind/uninstall', () => {
  it('removes the CLI and audits it', async () => {
    const res = await app.request('/api/provider-clis/claude-code/uninstall', { method: 'POST' })

    expect(res.status).toBe(200)
    expect(uninstallCli).toHaveBeenCalledWith('claude-code')
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'provider_cli.uninstall', resourceId: 'claude-code' }),
    )
  })

  it('maps an unknown kind to 404', async () => {
    uninstallCli.mockRejectedValue(new FakeCliInstallError('unknown_kind', 'Unknown CLI: nope'))

    const res = await app.request('/api/provider-clis/nope/uninstall', { method: 'POST' })

    expect(res.status).toBe(404)
  })

  it('maps a concurrent install to 409', async () => {
    uninstallCli.mockRejectedValue(new FakeCliInstallError('already_running', 'busy'))

    const res = await app.request('/api/provider-clis/claude-code/uninstall', { method: 'POST' })

    expect(res.status).toBe(409)
  })

  it('does not audit a failed uninstall', async () => {
    uninstallCli.mockRejectedValue(new FakeCliInstallError('install_failed', 'permission denied'))

    const res = await app.request('/api/provider-clis/claude-code/uninstall', { method: 'POST' })

    expect(res.status).toBe(500)
    expect(logAudit).not.toHaveBeenCalled()
  })
})
