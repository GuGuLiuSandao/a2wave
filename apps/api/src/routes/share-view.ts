/**
 * /s/:agentId/:shareId — 公开产物分享渲染路由
 *
 * URL 形态：/s/:agentId/:shareId —— agentId 段让外部从链接即可看出「哪个 agent
 * 生成」；无 agent 的 system run 产物用占位段 `_`。该段在路由层与 share 实际所属
 * agent 校验，不匹配一律 404（防构造误导性 URL）。
 *
 * 安全边界：
 * - 所有响应（含错误页）携带 CSP: sandbox allow-scripts，使内容成为 opaque origin，
 *   document.cookie 不可读，彻底阻断 XSS 偷 session 的路径。
 * - 密码页例外：CSP 为 sandbox allow-forms（需要表单提交，不需要 JS）。
 * - 任何 path 严禁 allow-scripts + allow-same-origin 并存。
 * - 目录文件服务做 resolve 穿越校验 + lstat 拒绝 symlink。
 * - 密码 POST 做 rate-limit（10 次/分钟/IP，反代下按真实客户端 IP）。
 * - 密码鉴权 cookie 存服务端 HMAC 签名 token（绝不下发 argon2 hash 本体）。
 * - 分享不存在/已过期/已撤销/agentId 不匹配统一返回 404（不区分原因，防枚举探测）。
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { db } from '../db/client.js'
import { agents, artifacts } from '../db/schema.js'
import { env } from '../env.js'
import { type ArtifactShareRow, getActiveShare, recordShareView } from '../lib/artifact-share.js'
import { guessMimeType } from '../lib/artifact-storage.js'
import { isCookieSecure } from '../lib/auth-cookie.js'
import { verifyPassword } from '../lib/auth.js'
import { AUTH_COOKIE_NAME, LEGACY_AUTH_COOKIE_NAME } from '../lib/auth.js'
import { logger } from '../lib/logger.js'
import { SHARE_NO_AGENT_SEGMENT } from '../lib/server-url.js'
import { authenticateSessionToken } from '../lib/session-auth.js'
import {
  type ShareMeta,
  renderDirectoryListingPage,
  renderLoginRequiredPage,
  renderMarkdownPage,
  renderNotFoundPage,
  renderPasswordPage,
} from '../lib/share-render.js'
import { isShareViewerAuthed } from '../lib/share-viewer-cookie.js'
import { rateLimit } from '../middleware/rate-limit.js'

type Ctx = Parameters<Parameters<Hono['use']>[1]>[0]

/** 内联渲染大小上限：超过此值回落为 attachment 下载，防止大文件拖垮浏览器 */
const INLINE_RENDER_MAX_BYTES = 5 * 1024 * 1024

/** 密码鉴权 cookie 有效期（秒），1 小时 */
const SHARE_AUTH_COOKIE_MAX_AGE = 60 * 60

const app = new Hono()

// -------------------------------------------------------------------
// 统一 CSP 中间件：默认 allow-scripts（内容页）
// 密码页在具体 handler 里覆盖为 allow-forms
// -------------------------------------------------------------------
app.use('*', async (c, next) => {
  await next()
  // 所有 /s/ 响应必须带 sandbox CSP；覆盖 hono/secure-headers 可能的默认值
  if (!c.res.headers.get('Content-Security-Policy')) {
    c.res.headers.set('Content-Security-Policy', 'sandbox allow-scripts')
  }
  c.res.headers.set('X-Robots-Tag', 'noindex, nofollow')
  c.res.headers.set('X-Content-Type-Options', 'nosniff')
  c.res.headers.set('Referrer-Policy', 'no-referrer')
  c.res.headers.set('Cache-Control', 'private, no-store')
})

// -------------------------------------------------------------------
// 密码提交限流：10 次/分钟/IP（防爆破）；反代下按 X-Forwarded-For 真实客户端 IP
// -------------------------------------------------------------------
const passwordRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  trustProxy: env.TRUSTED_PROXY,
  trustedProxyAddresses: env.TRUSTED_PROXY_ADDRESSES.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
})

