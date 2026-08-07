import { Marked } from 'marked'
/**
 * Share-page HTML templates (zero external resources, inline styles).
 * Every caller must set a CSP response header; this module only produces HTML content.
 */
import sanitizeHtml from 'sanitize-html'

const marked = new Marked()

/* Inline mirror of the global design tokens (source: apps/web/src/styles/globals.css).
   Share pages load zero external resources, so the semantic tokens are written
   directly as CSS variables for the templates to reuse. */
const BASE_STYLE = `
  :root{
    --color-background:#faf9f7;--color-foreground:#1c1917;--color-card:#ffffff;
    --color-muted:#f3f1ed;--color-muted-foreground:#78716c;--color-border:#e8e5df;
    --color-warm-300:#d4d0c8;--color-warm-400:#a8a29e;
    --color-primary:#6366f1;--color-primary-foreground:#ffffff;--color-destructive:#ef4444;
    --radius-md:0.5rem;--radius-lg:0.75rem;--radius-xl:1rem;
    --shadow-sm:0 1px 3px 0 rgb(28 25 23 / 0.04),0 1px 2px -1px rgb(28 25 23 / 0.03);
    --shadow-md:0 4px 6px -1px rgb(28 25 23 / 0.05),0 2px 4px -2px rgb(28 25 23 / 0.03);
  }
  *{box-sizing:border-box}
  body{font-family:"Inter Variable","Inter",-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:0;background:var(--color-background);color:var(--color-foreground);-webkit-font-smoothing:antialiased}
  .wrap{max-width:900px;margin:0 auto;padding:24px 20px}
  a{color:var(--color-primary);text-decoration:none}a:hover{text-decoration:underline}
  .share-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;max-width:900px;margin:0 auto;padding:12px 20px 0}
  .share-bar .by{font-size:.85em;color:var(--color-muted-foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .share-bar .raw{font-size:.85em;flex-shrink:0}
`

const MD_CONTENT_STYLE = `
  .md{background:#fff;border-radius:8px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,.1);word-wrap:break-word;line-height:1.7}
  .md > :first-child{margin-top:0}
  .md h1,.md h2,.md h3,.md h4{margin-top:1.5em;line-height:1.3;font-weight:600}
  .md h1{font-size:1.8em;border-bottom:1px solid #eee;padding-bottom:.4em}
  .md h2{font-size:1.4em;border-bottom:1px solid #eee;padding-bottom:.3em}
  .md p{margin:1em 0}
  .md code{background:#f6f8fa;padding:2px 6px;border-radius:3px;font-size:.9em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .md pre{background:#f6f8fa;padding:16px;border-radius:6px;overflow:auto;line-height:1.45}
  .md pre code{background:none;padding:0}
  .md blockquote{border-left:4px solid #ddd;margin:1em 0;padding:0 16px;color:#666}
  .md table{border-collapse:collapse;width:100%;margin:1em 0}
  .md th,.md td{border:1px solid #ddd;padding:6px 12px;text-align:left}
  .md th{background:#f6f8fa}
  .md img{max-width:100%}
  .md ul,.md ol{padding-left:2em}
  .md hr{border:none;border-top:1px solid #eee;margin:1.5em 0}
`

/* Shared styles for the "state" pages (login required / password required / expired):
   warm paper background with an indigo dot-matrix glow, a centred card with layered
   shadows, and a staggered rise-in animation. Scoped to these template pages only. */
