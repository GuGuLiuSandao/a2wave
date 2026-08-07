/**
 * completeSsoLogin 的身份匹配策略测试，聚焦跨 SSO 方式归并：
 * 同一企业用户经不同协议登录时 sub 形态不同（JWT 直传 = 邮箱、OIDC/SAML = 用户名），
 * idaasSub 未命中时须按 IdP 已验证邮箱归并到现有 SSO 账号，而不是撞 email
 * 唯一索引后 500；email 属于本地密码账号时拒绝并返回结构化 EMAIL_ALREADY_BOUND。
 */
import type { Context } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}))

vi.mock('../../db/schema.js', () => ({
  users: {
    id: 'id',
    username: 'username',
    email: 'email',
    idaasSub: 'idaas_sub',
    idaasIssuer: 'idaas_issuer',
    isActive: 'is_active',
  },
}))

vi.mock('../../lib/audit.js', () => ({ logAudit: vi.fn() }))
vi.mock('../audit.js', () => ({ logAudit: vi.fn() }))

vi.mock('../auth.js', () => ({
  signToken: vi.fn(async () => 'a2w_token_xyz'),
}))

vi.mock('../auth-cookie.js', () => ({ setAuthCookie: vi.fn() }))

const mockLoadAuthSettings = vi.fn()
vi.mock('../auth-settings.js', () => ({
  loadAuthSettings: () => mockLoadAuthSettings(),
  isEmailDomainAllowed: (email: string, allowed: string[]) => {
    if (allowed.length === 0) return true
    const at = email.lastIndexOf('@')
    return at >= 0 && allowed.includes(email.slice(at + 1).toLowerCase())
  },
}))