// -------------------------------------------------------------------
// 密码鉴权 cookie：值为服务端 HMAC 签名 token，绑定 shareId + 当前密码 hash。
// passwordHash 仅作为 HMAC 输入参与签名，绝不下发到客户端；密码变更后 hash 变、
// token 自动失效。比较用 timingSafeEqual 防 timing 侧信道。
// -------------------------------------------------------------------
function shareAuthToken(shareId: string, passwordHash: string): string {
  return createHmac('sha256', env.AUTH_SECRET)
    .update(`${shareId}:${passwordHash}`)
    .digest('base64url')
}

function isSharePasswordAuthed(c: Ctx, shareId: string, passwordHash: string): boolean {
  const raw = getCookie(c, `a2w_share_${shareId}`)
  if (!raw) return false
  const expected = shareAuthToken(shareId, passwordHash)
  const a = Buffer.from(raw)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function setShareAuthCookie(c: Ctx, agentSeg: string, shareId: string, passwordHash: string): void {
  setCookie(c, `a2w_share_${shareId}`, shareAuthToken(shareId, passwordHash), {
    httpOnly: true,
    secure: isCookieSecure(),
    sameSite: 'Lax',
    path: `/s/${agentSeg}/${shareId}`,
    maxAge: SHARE_AUTH_COOKIE_MAX_AGE,
  })
}

/** 尝试从请求的 cookie / Bearer 中解析当前登录用户 ID；失败返回 null */
async function tryGetAuthUserId(c: Ctx): Promise<string | null> {
  // Dev bypass（与 auth-middleware 保持一致）
  const isDevBypass =
    env.NODE_ENV === 'development' &&
    !env.E2E_STRICT_AUTH &&
    env.AUTH_SECRET === 'dev-secret-change-me'
  if (isDevBypass) return 'usr_admin'

  const authHeader = c.req.header('Authorization')
  let token: string | undefined
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7)
  } else {
    token = getCookie(c, AUTH_COOKIE_NAME)
    if (!token && !isCookieSecure()) token = getCookie(c, LEGACY_AUTH_COOKIE_NAME)
  }
  if (!token) return null
  return (await authenticateSessionToken(token))?.id ?? null
}

type ArtifactRow = typeof artifacts.$inferSelect

interface ShareContext {
  share: ArtifactShareRow
  artifact: ArtifactRow
  agentName: string | null
}

/**
 * 取活跃分享 + 校验 URL agentId 段 + 取产物 + 解析 agent 名。
 * 任一不满足（分享失效 / agentId 不匹配 / 产物丢失）返回 null，调用方一律 404。
 */
async function loadShareContext(urlAgentId: string, shareId: string): Promise<ShareContext | null> {
  const share = await getActiveShare(shareId)
  if (!share) return null
  const artifact = (
    await db.select().from(artifacts).where(eq(artifacts.id, share.artifactId)).limit(1)
  )[0]
  if (!artifact || !existsSync(artifact.storagePath)) return null
  // URL agentId 段必须与产物实际所属 agent 一致（无 agent 用占位 `_`）
  const expectedSeg = artifact.agentId ?? SHARE_NO_AGENT_SEGMENT
  if (urlAgentId !== expectedSeg) return null
  let agentName: string | null = null
  if (artifact.agentId) {
    const row = (
      await db
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, artifact.agentId))
        .limit(1)
    )[0]
    agentName = row?.name ?? null
  }
  return { share: share, artifact, agentName }
}

/**
 * 访问控制：通过返回 null；否则返回应答（已设好 allow-forms CSP）。
 * agentSeg 用于拼密码表单 action / 登录提示，三个 handler 共用。
 */
async function enforceAccess(
  c: Ctx,
  ctx: ShareContext,
  agentSeg: string,
  shareId: string,
): Promise<Response | null> {
  const { share } = ctx
  if (share.accessLevel === 'authenticated') {
    // 两种放行：① 「SSO 验证即可看」访客 cookie（不对应任何 a2wave 用户）；
    // ② 已登录的 a2wave 用户（应用内访问时天然带 session）。任一通过即可。
    const allowed = isShareViewerAuthed(c) || (await tryGetAuthUserId(c)) !== null
    if (!allowed) {
      c.res.headers.set('Content-Security-Policy', 'sandbox allow-forms')
      const returnTo = encodeURIComponent(c.req.path)
      return c.html(renderLoginRequiredPage(`/share-login?returnTo=${returnTo}`), 401)
    }
  }
  if (share.accessLevel === 'password') {
    if (!isSharePasswordAuthed(c, shareId, share.passwordHash ?? '')) {
      c.res.headers.set('Content-Security-Policy', 'sandbox allow-forms')
      return c.html(renderPasswordPage(`/s/${agentSeg}/${shareId}/auth`, false), 401)
    }
  }
  return null
}