const STATE_STYLE = `
  .state-bg{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
    background:
      radial-gradient(58% 44% at 50% -4%, rgb(99 102 241 / 0.10), transparent 72%),
      radial-gradient(rgb(99 102 241 / 0.06) 1px, transparent 1px) 0 0/22px 22px,
      var(--color-background)}
  .state-card{position:relative;width:100%;max-width:380px;background:var(--color-card);
    border:1px solid var(--color-border);border-radius:var(--radius-xl);padding:40px 36px;text-align:center;
    box-shadow:0 1px 2px rgb(28 25 23 / .04),0 16px 40px -16px rgb(28 25 23 / .16);
    animation:state-card-in .55s cubic-bezier(.22,1,.36,1) both}
  .state-card::before{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;
    box-shadow:inset 0 1px 0 rgb(255 255 255 / .6)}
  .state-head{display:flex;align-items:center;justify-content:center;gap:12px;margin:0 0 14px}
  .state-head h1{margin:0;font-size:1.25rem;font-weight:600;letter-spacing:-.012em;color:var(--color-foreground)}
  .state-badge{display:inline-flex;align-items:center;justify-content:center;width:42px;height:42px;flex-shrink:0;
    border-radius:12px;background:rgb(99 102 241 / .09);box-shadow:inset 0 0 0 1px rgb(99 102 241 / .16)}
  .state-badge--muted{background:var(--color-muted);box-shadow:inset 0 0 0 1px var(--color-border)}
  .state-text{color:var(--color-muted-foreground);font-size:.875rem;line-height:1.65;margin:0 0 24px}
  .state-err{color:var(--color-destructive);font-size:.85rem;margin:0 0 14px}
  .state-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:11px 26px;
    background:var(--color-primary);color:var(--color-primary-foreground);border:none;cursor:pointer;
    border-radius:var(--radius-md);font:inherit;font-size:.9rem;font-weight:500;
    box-shadow:0 1px 2px rgb(28 25 23 / .08),0 8px 18px -8px rgb(99 102 241 / .55);
    transition:transform .15s ease,box-shadow .2s ease,filter .2s ease}
  .state-btn:hover{text-decoration:none;transform:translateY(-1px);filter:brightness(1.05);
    box-shadow:0 2px 4px rgb(28 25 23 / .1),0 12px 24px -8px rgb(99 102 241 / .65)}
  .state-btn:active{transform:translateY(0)}
  .state-btn--block{width:100%}
  .state-input{width:100%;padding:11px 13px;margin:0 0 12px;font:inherit;font-size:.9rem;
    color:var(--color-foreground);background:var(--color-card);outline:none;
    border:1px solid var(--color-border);border-radius:var(--radius-md);
    transition:border-color .15s ease,box-shadow .15s ease}
  .state-input::placeholder{color:var(--color-warm-400)}
  .state-input:focus{border-color:var(--color-primary);box-shadow:0 0 0 3px rgb(99 102 241 / .15)}
  .state-link{display:inline-block;margin-top:4px;font-size:.85rem;color:var(--color-muted-foreground)}
  .state-card>*{animation:state-rise .5s cubic-bezier(.22,1,.36,1) both}
  .state-card>*:nth-child(1){animation-delay:.05s}
  .state-card>*:nth-child(2){animation-delay:.11s}
  .state-card>*:nth-child(3){animation-delay:.17s}
  @keyframes state-card-in{from{opacity:0;transform:translateY(12px) scale(.985)}to{opacity:1;transform:none}}
  @keyframes state-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  @media (prefers-reduced-motion:reduce){.state-card,.state-card *{animation:none!important}}
`

/** Render a centred state card (login required / password required / expired). `inner` is the card's inner HTML. */
function renderStatePage(title: string, inner: string): string {
  return renderHtmlPage(
    title,
    `<div class="state-bg"><div class="state-card">${inner}</div></div>`,
    STATE_STYLE,
  )
}

/** The "Generated by X" banner plus an optional "View source" link. Only used on template pages this module controls — never injected into a user's HTML artifact. */
export interface ShareMeta {
  /** Display name of the agent that produced the artifact; null/empty hides the attribution */
  agentName?: string | null
  /** Link to the raw source (e.g. /s/:agentId/:shareId/raw); null hides it */
  rawHref?: string | null
}

function renderShareBar(meta?: ShareMeta): string {
  if (!meta) return ''
  const by = meta.agentName
    ? `<span class="by">Generated by ${escHtml(meta.agentName)}</span>`
    : '<span></span>'
  const raw = meta.rawHref ? `<a class="raw" href="${escHtml(meta.rawHref)}">View source</a>` : ''
  if (!meta.agentName && !meta.rawHref) return ''
  return `<div class="share-bar">${by}${raw}</div>`
}