vi.mock('../id.js', () => ({
  createId: (prefix: string) => `${prefix}_test123`,
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const mockSetShareViewerCookie = vi.hoisted(() => vi.fn())
vi.mock('../share-viewer-cookie.js', () => ({
  setShareViewerCookie: mockSetShareViewerCookie,
}))

import { db } from '../../db/client.js'
import { asyncQuery } from '../../test/async-query.js'
import { AUDIT_ACTIONS } from '../audit-actions.js'
import { logAudit } from '../audit.js'
import {
  completeSsoLogin,
  completeSsoShareAccess,
  isSafeSharePath,
  loopbackOriginFromReferer,
  sanitizeReturnTarget,
  sanitizeReturnTo,
} from '../sso-login.js'

const mockDb = db as unknown as {
  select: ReturnType<typeof vi.fn>
  insert: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
}

/** Capture what update().set() was called with; the chain is set().where().run(). */
function captureUpdateSets(): Record<string, unknown>[] {
  const sets: Record<string, unknown>[] = []
  mockDb.update.mockImplementation(() => ({
    set: (values: Record<string, unknown>) => {
      sets.push(values)
      return { where: () => ({ run: () => {} }) }
    },
  }))
  return sets
}

const POLICY = {
  oauthEnabled: true,
  allowedEmailDomains: [] as string[],
  defaultRole: 'user',
  oauthAutoProvision: true,
  passwordLoginEnabled: true,
}

/** select().from().where().get() 链：依序返回 returns 中的值。 */
function selectSequence(returns: unknown[]) {
  let i = 0
  mockDb.select.mockImplementation(() =>
    asyncQuery({
      from: () =>
        asyncQuery({
          where: () =>
            asyncQuery({
              get: () => returns[Math.min(i++, returns.length - 1)],
            }),
        }),
    }),
  )
}

function fakeContext(): Context {
  return { req: { header: () => undefined } } as unknown as Context
}

const SSO_USER = {
  id: 'usr_existing',
  username: 'johndoe',
  displayName: 'John Doe',
  email: 'johndoe@example.com',
  idaasSub: 'johndoe@example.com', // JWT 直传首登时以邮箱为 sub
  idaasIssuer: 'https://idp', // 绑定所属 IdP：跨方式归并须 issuer 一致
  passwordHash: null,
  role: 'admin',
  isActive: true,
  tokenVersion: 0,
}

const LOCAL_USER = {
  ...SSO_USER,
  id: 'usr_local',
  idaasSub: null,
  passwordHash: 'argon2-hash',
}

describe('completeSsoLogin 跨 SSO 方式身份归并', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadAuthSettings.mockReturnValue(POLICY)
    mockDb.insert.mockReturnValue({ values: () => ({ run: () => {} }) })
    captureUpdateSets()
  })

  it('idaasSub 命中时直接登录（原行为不变）', async () => {
    selectSequence([SSO_USER])
    const outcome = await completeSsoLogin(
      fakeContext(),
      { sub: 'johndoe@example.com', email: 'johndoe@example.com', issuer: 'https://idp' },
      'exchange',
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.user.id).toBe('usr_existing')
  })

  it('backfills idaas_protocol on a legacy row whose (issuer, sub) matched', async () => {
    const sets = captureUpdateSets()
    selectSequence([{ ...SSO_USER, idaasProtocol: null }])

    const outcome = await completeSsoLogin(
      fakeContext(),
      { sub: 'johndoe@example.com', email: 'johndoe@example.com', issuer: 'https://idp' },
      'saml',
    )

    expect(outcome.ok).toBe(true)
    expect(sets).toHaveLength(1)
    expect(sets[0]).toMatchObject({ idaasProtocol: 'saml' })
    if (outcome.ok) expect(outcome.user.idaasProtocol).toBe('saml')
  })

  it('leaves an already-recorded idaas_protocol untouched', async () => {
    const sets = captureUpdateSets()
    selectSequence([{ ...SSO_USER, idaasProtocol: 'oidc' }])

    await completeSsoLogin(
      fakeContext(),
      { sub: 'johndoe@example.com', email: 'johndoe@example.com', issuer: 'https://idp' },
      'oidc',
    )

    expect(sets).toHaveLength(0)
  })

  it('does NOT relabel an already-recorded protocol when matched by email', async () => {
    // Alternate-method login: the row already records 'saml', so an incoming OIDC
    // login must not rewrite it — the binding would flip on every other login.
    const sets = captureUpdateSets()
    selectSequence([undefined, { ...SSO_USER, idaasProtocol: 'saml' }])

    const outcome = await completeSsoLogin(
      fakeContext(),
      { sub: 'oidc-sub-123', email: 'johndoe@example.com', issuer: 'https://idp' },
      'oidc',
    )

    expect(outcome.ok).toBe(true)
    expect(sets).toHaveLength(0)
  })

  it('backfills idaas_protocol on a legacy row reached via the email merge', async () => {
    // Regression: a row predating the current IdP's `sub` claim (stored sub is the
    // email, issuer NULL) never matches by (issuer, sub), so it merges by email on
    // EVERY login. The backfill used to be gated on an identity match, leaving such
    // rows NULL forever and the UI badge stuck on the generic "SSO" glyph.
    const sets = captureUpdateSets()
    selectSequence([
      undefined,
      { ...SSO_USER, idaasIssuer: null, idaasSub: 'johndoe@example.com', idaasProtocol: null },
    ])

    const outcome = await completeSsoLogin(
      fakeContext(),
      { sub: 'johndoe', email: 'johndoe@example.com', issuer: 'https://idp' },
      'oidc',
    )

    expect(outcome.ok).toBe(true)
    expect(sets).toHaveLength(1)
    expect(sets[0]).toMatchObject({ idaasProtocol: 'oidc' })
    // The merge must still not rewrite the stored identity — only the protocol.
    expect(sets[0]).not.toHaveProperty('idaasSub')
    expect(sets[0]).not.toHaveProperty('idaasIssuer')
    if (outcome.ok) expect(outcome.user.idaasProtocol).toBe('oidc')
  })

  it('does NOT write to a disabled account before rejecting it', async () => {
    // The backfill must sit behind the isActive gate: writing first bumped
    // users.updatedAt on every rejected login and mutated a row on a path whose
    // only audit entry says the login FAILED.
    const sets = captureUpdateSets()
    selectSequence([{ ...SSO_USER, idaasProtocol: null, isActive: false }])

    const outcome = await completeSsoLogin(
      fakeContext(),
      { sub: 'johndoe@example.com', email: 'johndoe@example.com', issuer: 'https://idp' },
      'oidc',
    )

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toBe('ACCOUNT_DISABLED')
    expect(sets).toHaveLength(0)
  })

  it('身份查询按 (issuer, sub) 复合键，不同 IdP 的同 sub 不会命中他人账号', async () => {
    // 记录首个身份查询的 where 参数：必须同时带 issuer 与 sub（而非仅 sub），
    // 否则第二个 IdP 的相同 sub 会直接命中第一个账号（跨 IdP 接管）。
    const whereCalls: unknown[] = []
    let call = 0
    mockDb.select.mockImplementation(() =>
      asyncQuery({
        from: () =>
          asyncQuery({
            where: (cond: unknown) => {
              whereCalls.push(cond)
              // 首查（身份）未命中、次查（email）也未命中 → 不归并（异 IdP 异人）
              const idx = call++
              return asyncQuery({ get: () => (idx <= 1 ? undefined : undefined) })
            },
          }),
      }),
    )
    mockLoadAuthSettings.mockReturnValue({ ...POLICY, oauthAutoProvision: false })

    const outcome = await completeSsoLogin(
      fakeContext(),
      { sub: 'shared-sub', email: 'attacker@example.com', issuer: 'https://evil-idp' },
      'oidc',
    )
    // 未开自动开户 + 未命中 → 明确拒绝，绝不落到他人账号
    expect(outcome.ok).toBe(false)
    // 首个身份查询的 where 条件里应出现 issuer 值（复合键证据）
    expect(JSON.stringify(whereCalls[0])).toContain('https://evil-idp')
    expect(JSON.stringify(whereCalls[0])).toContain('shared-sub')
  })

  it('idaasSub 未命中但邮箱命中现有 SSO 账号（idaasSub 非空）→ 归并登录', async () => {
    // 第一次查 idaasSub 未命中，第二次按 email 命中 SSO 账号
    selectSequence([undefined, SSO_USER])
    const outcome = await completeSsoLogin(
      fakeContext(),
      { sub: 'johndoe', email: 'johndoe@example.com', issuer: 'https://idp' },
      'saml',
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.user.id).toBe('usr_existing')
    // 归并须留审计痕迹——但记在登录那一条上，不额外记一条。
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: AUDIT_ACTIONS.AUTH_OAUTH_LOGIN,
        details: expect.objectContaining({ matchedBy: 'email' }),
      }),
    )
  })

  it('跨协议归并登录只写一条审计（登录），不写 USER_LINKED', async () => {
    // 归并不写库：登录路径每次都会重新按邮箱匹配（三种协议 sub 形态不同，
    // 精确键必然不命中）。若这里记 USER_LINKED，每次登录都会重复一条，且与
    // bind 流程「一次性真正写库」的语义混淆——后者才是真正的关联事件。
    selectSequence([undefined, SSO_USER])
    const outcome = await completeSsoLogin(
      fakeContext(),
      { sub: 'johndoe', email: 'johndoe@example.com', issuer: 'https://idp' },
      'oidc',
    )
    expect(outcome.ok).toBe(true)

    const actions = vi.mocked(logAudit).mock.calls.map(([, entry]) => entry.action)
    expect(actions).not.toContain(AUDIT_ACTIONS.AUTH_OAUTH_USER_LINKED)
    expect(actions.filter((a) => a === AUDIT_ACTIONS.AUTH_OAUTH_LOGIN)).toHaveLength(1)
    // 这里的 fixture 未记录 protocol，因此本次登录会额外补写一条 PROTOCOL_BACKFILLED。
    // 该补写是一次性的（`!idaasProtocol` 守卫），不违背「归并不重复记账」的本意，
    // 故按动作种类断言，而不是笼统地断言总条数。
    expect(new Set(actions)).toEqual(
      new Set([AUDIT_ACTIONS.AUTH_OAUTH_LOGIN, AUDIT_ACTIONS.AUTH_OAUTH_PROTOCOL_BACKFILLED]),
    )
  })

  it('邮箱命中现有 SSO 账号且 issuer 不同（同一企业 IdP 的不同协议）→ 归并登录并审计双方 issuer', async () => {
    // 同一企业 IdP 三种协议的 issuer 字符串天然不同（JWT 直传 = 根地址、
    // OIDC = discovery issuer、SAML = 断言 entityID），issuer 精确匹配会让
    // 跨协议归并必然失败。既然三种方式都由管理员在「企业登录」里配置且都过验签，
    // 归并放行、issuer 仅入审计。
    selectSequence([undefined, SSO_USER])
    const outcome = await completeSsoLogin(
      fakeContext(),
      { sub: 'johndoe', email: 'johndoe@example.com', issuer: 'a2wave-idp' },
      'saml',
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.user.id).toBe('usr_existing')
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: AUDIT_ACTIONS.AUTH_OAUTH_LOGIN,
        details: expect.objectContaining({
          boundIssuer: 'https://idp',
          issuer: 'a2wave-idp',
        }),
      }),
    )
  })

  it('邮箱命中历史 SSO 账号（idaasIssuer 为空）→ 归并登录', async () => {
    // idaas_issuer 列是后加的，存量 SSO 账号该列为 null，不得因此拒绝登录
    selectSequence([undefined, { ...SSO_USER, idaasIssuer: null }])
    const outcome = await completeSsoLogin(
      fakeContext(),
      { sub: 'johndoe', email: 'johndoe@example.com', issuer: 'https://idp' },
      'oidc',
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.user.id).toBe('usr_existing')
  })

  it('邮箱命中本地密码账号（idaasSub 为空）→ 403 EMAIL_ALREADY_BOUND，不再 500', async () => {
    selectSequence([undefined, LOCAL_USER])
    const outcome = await completeSsoLogin(
      fakeContext(),
      { sub: 'johndoe', email: 'johndoe@example.com', issuer: 'https://idp' },
      'oidc',
    )
    expect(outcome).toEqual({ ok: false, error: 'EMAIL_ALREADY_BOUND', status: 403 })
  })

  it('归并登录须尊重停用状态', async () => {
    selectSequence([undefined, { ...SSO_USER, isActive: false }])
    const outcome = await completeSsoLogin(
      fakeContext(),
      { sub: 'johndoe', email: 'johndoe@example.com', issuer: 'https://idp' },
      'saml',
    )
    expect(outcome).toEqual({ ok: false, error: 'ACCOUNT_DISABLED', status: 403 })
  })

  it('邮箱也未命中且开了自动开户 → 照常 provision 新用户', async () => {
    // idaasSub 未命中 → email 未命中 → pickUsername 查重（未命中）→ insert → 回读新行
    const newUser = { ...SSO_USER, id: 'usr_test123', idaasSub: 'newbie', email: 'new@example.com' }
    selectSequence([undefined, undefined, undefined, newUser])
    const outcome = await completeSsoLogin(
      fakeContext(),
      { sub: 'newbie', email: 'new@example.com', issuer: 'https://idp' },
      'oidc',
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.user.id).toBe('usr_test123')
  })

  it('并发竞态下 insert 撞 email 唯一索引且无法归并 → EMAIL_ALREADY_BOUND 而非抛异常', async () => {
    // idaasSub 未命中 → email 未命中（竞态窗口）→ pickUsername ×3 → insert 每次撞唯一索引
    // → insert 失败后按 idaasSub 复查也未命中 → 三轮耗尽
    selectSequence([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    mockDb.insert.mockReturnValue({
      values: () => {
        throw new Error('UNIQUE constraint failed: users.email')
      },
    })
    const outcome = await completeSsoLogin(
      fakeContext(),
      { sub: 'raceuser', email: 'race@example.com', issuer: 'https://idp' },
      'saml',
    )
    expect(outcome).toEqual({ ok: false, error: 'EMAIL_ALREADY_BOUND', status: 403 })
  })
})

