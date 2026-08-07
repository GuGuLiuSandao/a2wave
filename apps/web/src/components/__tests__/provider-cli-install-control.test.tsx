import type { ProviderCliState } from '@/hooks/use-provider-clis'
import i18n from '@/i18n'
import { renderWithProviders, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The install control is the only surface an operator has for getting a working
 * execution engine, and it is shared by the Providers list and the Provider
 * detail page — so its state reporting is pinned here rather than in either
 * page's tests.
 */

const installMutate = vi.fn()
const uninstallMutate = vi.fn()
const installPending = { value: false }
const uninstallPending = { value: false }

vi.mock('@/hooks/use-provider-clis', () => ({
  useInstallProviderCli: () => ({ mutate: installMutate, isPending: installPending.value }),
  useUninstallProviderCli: () => ({ mutate: uninstallMutate, isPending: uninstallPending.value }),
}))

vi.mock('@/lib/antd-static', () => ({
  message: { success: vi.fn(), error: vi.fn() },
}))

const { ProviderCliInstallControl, ProviderCliStatusChip } = await import(
  '../provider-cli-install-control'
)

function cli(overrides: Partial<ProviderCliState> = {}): ProviderCliState {
  return {
    kind: 'claude-code',
    binary: 'claude',
    lockedVersion: '2.1.212',
    installType: 'npm',
    installed: false,
    installedVersion: null,
    matchesLock: null,
    lockDrift: null,
    minVersion: null,
    meetsMinimum: null,
    status: 'idle',
    lastError: null,
    lastOutput: null,
    ...overrides,
  }
}

/** Older than the pin but still clearing the Provider's minimum-version floor. */
function belowPinButUsable(overrides: Partial<ProviderCliState> = {}): ProviderCliState {
  return cli({
    installed: true,
    installedVersion: '2.0.1',
    matchesLock: false,
    lockDrift: 'below',
    minVersion: '2.0.0',
    meetsMinimum: true,
    ...overrides,
  })
}

/** Older than the pin *and* below the floor — the genuinely broken build. */
function belowMinimum(overrides: Partial<ProviderCliState> = {}): ProviderCliState {
  return belowPinButUsable({ installedVersion: '1.9.0', meetsMinimum: false, ...overrides })
}

/** Installed at exactly the pinned version — the all-green case. */
function pinned(overrides: Partial<ProviderCliState> = {}): ProviderCliState {
  return cli({
    installed: true,
    installedVersion: '2.1.212',
    matchesLock: true,
    lockDrift: 'match',
    ...overrides,
  })
}

beforeEach(async () => {
  installMutate.mockReset()
  uninstallMutate.mockReset()
  installPending.value = false
  uninstallPending.value = false
  await i18n.changeLanguage('zh')
})

describe('ProviderCliStatusChip', () => {
  it('warns when nothing is installed, because the Agent cannot run at all', () => {
    renderWithProviders(<ProviderCliStatusChip cli={cli()} />)

    expect(screen.getByText('未安装')).toBeInTheDocument()
  })

  it('reports a build matching the pin as installed', () => {
    renderWithProviders(<ProviderCliStatusChip cli={pinned()} />)

    expect(screen.getByText('已安装')).toBeInTheDocument()
  })

  it('warns when the installed build is below the minimum version requirement', () => {
    renderWithProviders(<ProviderCliStatusChip cli={belowMinimum()} />)

    expect(screen.getByText('版本过低')).toHaveClass('text-warning')
  })

  /**
   * Regression: every build below the pin was warned about, but the platform
   * gates on a *minimum* version, not on exact-pin equality — being older than
   * the pin while clearing the floor is a supported state, not a defect. Those
   * operators were told their working CLI was stale.
   */
  it('does not warn about a build below the pin that still meets the minimum', () => {
    renderWithProviders(<ProviderCliStatusChip cli={belowPinButUsable()} />)

    expect(screen.queryByText('版本过低')).not.toBeInTheDocument()
    const chip = screen.getByText('低于锁定版本')
    expect(chip).toHaveClass('text-interactive-foreground')
    expect(chip).not.toHaveClass('text-warning')
  })

  /**
   * `meetsMinimum` is null whenever the verdict is undecidable — no floor is
   * declared, or the version string cannot be parsed. Undecidable is not a
   * defect, so it must land in the same benign branch as an explicit pass.
   */
  it('does not warn when the floor verdict is undecidable', () => {
    renderWithProviders(<ProviderCliStatusChip cli={belowPinButUsable({ meetsMinimum: null })} />)

    expect(screen.queryByText('版本过低')).not.toBeInTheDocument()
    expect(screen.getByText('低于锁定版本')).toBeInTheDocument()
  })

  /**
   * Regression: the pin is exact, but a mismatch used to be a single boolean
   * rendered as "update available". A build newer than the pin therefore read as
   * out of date even though it satisfies the separate minVersion floor the
   * engine actually gates on — and the offered update downgraded it.
   */
  it('does not call a build newer than the pin outdated', () => {
    renderWithProviders(
      <ProviderCliStatusChip
        cli={pinned({ installedVersion: '2.1.300', matchesLock: false, lockDrift: 'above' })}
      />,
    )

    expect(screen.queryByText('版本过低')).not.toBeInTheDocument()
    expect(screen.getByText('非托管版本')).toBeInTheDocument()
  })

  it('treats an unparsable version as unmanaged rather than guessing a direction', () => {
    renderWithProviders(
      <ProviderCliStatusChip
        cli={pinned({ installedVersion: 'nightly', matchesLock: false, lockDrift: 'unknown' })}
      />,
    )

    expect(screen.getByText('非托管版本')).toBeInTheDocument()
  })

  it('shows progress while an install runs', () => {
    renderWithProviders(<ProviderCliStatusChip cli={cli({ status: 'installing' })} />)

    expect(screen.getByText('安装中')).toBeInTheDocument()
  })

  it('shows progress while an uninstall runs', () => {
    renderWithProviders(<ProviderCliStatusChip cli={pinned({ status: 'uninstalling' })} />)

    expect(screen.getByText('卸载中')).toBeInTheDocument()
  })
})

describe('ProviderCliInstallControl', () => {
  it('triggers the install mutation for the clicked CLI', async () => {
    renderWithProviders(<ProviderCliInstallControl cli={cli()} />)

    await userEvent.click(screen.getByRole('button', { name: /安装/ }))

    expect(installMutate).toHaveBeenCalledWith('claude-code', expect.anything())
  })

  it('offers no install action once the pinned build is in place', () => {
    renderWithProviders(<ProviderCliInstallControl cli={pinned()} />)

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('labels the action an update only when the build is older than the pin', () => {
    renderWithProviders(<ProviderCliInstallControl cli={belowPinButUsable()} />)

    expect(screen.getByRole('button', { name: /更新/ })).toBeInTheDocument()
  })

  it('names the unmet requirement when the build is below the minimum version', () => {
    renderWithProviders(<ProviderCliInstallControl cli={belowMinimum()} />)

    const title = screen.getByRole('button', { name: /更新/ }).getAttribute('title')
    expect(title).toContain('低于最低版本要求')
    // The required version has to be in the copy: "too old" without a target
    // leaves the operator with nothing to act on.
    expect(title).toContain('2.0.0')
  })

  /**
   * The update stays on offer for a benign build — installing the pinned version
   * is still legitimate — but the reason must read as optional rather than as a
   * fault.
   */
  it('frames the update as optional when the build already meets the minimum', () => {
    renderWithProviders(<ProviderCliInstallControl cli={belowPinButUsable()} />)

    const button = screen.getByRole('button', { name: /更新/ })
    expect(button).toBeInTheDocument()
    expect(button.getAttribute('title')).toContain('可选')
    expect(button.getAttribute('title')).not.toContain('低于最低版本要求')
  })

  /** Same regression as the chip: replacing a newer build is a downgrade, not an update. */
  it('labels replacing a newer build as a reinstall, not an update', () => {
    renderWithProviders(
      <ProviderCliInstallControl
        cli={pinned({ installedVersion: '2.1.300', matchesLock: false, lockDrift: 'above' })}
      />,
    )

    expect(screen.getByRole('button', { name: '重装为锁定版本' })).toBeInTheDocument()
  })

  it('renders the uninstall action only when asked for it', async () => {
    renderWithProviders(<ProviderCliInstallControl cli={pinned()} showUninstall />)

    await userEvent.click(screen.getByRole('button', { name: '卸载' }))

    expect(uninstallMutate).toHaveBeenCalledWith('claude-code', expect.anything())
  })

  it('disables the action while an install is running', () => {
    renderWithProviders(<ProviderCliInstallControl cli={cli({ status: 'installing' })} />)

    expect(screen.getByRole('button')).toBeDisabled()
  })

  /**
   * `uninstalling` is a distinct status another session can observe, so the
   * button must be disabled for it too — not only for `installing`.
   */
  it('disables the action while an uninstall is running', () => {
    renderWithProviders(
      <ProviderCliInstallControl cli={pinned({ status: 'uninstalling' })} showUninstall />,
    )

    expect(screen.getByRole('button', { name: '卸载' })).toBeDisabled()
  })
})
