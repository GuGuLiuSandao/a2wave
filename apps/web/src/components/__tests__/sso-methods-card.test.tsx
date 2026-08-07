import type { SsoStatus } from '@/hooks/use-settings'
import { renderWithProviders, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SsoMethodsCard } from '../sso-methods-card'

const mutate = vi.fn()
const testMutate = vi.fn()

const status: SsoStatus = {
  oidc: {
    configured: true,
    enabled: true,
    source: 'env',
    issuer: 'https://idp.example.com/',
    clientId: 'a2wave',
    scopes: '',
    clientSecretSet: false,
    redirectUri: 'https://a2wave.test/api/auth/oidc/callback',
    callbackOrigin: '',
  },
  saml: {
    configured: false,
    enabled: false,
    source: null,
    entryPoint: null,
    spEntityId: null,
    certPresent: false,
    acsUrl: 'https://a2wave.test/api/auth/saml/acs',
    metadataUrl: 'https://a2wave.test/api/auth/saml/metadata',
    callbackOrigin: '',
  },
}

const rawSettings: Record<string, string> = {}

vi.mock('@/hooks/use-settings', () => ({
  useSsoStatus: () => ({ data: status, isLoading: false }),
  useSsoTest: () => ({ mutate: testMutate, isPending: false, data: undefined }),
  // 保存与开关切换各用一个 useUpdateSso 实例，测试里共用同一个 mutate spy 断言调用即可
  useUpdateSso: () => ({ mutate, isPending: false }),
}))

vi.mock('@/lib/api', () => ({
  api: { get: () => Promise.resolve({ data: rawSettings }) },
}))