describe('loopbackOriginFromReferer（dev 双端口跳回）', () => {
  it('回环地址 referer 返回其 origin', () => {
    expect(loopbackOriginFromReferer('http://127.0.0.1:3501/login')).toBe('http://127.0.0.1:3501')
    expect(loopbackOriginFromReferer('http://localhost:3501/agents?x=1')).toBe(
      'http://localhost:3501',
    )
  })

  it('非回环 / 非 http(s) / 非法 referer 一律返回 null', () => {
    expect(loopbackOriginFromReferer('https://evil.example.com/login')).toBeNull()
    expect(loopbackOriginFromReferer('chrome-extension://abc/page.html')).toBeNull()
    expect(loopbackOriginFromReferer('not a url')).toBeNull()
    expect(loopbackOriginFromReferer(undefined)).toBeNull()
  })
})

describe('sanitizeReturnTarget（登录完成跳转目标白名单）', () => {
  it('站内相对路径原样放行，// 开头拒绝', () => {
    expect(sanitizeReturnTarget('/agents')).toBe('/agents')
    expect(sanitizeReturnTarget('//evil.example.com')).toBe('/')
    expect(sanitizeReturnTarget(null)).toBe('/')
  })

  it('仅放行回环绝对地址，其余绝对地址回落 /', () => {
    expect(sanitizeReturnTarget('http://127.0.0.1:3501/agents')).toBe(
      'http://127.0.0.1:3501/agents',
    )
    expect(sanitizeReturnTarget('http://localhost:3501/')).toBe('http://localhost:3501/')
    expect(sanitizeReturnTarget('https://evil.example.com/phish')).toBe('/')
    expect(sanitizeReturnTarget('javascript:alert(1)')).toBe('/')
  })
})

