import i18n from '@/i18n'
import { renderWithProviders, screen, userEvent, waitFor, within } from '@/test/render'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginPage } from '../login'

const { useOauthConfigMock } = vi.hoisted(() => ({
  useOauthConfigMock: vi.fn(),
}))

vi.mock('@/hooks/use-auth', () => ({
  useAuthStatus: () => ({ data: { needSetup: false }, isLoading: false }),
  useOauthConfig: () => useOauthConfigMock(),
  useLogin: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

const OIDC_LOGIN_URL = '/api/auth/oidc/login'
const SAML_LOGIN_URL = '/api/auth/saml/login'

const oidcLabel = i18n.t('auth.oidcLogin')
const samlLabel = i18n.t('auth.samlLogin')
// 多方式并排用短标签
const oidcShort = i18n.t('auth.oidcLoginShort')
const samlShort = i18n.t('auth.samlLoginShort')

function mockLocation(url: string) {
  const parsed = new URL(url)
  Object.defineProperty(window, 'location', {
    value: {
      href: url,
      origin: parsed.origin,
      pathname: parsed.pathname,
      search: parsed.search,
      hash: parsed.hash,
    },
    writable: true,
    configurable: true,
  })
}

function ssoButton(name: string) {
  return screen.getByRole('button', { name })
}

describe('LoginPage SSO methods', () => {
  beforeEach(() => {
    sessionStorage.clear()
    useOauthConfigMock.mockReset()
    mockLocation('https://a2wave.test/login')
  })

  it('renders methods horizontally with short labels in the configured order', () => {
    useOauthConfigMock.mockReturnValue({
      data: {
        enabled: true,
        methods: [
          { type: 'oidc', loginUrl: OIDC_LOGIN_URL },
          { type: 'saml', loginUrl: SAML_LOGIN_URL },
        ],
      },
    })

    renderWithProviders(<LoginPage />, { routerProps: { initialEntries: ['/login'] } })

    // 多方式：短标签、并排 2 列
    const oidcButton = ssoButton(oidcShort)
    const samlButton = ssoButton(samlShort)

    // Order follows the methods array
    expect(oidcButton.compareDocumentPosition(samlButton)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(oidcButton.parentElement?.className).toContain('grid-cols-2')
  })

  it('oidc / saml buttons do a full-page redirect to the server loginUrl', async () => {
    const user = userEvent.setup()
    useOauthConfigMock.mockReturnValue({
      data: {
        enabled: true,
        methods: [
          { type: 'oidc', loginUrl: OIDC_LOGIN_URL },
          { type: 'saml', loginUrl: SAML_LOGIN_URL },
        ],
      },
    })

    renderWithProviders(<LoginPage />, { routerProps: { initialEntries: ['/login'] } })

    // 2 方式：并排 2 列短标签卡
    const oidcButton = ssoButton(oidcShort)
    expect(oidcButton.parentElement?.className).toContain('grid-cols-2')

    await user.click(oidcButton)
    expect(window.location.href).toBe(OIDC_LOGIN_URL)

    mockLocation('https://a2wave.test/login')
    await user.click(ssoButton(samlShort))
    expect(window.location.href).toBe(SAML_LOGIN_URL)
  })

  it('renders no SSO block when the response carries no methods', () => {
    useOauthConfigMock.mockReturnValue({ data: { enabled: true } })

    renderWithProviders(<LoginPage />, { routerProps: { initialEntries: ['/login'] } })

    expect(screen.queryByRole('button', { name: oidcLabel })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: samlLabel })).not.toBeInTheDocument()
  })

  it('renders no SSO block when there is no method, and autofocuses the username input', () => {
    useOauthConfigMock.mockReturnValue({
      data: { enabled: true, methods: [] },
    })

    renderWithProviders(<LoginPage />, { routerProps: { initialEntries: ['/login'] } })

    expect(screen.queryByRole('button', { name: oidcLabel })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: samlLabel })).not.toBeInTheDocument()
    expect(screen.queryByText(i18n.t('auth.orDivider'))).not.toBeInTheDocument()
    expect(document.getElementById('login-username')).toHaveFocus()
  })

  it('uses theme-aware semantic colors for the public login brand panel', () => {
    useOauthConfigMock.mockReturnValue({
      data: { enabled: true, methods: [] },
    })

    renderWithProviders(<LoginPage />, { routerProps: { initialEntries: ['/login'] } })

    const panel = screen.getByTestId('login-brand-panel')
    expect(panel).toHaveClass('login-brand-panel', 'text-brand-panel-foreground')
    expect(panel).not.toHaveAttribute('style')
    expect(within(panel).getByRole('heading', { level: 1, name: i18n.t('app.name') })).toHaveClass(
      'text-brand-panel-foreground',
    )
    expect(within(panel).getByText(i18n.t('app.subtitle'))).toHaveClass(
      'text-brand-panel-muted-foreground',
    )
    expect(within(panel).getByText(i18n.t('app.tagline'))).toHaveClass(
      'text-brand-panel-muted-foreground',
    )
  })

  it('does not autofocus the username input when an SSO method exists', () => {
    useOauthConfigMock.mockReturnValue({
      data: { enabled: true, methods: [{ type: 'oidc', loginUrl: OIDC_LOGIN_URL }] },
    })

    renderWithProviders(<LoginPage />, { routerProps: { initialEntries: ['/login'] } })

    expect(document.getElementById('login-username')).not.toHaveFocus()
  })

  it('hides SSO buttons when oauth is disabled even if methods are present', () => {
    useOauthConfigMock.mockReturnValue({
      data: {
        enabled: false,
        reason: 'OAUTH_DISABLED_BY_ADMIN',
        methods: [{ type: 'oidc', loginUrl: OIDC_LOGIN_URL }],
      },
    })

    renderWithProviders(<LoginPage />, { routerProps: { initialEntries: ['/login'] } })

    expect(screen.queryByRole('button', { name: oidcLabel })).not.toBeInTheDocument()
  })

  // On a cold start /auth/oauth/config may not be ready, leaving data undefined —
  // indistinguishable from "OAuth is disabled". Rendering that as "no SSO" gives
  // the user a login page that silently lost its enterprise entry until reload.
  it('shows a placeholder instead of "no SSO" while the oauth config is still loading', () => {
    useOauthConfigMock.mockReturnValue({ data: undefined, isLoading: true })

    renderWithProviders(<LoginPage />, { routerProps: { initialEntries: ['/login'] } })

    expect(screen.getByTestId('sso-methods-loading')).toBeInTheDocument()
    // Password login must not be blocked by the placeholder; they are independent.
    expect(document.getElementById('login-username')).toBeInTheDocument()
  })

  it('renders SSO buttons once a slow oauth config finally resolves', async () => {
    useOauthConfigMock.mockReturnValue({ data: undefined, isLoading: true })
    const { rerender } = renderWithProviders(<LoginPage />, {
      routerProps: { initialEntries: ['/login'] },
    })
    expect(screen.getByTestId('sso-methods-loading')).toBeInTheDocument()

    useOauthConfigMock.mockReturnValue({
      data: { enabled: true, methods: [{ type: 'oidc', loginUrl: OIDC_LOGIN_URL }] },
      isLoading: false,
    })
    rerender(<LoginPage />)

    await waitFor(() => {
      expect(ssoButton(oidcLabel)).toBeInTheDocument()
    })
    expect(screen.queryByTestId('sso-methods-loading')).not.toBeInTheDocument()
  })

  // autoFocus only acts at mount. Gating it on a value that is false at mount
  // and flips later means React never applies it — a password-only deployment
  // silently lost its username focus.
  it('focuses the username input once a no-SSO config resolves', async () => {
    useOauthConfigMock.mockReturnValue({ data: undefined, isLoading: true })
    const { rerender } = renderWithProviders(<LoginPage />, {
      routerProps: { initialEntries: ['/login'] },
    })
    useOauthConfigMock.mockReturnValue({
      data: { enabled: true, methods: [] },
      isLoading: false,
    })
    rerender(<LoginPage />)

    await waitFor(() => expect(document.getElementById('login-username')).toHaveFocus())
  })

  // retry exhaustion leaves isLoading=false with no data — indistinguishable
  // from "OAuth is off" unless we say so, which is how the entry point went
  // missing in the first place.
  it('says the config could not be loaded instead of implying SSO is off', () => {
    useOauthConfigMock.mockReturnValue({ data: undefined, isLoading: false, isError: true })
    renderWithProviders(<LoginPage />, { routerProps: { initialEntries: ['/login'] } })
    expect(screen.getByText(/无法加载登录方式/)).toBeInTheDocument()
  })

  it('shows a translated error bar for ?ssoError=<code> and strips it from the URL', async () => {
    mockLocation('https://a2wave.test/login?ssoError=SSO_FLOW_EXPIRED')
    const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {})
    useOauthConfigMock.mockReturnValue({
      data: { enabled: true, methods: [{ type: 'oidc', loginUrl: OIDC_LOGIN_URL }] },
    })

    renderWithProviders(<LoginPage />, {
      routerProps: { initialEntries: ['/login?ssoError=SSO_FLOW_EXPIRED'] },
    })

    expect(screen.getByText(i18n.t('auth.ssoError.SSO_FLOW_EXPIRED'))).toBeInTheDocument()
    await waitFor(() => expect(replaceState).toHaveBeenCalledWith(null, '', '/login'))
  })

  it('falls back to the GENERIC message for unknown ssoError codes', () => {
    mockLocation('https://a2wave.test/login?ssoError=SOMETHING_NEW')
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {})
    useOauthConfigMock.mockReturnValue({
      data: { enabled: true, methods: [{ type: 'oidc', loginUrl: OIDC_LOGIN_URL }] },
    })

    renderWithProviders(<LoginPage />, {
      routerProps: { initialEntries: ['/login?ssoError=SOMETHING_NEW'] },
    })

    expect(screen.getByText(i18n.t('auth.ssoError.GENERIC'))).toBeInTheDocument()
  })
})