/** Render Markdown into safe HTML */
export function renderMarkdown(mdSource: string): string {
  const raw = marked.parse(mdSource, { async: false }) as string
  return sanitizeHtml(raw, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['h1', 'h2', 'img', 'del', 'ins']),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      img: ['src', 'alt', 'title'],
      a: ['href', 'title'],
      '*': ['class'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
  })
}

export function renderHtmlPage(title: string, bodyHtml: string, extraStyle = ''): string {
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)}</title><style>${BASE_STYLE}${extraStyle}</style></head><body>${bodyHtml}</body></html>`
}

export function renderMarkdownPage(filename: string, mdSource: string, meta?: ShareMeta): string {
  const body = renderMarkdown(mdSource)
  return renderHtmlPage(
    filename,
    `${renderShareBar(meta)}<div class="wrap"><div class="md">${body}</div></div>`,
    MD_CONTENT_STYLE,
  )
}

/** `actionUrl` is the password form's POST target (including the agent segment), e.g. /s/:agentId/:shareId/auth */
export function renderPasswordPage(actionUrl: string, error = false): string {
  const keyIcon = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L21 5"/><path d="m18 9-1.5-1.5"/><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/></svg>`
  const errorMsg = error ? `<p class="state-err">Incorrect password. Please try again.</p>` : ''
  return renderStatePage(
    'Password required',
    `<div class="state-head"><span class="state-badge">${keyIcon}</span><h1>This link requires a password</h1></div><p class="state-text">Enter the access password to view this content.</p><form class="state-form" method="POST" action="${escHtml(actionUrl)}">${errorMsg}<input class="state-input" name="password" type="password" placeholder="Enter password" required autofocus><button class="state-btn state-btn--block" type="submit">Continue</button></form>`,
  )
}

/**
 * `loginUrl` is the login entry point (SPA route /share-login?returnTo=..., which triggers enterprise SSO).
 * The '/' fallback applies only when none is supplied, so the button never points nowhere.
 */
export function renderLoginRequiredPage(loginUrl = '/'): string {
  const lockIcon = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`
  const arrowIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>`
  return renderStatePage(
    'Sign-in required',
    `<div class="state-head"><span class="state-badge">${lockIcon}</span><h1>Sign-in required</h1></div><p class="state-text">This link is only available to users authenticated through your organization. Please sign in with enterprise SSO first.</p><a class="state-btn" href="${escHtml(loginUrl)}">Sign in${arrowIcon}</a>`,
  )
}

/** `linkPrefix` is the prefix for directory file links (including the agent segment), e.g. /s/:agentId/:shareId */
export function renderDirectoryListingPage(
  linkPrefix: string,
  files: Array<{ name: string; relativePath: string }>,
  filename: string,
  meta?: ShareMeta,
): string {
  const rows = files
    .map(
      (f) =>
        `<tr><td><a href="${escHtml(linkPrefix)}/${f.relativePath.split('/').map(encodeURIComponent).join('/')}">${escHtml(f.name)}</a></td></tr>`,
    )
    .join('')
  const html = `${renderShareBar(meta)}<div class="wrap"><h2>${escHtml(filename)}</h2><table style="width:100%;background:var(--color-card);border-radius:var(--radius-lg);border-collapse:collapse;box-shadow:var(--shadow-sm);overflow:hidden"><thead><tr><th style="text-align:left;padding:10px 16px;border-bottom:1px solid var(--color-border)">File</th></tr></thead><tbody>${rows || '<tr><td style="padding:16px;color:var(--color-warm-400)">(empty directory)</td></tr>'}</tbody></table></div>`
  return renderHtmlPage(filename, html)
}

export function renderNotFoundPage(): string {
  const brokenIcon = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-muted-foreground)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 17H7A5 5 0 0 1 7 7"/><path d="M15 7h2a5 5 0 0 1 4 8"/><line x1="8" y1="12" x2="12" y2="12"/><line x1="2" y1="2" x2="22" y2="22"/></svg>`
  return renderStatePage(
    'Link unavailable',
    `<div class="state-head"><span class="state-badge state-badge--muted">${brokenIcon}</span><h1>Link not found or expired</h1></div><p class="state-text">This share link may have been revoked, expired, or never existed.</p><a class="state-link" href="/">Back to a2wave</a>`,
  )
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