describe('sanitizeReturnTo（反斜杠 open-redirect 加固）', () => {
  it('站内单斜杠路径放行', () => {
    expect(sanitizeReturnTo('/agents')).toBe('/agents')
    expect(sanitizeReturnTo('/agents?x=1')).toBe('/agents?x=1')
  })

  it('// 与 /\\ 开头一律回落 /（浏览器会把 \\ 规范化为 /，变成协议相对地址）', () => {
    expect(sanitizeReturnTo('//evil.com')).toBe('/')
    expect(sanitizeReturnTo('/\\evil.com')).toBe('/')
    expect(sanitizeReturnTo('/\\\\evil.com')).toBe('/')
  })

  it('非 / 开头 / 空一律 /', () => {
    expect(sanitizeReturnTo('https://evil.com')).toBe('/')
    expect(sanitizeReturnTo('javascript:alert(1)')).toBe('/')
    expect(sanitizeReturnTo(null)).toBe('/')
    expect(sanitizeReturnTo(undefined)).toBe('/')
  })

  // 前缀检查跑在解析之前，而 URL 解析器会剥掉前导控制字符：`/\t/evil.example`
  // 的第二个字符是 tab（既非 / 也非 \），旧实现原样放行，浏览器却解析成
  // `https://evil.example/`。OIDC/SAML 的 returnTo 可被直接构造，是比 SPA 更直接
  // 的攻击向量——受害者走完正常 SSO 才被送到外站。
  it('前导控制字符（会被解析成外站）一律回落 /', () => {
    expect(sanitizeReturnTo('/\t/evil.example')).toBe('/')
    expect(sanitizeReturnTo('/\n/evil.example')).toBe('/')
    expect(sanitizeReturnTo('/\r/evil.example')).toBe('/')
  })

  // dot-segment 规范化后会变成协议相对地址。
  it('规范化后以 // 开头的路径一律回落 /', () => {
    expect(sanitizeReturnTo('/.//evil.com')).toBe('/')
    expect(sanitizeReturnTo('/%2e%2e//evil.com')).toBe('/')
  })

  it('百分号编码的控制字符不会被解码，仍是站内路径', () => {
    // %09 不会被解析器解码，因此这是一个真实的站内路径，不该误杀。
    expect(sanitizeReturnTo('/%09/local')).toBe('/%09/local')
  })

  it('保留 query 与 hash', () => {
    expect(sanitizeReturnTo('/agents/a1/chat_app?x=1#frag')).toBe('/agents/a1/chat_app?x=1#frag')
  })
})

