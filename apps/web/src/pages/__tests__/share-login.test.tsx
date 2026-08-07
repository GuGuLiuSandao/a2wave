import i18n from '@/i18n'
import { renderWithProviders, screen, waitFor } from '@/test/render'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ShareLoginPage } from '../share-login'

const { useOauthConfigMock } = vi.hoisted(() => ({
  useOauthConfigMock: vi.fn(),
}))

vi.mock('@/hooks/use-auth', () => ({
  useOauthConfig: () => useOauthConfigMock(),
}))

const OIDC_LOGIN_URL = '/api/auth/oidc/login'

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

describe('ShareLoginPage', () => {
  beforeEach(() => {
    sessionStorage.clear()
    useOauthConfigMock.mockReset()
    mockLocation('https://a2wave.test/share-login?returnTo=/s/abc')
  })

  it('OIDC-only 部署：以 purpose=share 全页跳到服务端 loginUrl，带 returnTo', async () => {
    useOauthConfigMock.mockReturnValue({
      isLoading: false,
      data: {
        enabled: true,
        methods: [{ type: 'oidc', loginUrl: OIDC_LOGIN_URL }],
      },
    })

    renderWithProviders(<ShareLoginPage />, {
      routerProps: { initialEntries: ['/share-login?returnTo=/s/abc'] },
    })

    await waitFor(() => {
      expect(window.location.href).toBe('/api/auth/oidc/login?purpose=share&returnTo=%2Fs%2Fabc')
    })
  })

  it('无任何 SSO 方式：显示 ssoDisabled 错误，不跳转', () => {
    useOauthConfigMock.mockReturnValue({ isLoading: false, data: { enabled: false } })
    const before = window.location.href

    renderWithProviders(<ShareLoginPage />, {
      routerProps: { initialEntries: ['/share-login?returnTo=/s/abc'] },
    })

    expect(screen.getByText(i18n.t('shareLogin.ssoDisabled'))).toBeInTheDocument()
    expect(window.location.href).toBe(before)
  })

  it('非法 returnTo（非 /s/）：显示 badReturn 错误', () => {
    mockLocation('https://a2wave.test/share-login?returnTo=/agents')
    useOauthConfigMock.mockReturnValue({
      isLoading: false,
      data: { enabled: true, methods: [{ type: 'oidc', loginUrl: OIDC_LOGIN_URL }] },
    })

    renderWithProviders(<ShareLoginPage />, {
      routerProps: { initialEntries: ['/share-login?returnTo=/agents'] },
    })

    expect(screen.getByText(i18n.t('shareLogin.badReturn'))).toBeInTheDocument()
  })
})