describe('SsoMethodsCard', () => {
  beforeEach(() => {
    mutate.mockClear()
    testMutate.mockClear()
    for (const k of Object.keys(rawSettings)) delete rawSettings[k]
  })

  it('renders both method panels with status badges reflecting configured state', () => {
    renderWithProviders(<SsoMethodsCard />)
    // OIDC 已配置且启用 → 绿色「已启用」（不含来源），SAML 未配置
    expect(screen.getByText('OIDC（授权码 + PKCE）')).toBeInTheDocument()
    expect(screen.getByText('SAML 2.0')).toBeInTheDocument()
    expect(screen.getAllByText((_c, el) => el?.textContent === '已启用')).not.toHaveLength(0)
    expect(screen.getAllByText('未配置').length).toBe(1)
  })

  it('uses semantic tokens for the selected SSO method card', () => {
    renderWithProviders(<SsoMethodsCard />)
    const selectedMethod = screen.getByRole('tab', { name: /OIDC/ })

    expect(selectedMethod.className).not.toMatch(/rgb|indigo|violet/)
    expect(selectedMethod).toHaveClass('data-[state=active]:ring-primary/15')
  })

  it('assembles the OIDC PATCH body and only includes the secret when typed', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SsoMethodsCard />)

    // 展开 OIDC 面板
    await user.click(screen.getByText('OIDC（授权码 + PKCE）'))

    const issuer = await screen.findByPlaceholderText('https://login.example.com/realms/acme')
    await user.type(issuer, 'https://idp.example.com')
    // clientId 是唯一无占位符的必填框：按 label 定位其后的 input 较脆，用 role 取第 2 个文本框
    const inputs = screen.getAllByRole('textbox')
    // issuer + clientId + scopes（顺序按 DOM）——clientId 是 issuer 之后第一个空的
    const clientId = inputs.find((el) => el !== issuer && (el as HTMLInputElement).value === '')
    if (clientId) await user.type(clientId, 'a2wave-client')

    // 先不填 secret 保存 → PATCH 不含 oidcClientSecret
    const saveBtns = screen.getAllByRole('button', { name: '保存' })
    await user.click(saveBtns[saveBtns.length - 1])

    await waitFor(() => expect(mutate).toHaveBeenCalled())
    const firstBody = mutate.mock.calls[0][0].sso
    expect(firstBody.oidcConfig).toBeTruthy()
    expect(JSON.parse(firstBody.oidcConfig)).toMatchObject({
      issuer: 'https://idp.example.com',
      clientId: 'a2wave-client',
    })
    expect(firstBody).not.toHaveProperty('oidcClientSecret')

    // 填 secret 再保存 → PATCH 含明文 oidcClientSecret（服务端加密）
    const secret = screen.getByPlaceholderText('留空 = 公共客户端（PKCE）')
    await user.type(secret, 's3cret')
    await user.click(saveBtns[saveBtns.length - 1])
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2))
    expect(mutate.mock.calls[1][0].sso.oidcClientSecret).toBe('s3cret')
  })

  it('shows a validation error and does not PATCH when required fields are missing', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SsoMethodsCard />)
    await user.click(screen.getByText('SAML 2.0'))
    // 不填任何字段直接保存
    const saveBtns = screen.getAllByRole('button', { name: '保存' })
    await user.click(saveBtns[saveBtns.length - 1])
    expect(await screen.findByText('IdP SSO 入口必填')).toBeInTheDocument()
    expect(mutate).not.toHaveBeenCalled()
  })

  it('exposes IdP registration URLs to copy (redirect/ACS/metadata)', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SsoMethodsCard />)
    await user.click(screen.getByText('SAML 2.0'))
    expect(await screen.findByText('https://a2wave.test/api/auth/saml/acs')).toBeInTheDocument()
    expect(screen.getByText('https://a2wave.test/api/auth/saml/metadata')).toBeInTheDocument()
  })

  it('triggers a connectivity test for the opened method', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SsoMethodsCard />)
    await user.click(screen.getByText('OIDC（授权码 + PKCE）'))
    await user.click(await screen.findByRole('button', { name: '测试' }))
    expect(testMutate).toHaveBeenCalledWith('oidc')
  })

  it('shows the env-source hint and clears config for the env-provided method', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SsoMethodsCard />)
    // OIDC 默认选中（水平方式选择的第一张），来源 env → 提示可见
    expect(screen.getByText('当前由环境变量提供配置；在此保存后将以设置为准。')).toBeInTheDocument()
    // 清除走二次确认：点「清除配置」不立即 PATCH（弹确认框，需再确认）
    await user.click(screen.getByRole('button', { name: '清除配置' }))
    expect(mutate).not.toHaveBeenCalled()
  })

  it('toggles the enabled flag by re-patching the config with enabled flipped', async () => {
    const user = userEvent.setup()
    // OIDC 需为 settings 来源（env 来源开关 disabled 不可切），且配置齐全可 build
    rawSettings.oidcConfig = JSON.stringify({
      enabled: true,
      issuer: 'https://idp.example.com/',
      clientId: 'a2wave',
      scopes: '',
    })
    status.oidc.source = 'settings'
    renderWithProviders(<SsoMethodsCard />)

    // The form backfills from rawSettings in a useEffect AFTER mount, and
    // toggleEnabled only mutates when the rebuilt config is valid. Clicking
    // before that backfill lands means build fails and NO mutation ever fires —
    // so a longer waitFor cannot help. Wait for a backfilled field to appear,
    // which is the observable signal that the effect has run.
    // Generous budgets on both waits. The ordering above is the actual fix —
    // a click landing before the backfill fires no mutation at all, so no
    // timeout could have helped — but this test forced two bumps on the shared
    // runner already (1s → 5s → 15s) and `test` is now blocking. A slow jsdom
    // mount must not fail an unrelated MR with an error indistinguishable from
    // the race just fixed.
    const issuer = await screen.findByDisplayValue('https://idp.example.com/', undefined, {
      timeout: 15000,
    })
    expect(issuer).toBeInTheDocument()

    // 关闭启用开关 → PATCH 一份 enabled=false 的同配置
    const toggle = screen.getByRole('switch')
    await user.click(toggle)
    await waitFor(() => expect(mutate).toHaveBeenCalled(), { timeout: 15000 })
    const patched = JSON.parse(mutate.mock.calls[0][0].sso.oidcConfig)
    expect(patched.enabled).toBe(false)
    expect(patched.issuer).toBe('https://idp.example.com/')
    status.oidc.source = 'env' // 复位，避免影响其它用例
  })
})
