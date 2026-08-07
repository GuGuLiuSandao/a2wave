/**
 * Unit tests for lib/share-viewer-cookie.ts — the「SSO 验证即可看」访客 cookie.
 * 验证：set→verify 往返通过、签名被篡改即拒、过期戳被改即拒、缺失/畸形 cookie 拒。
 * 通过真实 Hono 请求往返 Set-Cookie / Cookie，确保 getCookie/setCookie 契约一致。
 */
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../auth-cookie.js', () => ({
  isCookieSecure: vi.fn(() => false),
}))

vi.mock('../../env.js', () => ({
  env: { AUTH_SECRET: 'test-secret-for-share-viewer' },
}))

import {
  SHARE_VIEWER_COOKIE_NAME,
  isShareViewerAuthed,
  setShareViewerCookie,
} from '../share-viewer-cookie.js'

const app = new Hono()
app.get('/set', (c) => {
  setShareViewerCookie(c)
  return c.text('ok')
})
app.get('/check', (c) => c.json({ authed: isShareViewerAuthed(c) }))

/** 从 /set 响应里抽出 `a2w_share_viewer=...` 这段 cookie（去掉属性）。 */
async function freshCookie(): Promise<string> {
  const res = await app.request('/set')
  const setCookie = res.headers.get('set-cookie') ?? ''
  const m = setCookie.match(new RegExp(`${SHARE_VIEWER_COOKIE_NAME}=([^;]+)`))
  if (!m) throw new Error(`no ${SHARE_VIEWER_COOKIE_NAME} in: ${setCookie}`)
  return `${SHARE_VIEWER_COOKIE_NAME}=${m[1]}`
}

async function check(cookie: string): Promise<{ authed: boolean }> {
  const res = await app.request('/check', { headers: { cookie } })
  return (await res.json()) as { authed: boolean }
}

describe('share-viewer cookie', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('round-trips: a freshly set cookie verifies', async () => {
    expect(await check(await freshCookie())).toEqual({ authed: true })
  })

  it('rejects a missing cookie', async () => {
    expect(await check('other=1')).toEqual({ authed: false })
  })

  it('rejects a tampered signature', async () => {
    const cookie = await freshCookie()
    const tampered = cookie.slice(0, -3) + (cookie.endsWith('AAA') ? 'BBB' : 'AAA')
    expect(await check(tampered)).toEqual({ authed: false })
  })

  it('rejects when expiry is changed (exp is signed)', async () => {
    const cookie = await freshCookie()
    // 把 exp 段替换成一个遥远的未来值，签名不再匹配 → 拒
    const sig = cookie.split('.')[1]
    expect(await check(`${SHARE_VIEWER_COOKIE_NAME}=9999999999.${sig}`)).toEqual({ authed: false })
  })

  it('rejects a malformed value (no dot)', async () => {
    expect(await check(`${SHARE_VIEWER_COOKIE_NAME}=garbage`)).toEqual({ authed: false })
  })

  it('rejects an expired-but-correctly-signed cookie', async () => {
    // 用假时钟把「现在」推到 cookie 过期之后；签名仍有效但 exp <= now → 拒
    const cookie = await freshCookie()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2099-01-01T00:00:00Z'))
    expect(await check(cookie)).toEqual({ authed: false })
  })
})