/** 构建目录内文件列表（递归扁平，relativePath 相对 baseDir，用于清单页链接） */
function listDirFiles(
  dirPath: string,
  baseDir: string,
): Array<{ name: string; relativePath: string }> {
  const result: Array<{ name: string; relativePath: string }> = []
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) continue
      const rel = prefix ? `${prefix}/${entry}` : entry
      if (stat.isDirectory()) {
        walk(full, rel)
      } else if (stat.isFile()) {
        result.push({ name: rel, relativePath: rel })
      }
    }
  }
  // 子目录清单时 relativePath 需带上相对 baseDir 的前缀
  const startPrefix = relative(baseDir, dirPath).split(sep).filter(Boolean).join('/')
  walk(dirPath, startPrefix)
  return result
}

/** 原样内联 HTML 文件（用户产物，不注入任何横幅） */
function serveHtmlInline(c: Ctx, filePath: string) {
  return c.html(readFileSync(filePath, 'utf-8'))
}

/** attachment 下载（RFC 5987 文件名编码，支持中文） */
function serveAttachment(filePath: string, filename: string, mime: string): Response {
  const data = readFileSync(filePath)
  const encodedName = encodeURIComponent(filename)
  return new Response(new Uint8Array(data), {
    headers: {
      'Content-Type': mime,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodedName}`,
      'Content-Length': String(data.length),
    },
  })
}

// -------------------------------------------------------------------
// GET /:agentId/:shareId — 主入口
// -------------------------------------------------------------------
app.get('/:agentId/:shareId', async (c) => {
  const { agentId: urlAgentId, shareId } = c.req.param()
  const ctx = await loadShareContext(urlAgentId, shareId)
  if (!ctx) return c.html(renderNotFoundPage(), 404)

  const denied = await enforceAccess(c, ctx, urlAgentId, shareId)
  if (denied) return denied

  const { artifact, agentName } = ctx

  // 目录产物：302 到尾斜杠，让相对资源在 share 前缀下解析（交由 /* handler 计数+渲染）
  if (artifact.kind === 'directory') {
    return c.redirect(`/s/${urlAgentId}/${shareId}/`, 302)
  }

  recordShareView(shareId)

  // 单文件产物
  const mime = artifact.mimeType ?? guessMimeType(artifact.filename)
  const stat = lstatSync(artifact.storagePath)

  if ((mime === 'text/html' || mime === 'text/markdown') && stat.size <= INLINE_RENDER_MAX_BYTES) {
    if (mime === 'text/html') {
      return serveHtmlInline(c, artifact.storagePath)
    }
    const meta: ShareMeta = { agentName, rawHref: `/s/${urlAgentId}/${shareId}/raw` }
    return c.html(
      renderMarkdownPage(artifact.filename, readFileSync(artifact.storagePath, 'utf-8'), meta),
    )
  }

  return serveAttachment(artifact.storagePath, artifact.filename, mime)
})

// -------------------------------------------------------------------
// GET /:agentId/:shareId/raw — 原文（text/plain）
// -------------------------------------------------------------------
app.get('/:agentId/:shareId/raw', async (c) => {
  const { agentId: urlAgentId, shareId } = c.req.param()
  const ctx = await loadShareContext(urlAgentId, shareId)
  if (!ctx) return c.html(renderNotFoundPage(), 404)

  const denied = await enforceAccess(c, ctx, urlAgentId, shareId)
  if (denied) return denied

  const { artifact } = ctx
  // 单文件直接取原文；目录回退到 index.html 源码
  let filePath = artifact.storagePath
  if (artifact.kind === 'directory') {
    const idx = join(artifact.storagePath, 'index.html')
    if (!existsSync(idx) || lstatSync(idx).isSymbolicLink()) {
      return c.html(renderNotFoundPage(), 404)
    }
    filePath = idx
  }
  const stat = lstatSync(filePath)
  if (!stat.isFile() || stat.size > INLINE_RENDER_MAX_BYTES) {
    return c.html(renderNotFoundPage(), 404)
  }
  return new Response(readFileSync(filePath, 'utf-8'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
})

// -------------------------------------------------------------------
// POST /:agentId/:shareId/auth — 密码验证表单提交
// -------------------------------------------------------------------
app.post('/:agentId/:shareId/auth', passwordRateLimit, async (c) => {
  const { agentId: urlAgentId, shareId } = c.req.param()
  c.res.headers.set('Content-Security-Policy', 'sandbox allow-forms')

  const ctx = await loadShareContext(urlAgentId, shareId)
  if (!ctx || ctx.share.accessLevel !== 'password') {
    return c.html(renderNotFoundPage(), 404)
  }
  const { share } = ctx
  const actionUrl = `/s/${urlAgentId}/${shareId}/auth`

  let password: string | undefined
  try {
    const body = await c.req.parseBody()
    password = typeof body.password === 'string' ? body.password : undefined
  } catch {
    // ignore parse error
  }

  if (!password || !share.passwordHash) {
    return c.html(renderPasswordPage(actionUrl, true), 401)
  }

  const ok = await verifyPassword(share.passwordHash, password)
  if (!ok) {
    return c.html(renderPasswordPage(actionUrl, true), 401)
  }

  setShareAuthCookie(c, urlAgentId, shareId, share.passwordHash)
  return c.redirect(`/s/${urlAgentId}/${shareId}`, 302)
})

// -------------------------------------------------------------------
// GET /:agentId/:shareId/* — 目录内文件服务（含尾斜杠目录根）
// -------------------------------------------------------------------
app.get('/:agentId/:shareId/*', async (c) => {
  const { agentId: urlAgentId, shareId } = c.req.param()
  const ctx = await loadShareContext(urlAgentId, shareId)
  if (!ctx) return c.html(renderNotFoundPage(), 404)

  const denied = await enforceAccess(c, ctx, urlAgentId, shareId)
  if (denied) return denied

  const { artifact, agentName } = ctx
  if (artifact.kind !== 'directory') {
    return c.html(renderNotFoundPage(), 404)
  }

  const prefix = `/s/${urlAgentId}/${shareId}`
  const rawSub = c.req.path.slice(`${prefix}/`.length)
  let sub: string
  try {
    sub = decodeURIComponent(rawSub)
  } catch {
    return c.html(renderNotFoundPage(), 404)
  }

  // 穿越检查
  const base = resolve(artifact.storagePath)
  const target = resolve(join(base, sub))
  if (target !== base && !target.startsWith(base + sep)) {
    logger.warn({ shareId, sub }, 'Path traversal attempt in share directory')
    return c.html(renderNotFoundPage(), 404)
  }

  if (!existsSync(target)) return c.html(renderNotFoundPage(), 404)
  const stat = lstatSync(target)
  if (stat.isSymbolicLink()) return c.html(renderNotFoundPage(), 404)

  // 目录（含尾斜杠根 sub=''）→ index.html 或文件清单
  if (stat.isDirectory()) {
    const idx = join(target, 'index.html')
    if (existsSync(idx) && !lstatSync(idx).isSymbolicLink()) {
      // 仅站点根入口记一次 view（asset / 深链不计，避免灌水）
      if (sub === '' || sub === '/') recordShareView(shareId)
      return serveHtmlInline(c, idx)
    }
    // 同 index.html 入口：仅站点根（尾斜杠）清单页记一次 view，子目录深链不计
    if (sub === '' || sub === '/') recordShareView(shareId)
    const files = listDirFiles(target, base)
    return c.html(renderDirectoryListingPage(prefix, files, artifact.filename, { agentName }))
  }
  if (!stat.isFile()) return c.html(renderNotFoundPage(), 404)

  const filename = sub.split('/').pop() ?? sub
  const mime = guessMimeType(filename)

  if (mime === 'text/markdown' && stat.size <= INLINE_RENDER_MAX_BYTES) {
    return c.html(renderMarkdownPage(filename, readFileSync(target, 'utf-8'), { agentName }))
  }
  if (mime === 'text/html' && stat.size <= INLINE_RENDER_MAX_BYTES) {
    return serveHtmlInline(c, target)
  }

  return serveAttachment(target, filename, mime)
})

export default app