describe('isSafeSharePath', () => {
  it('仅 /s/ 开头（非 /s//）为真', () => {
    expect(isSafeSharePath('/s/abc')).toBe(true)
    expect(isSafeSharePath('/s//evil.com')).toBe(false)
    expect(isSafeSharePath('/agents')).toBe(false)
    expect(isSafeSharePath('//evil.com')).toBe(false)
    expect(isSafeSharePath(null)).toBe(false)
    expect(isSafeSharePath(undefined)).toBe(false)
  })
})

describe('completeSsoShareAccess — disabled accounts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadAuthSettings.mockReturnValue(POLICY)
  })

  const identity = {
    sub: 'johndoe@example.com',
    email: 'johndoe@example.com',
    issuer: 'https://idp',
  }

  it('拒绝已被禁用的账号，不下发访客 cookie', async () => {
    selectSequence([{ ...SSO_USER, isActive: false }])
    const result = await completeSsoShareAccess(fakeContext(), identity)

    expect(result).toEqual({ ok: false, error: 'ACCOUNT_DISABLED', status: 403 })
    expect(mockSetShareViewerCookie).not.toHaveBeenCalled()
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: AUDIT_ACTIONS.AUTH_SHARE_ACCESS_DENIED,
        details: expect.objectContaining({ reason: 'ACCOUNT_DISABLED' }),
      }),
    )
  })

  it('放行仍启用的账号', async () => {
    selectSequence([SSO_USER])
    await expect(completeSsoShareAccess(fakeContext(), identity)).resolves.toEqual({ ok: true })
    expect(mockSetShareViewerCookie).toHaveBeenCalled()
  })

  it('放行本地没有账号的外部访客（分享的既有语义）', async () => {
    selectSequence([undefined])
    await expect(completeSsoShareAccess(fakeContext(), identity)).resolves.toEqual({ ok: true })
    expect(mockSetShareViewerCookie).toHaveBeenCalled()
  })
})
