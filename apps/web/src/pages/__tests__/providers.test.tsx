import { renderWithProviders, screen } from '@/test/render'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProvidersPage } from '../providers'

const { useProvidersMock, useUnsupportedProvidersMock, useProviderClisMock, useCurrentUserMock } =
  vi.hoisted(() => ({
    useProvidersMock: vi.fn(),
    useUnsupportedProvidersMock: vi.fn(),
    useProviderClisMock: vi.fn(),
    useCurrentUserMock: vi.fn(),
  }))

vi.mock('@/hooks/use-providers', () => ({
  useProviders: useProvidersMock,
  useUnsupportedProviders: useUnsupportedProvidersMock,
}))

vi.mock('@/hooks/use-auth', () => ({ useCurrentUser: useCurrentUserMock }))

vi.mock('@/hooks/use-provider-clis', () => ({
  useProviderClis: useProviderClisMock,
  useInstallProviderCli: () => ({ mutate: vi.fn(), isPending: false }),
  useUninstallProviderCli: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@/lib/antd-static', () => ({ message: { success: vi.fn(), error: vi.fn() } }))

function cliState(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'codex',
    binary: 'codex',
    lockedVersion: '0.144.5',
    installType: 'npm',
    installed: false,
    installedVersion: null,
    matchesLock: null,
    lockDrift: null,
    status: 'idle',
    lastError: null,
    lastOutput: null,
    ...overrides,
  }
}

describe('ProvidersPage', () => {
  beforeEach(() => {
    useProvidersMock.mockReturnValue({
      data: [
        {
          id: 'prv_codex',
          kind: 'codex',
          name: 'Codex CLI',
          description: 'OpenAI Codex CLI',
          minVersion: null,
          capabilities: { sandbox: 'native' },
        },
        {
          id: 'prv_opencode',
          kind: 'opencode',
          name: 'OpenCode CLI',
          description: 'opencode CLI',
          minVersion: '1.18.0',
          capabilities: { sandbox: 'unsupported' },
        },
      ],
      isLoading: false,
    })
    useUnsupportedProvidersMock.mockReturnValue({
      data: [
        {
          id: 'prv_gemini',
          kind: 'legacy:prv_gemini',
          name: 'Gemini CLI',
          status: 'unsupported',
          diagnostic: {
            code: 'PROVIDER_KIND_UNSUPPORTED',
            message: 'No runtime adapter is registered',
          },
        },
      ],
    })
    useCurrentUserMock.mockReturnValue({ data: { role: 'admin' } })
    useProviderClisMock.mockReturnValue({
      data: { data: [], meta: {} },
      isError: false,
      refetch: vi.fn(),
    })
  })

  it('shows historical unsupported Providers as an administrator diagnostic', () => {
    renderWithProviders(<ProvidersPage />)

    expect(screen.getByRole('alert')).toHaveTextContent('发现不受支持的 Provider')
    expect(screen.getByRole('alert')).toHaveTextContent('Gemini CLI (legacy:prv_gemini)')
    expect(screen.getByRole('link', { name: /Codex CLI/ })).toHaveAttribute(
      'href',
      '/providers/prv_codex',
    )
    expect(screen.queryByRole('link', { name: /Gemini CLI/ })).not.toBeInTheDocument()
  })

  it('renders sandbox capability + min-version badges and no longer shows the preset tag', () => {
    renderWithProviders(<ProvidersPage />)

    // Sandbox capability badge per card (native vs none).
    expect(screen.getByText('系统沙箱')).toBeInTheDocument()
    expect(screen.getByText('无沙箱')).toBeInTheDocument()
    // Min-version badge only for the provider that declares one.
    expect(screen.getByText('最低版本 1.18.0')).toBeInTheDocument()
    // The redundant "预设" tag was removed (every provider is a preset).
    expect(screen.queryByText('预设')).not.toBeInTheDocument()
  })

  /**
   * With the standalone Agent CLI page gone, this is the surface the manual
   * sends operators to. A failed catalog read renders no CLI row on any card —
   * indistinguishable from "every CLI is fine" — while Agents fail at spawn
   * time, so the failure has to be stated.
   */
  it('surfaces a failed CLI status read instead of rendering as all-clear', () => {
    useProviderClisMock.mockReturnValue({
      data: undefined,
      isError: true,
      refetch: vi.fn(),
    })

    renderWithProviders(<ProvidersPage />)

    const alerts = screen.getAllByRole('alert')
    expect(alerts.some((el) => el.textContent?.includes('无法获取 Agent CLI 状态'))).toBe(true)
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  /**
   * A failed install returns 202 and reports itself only on the row, so without
   * this the card looks exactly as it did before the click and the operator
   * retries forever.
   */
  it('shows why an install failed on the card that offered it', () => {
    useProviderClisMock.mockReturnValue({
      data: {
        data: [cliState({ status: 'error', lastError: 'archive checksum mismatch' })],
        meta: {},
      },
      isError: false,
      refetch: vi.fn(),
    })

    renderWithProviders(<ProvidersPage />)

    // Carried by an icon's accessible name rather than inline text: on the card's
    // shared bottom row the full message crowded out the tags, and truncating it
    // ("[provider-clis] cursor has...") informed nobody.
    expect(screen.getByLabelText('archive checksum mismatch')).toBeInTheDocument()
  })

  /**
   * A <button> inside an <a> is invalid, and it only avoided navigating because
   * the control stop-propagated every click — so the next button added to the
   * card would have silently navigated away instead of acting.
   */
  it('keeps the install action outside the card link', () => {
    useProviderClisMock.mockReturnValue({
      data: { data: [cliState()], meta: {} },
      isError: false,
      refetch: vi.fn(),
    })

    renderWithProviders(<ProvidersPage />)

    const install = screen.getByRole('button', { name: /安装/ })
    expect(install.closest('a')).toBeNull()
  })

  it('explains why the install action is offered on an installed CLI', () => {
    useProviderClisMock.mockReturnValue({
      data: {
        data: [
          cliState({
            installed: true,
            installedVersion: '0.140.0',
            matchesLock: false,
            lockDrift: 'below',
          }),
        ],
        meta: {},
      },
      isError: false,
      refetch: vi.fn(),
    })

    renderWithProviders(<ProvidersPage />)

    // The reason rides on the button rather than sitting beside it as body copy:
    // in this card the sentence truncated to "This Provider's CLI is not i...",
    // which explained nothing while still costing a row. Either way the operator
    // must not be left guessing what was out of date.
    //
    // Codex declares no minimum-version floor, so this older-than-pin build is
    // the benign case: the hint frames the update as optional rather than as a
    // fault.
    expect(screen.getByRole('button', { name: /更新/ })).toHaveAttribute(
      'title',
      '当前版本低于平台锁定版本，但未低于该 Provider 的最低版本要求，可以正常运行；更新为可选操作。',
    )
  })

  it('keeps the card height stable whether or not the CLI is installed', () => {
    useProviderClisMock.mockReturnValue({
      data: {
        data: [cliState({ installed: true, matchesLock: true, lockDrift: 'match' })],
        meta: {},
      },
      isError: false,
      refetch: vi.fn(),
    })

    const { container } = renderWithProviders(<ProvidersPage />)

    // An installed CLI needs no action, but the row still occupies its slot —
    // otherwise a grid of cards steps up and down by a row between states.
    expect(container.querySelector('.min-h-7')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /安装/ })).toBeNull()
  })

  it('keeps the tags and the install action on separate fixed-height rows', () => {
    useProviderClisMock.mockReturnValue({
      data: { data: [cliState()], meta: {} },
      isError: false,
      refetch: vi.fn(),
    })

    renderWithProviders(<ProvidersPage />)

    const install = screen.getByRole('button', { name: /安装/ })
    const tag = screen.getByText('系统沙箱')

    // Separate rows are what keep the grid's baselines aligned. Sharing one row
    // could not: a variable number of chips beside a variable-width button wraps
    // on some cards and not others, leaving the grid ragged. Each row reserves
    // its height, so the tags sit at the same offset on every card.
    const actionRow = install.closest('.min-h-7')
    expect(actionRow).not.toBeNull()
    expect(actionRow).not.toContainElement(tag)
    expect(tag.closest('.min-h-6')).not.toBeNull()
  })
})
