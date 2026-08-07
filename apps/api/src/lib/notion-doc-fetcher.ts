/**
 * Notion document fetching service.
 * Uses the Notion REST API to fetch a single page's content and convert it to markdown
 * (syncs only the page itself; child_page subpages are not recursed).
 */
import { EnvHttpProxyAgent } from 'undici'
import { computeContentHash } from './feishu-doc-fetcher.js'
import { logger } from './logger.js'

const NOTION_API_BASE = 'https://api.notion.com/v1'
// Pin the older stable API to avoid the data-sources semantics introduced in the 2025-09-03 version
const NOTION_VERSION = '2022-06-28'
const MAX_BLOCK_DEPTH = 10
const MAX_BLOCK_REQUESTS = 500
const MAX_RATE_LIMIT_RETRIES = 3
const NOTION_OPERATION_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_RETRY_DELAY_MS = 1000
const MAX_RETRY_DELAY_MS = 10_000

// api.notion.com may need a proxy in some networks; undici's global fetch does not read proxy env by default
const proxyDispatcher =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy
    ? new EnvHttpProxyAgent()
    : undefined

const PAGE_ID_RE = /([0-9a-f]{32})$/i
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface NotionRichText {
  type?: string
  plain_text?: string
  href?: string | null
  annotations?: {
    bold?: boolean
    italic?: boolean
    strikethrough?: boolean
    code?: boolean
  }
  equation?: { expression?: string }
}

export interface NotionBlockNode {
  id: string
  type: string
  has_children?: boolean
  children?: NotionBlockNode[]
  [key: string]: unknown
}

function toHyphenatedId(raw: string): string {
  const hex = raw.replace(/-/g, '').toLowerCase()
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function extractPageId(segment: string): string | null {
  if (UUID_RE.test(segment)) return toHyphenatedId(segment)
  const match = segment.match(PAGE_ID_RE)
  return match ? toHyphenatedId(match[1]) : null
}

/** Parse a Notion page URL and extract the page ID (normalized to a hyphenated UUID). */
export function parseNotionPageUrl(url: string): { pageId: string } {
  // Supported URL patterns:
  // https://www.notion.so/<workspace>/<slug>-<32hex>
  // https://www.notion.so/<32hex>
  // https://<workspace>.notion.site/<slug>-<32hex>
  // https://app.notion.com/p/<workspace>/<32hex>
  // ...?p=<32hex> (peek links)
  const parsed = new URL(url)

  const peek = parsed.searchParams.get('p')
  if (peek) {
    const pageId = extractPageId(peek)
    if (pageId) return { pageId }
  }

  if (parsed.searchParams.has('v')) {
    throw new Error(
      'Notion database links are not supported yet. Please provide a normal page link.',
    )
  }

  const segments = parsed.pathname.split('/').filter(Boolean)
  for (let i = segments.length - 1; i >= 0; i--) {
    const pageId = extractPageId(decodeURIComponent(segments[i]))
    if (pageId) return { pageId }
  }

  throw new Error(`Invalid Notion page URL: ${url}`)
}

/** Extract a user-friendly error message from a Notion API error response. */
export function parseNotionErrorMessage(
  status: number,
  body: { code?: string; message?: string } | null,
): string | null {
  if (status === 401) {
    return 'Invalid Notion token. Please check that the Integration Token is correct.'
  }
  if (status === 404) {
    return 'The Notion page does not exist or is not shared with the Integration. Add the Integration via "•••" → "Connections" in the top-right corner of the page; database links are not supported yet.'
  }
  if (status === 403) {
    return 'This Notion Integration does not have permission to access the content, or the workspace restricts API access.'
  }
  if (status === 429) {
    return 'Hit the Notion API rate limit. Please retry later.'
  }
  if (status === 400 && body?.message) {
    return `Invalid Notion request parameters (${body.message}). Please confirm the link is a normal page.`
  }
  if (body?.message) {
    return `Notion API error (${body.code ?? status}): ${body.message}`
  }
  return null
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function retryDelayMs(retryAfter: string | null): number {
  const value = retryAfter?.trim()
  if (!value) return DEFAULT_RETRY_DELAY_MS

  const seconds = Number(value)
  if (!Number.isFinite(seconds)) return DEFAULT_RETRY_DELAY_MS
  return Math.min(Math.max(seconds, 0) * 1000, MAX_RETRY_DELAY_MS)
}

function isAbortError(err: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError'))
  )
}

function notionTimeoutError(): Error {
  return new Error(
    'Notion API request timed out. Please retry later; if the page is large, split it into smaller pages.',
  )
}

async function notionGet<T>(token: string, path: string, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let res: Awaited<ReturnType<typeof fetch>>
    try {
      signal.throwIfAborted()
      res = await fetch(`${NOTION_API_BASE}${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': NOTION_VERSION,
        },
        signal,
        ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
      } as RequestInit)
    } catch (err) {
      logger.error({ err, path }, 'Failed to reach Notion API')
      if (isAbortError(err, signal)) {
        throw notionTimeoutError()
      }
      throw new Error('Cannot reach the Notion API. Check the network or configure an HTTPS_PROXY.')
    }

    if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      try {
        await sleep(retryDelayMs(res.headers.get('retry-after')), signal)
      } catch (err) {
        if (isAbortError(err, signal)) {
          throw notionTimeoutError()
        }
        throw err
      }
      continue
    }

    if (!res.ok) {
      let body: { code?: string; message?: string } | null = null
      try {
        body = (await res.json()) as { code?: string; message?: string }
      } catch (err) {
        if (isAbortError(err, signal)) throw notionTimeoutError()
        body = null
      }
      logger.error({ status: res.status, body, path }, 'Notion API request failed')
      throw new Error(
        parseNotionErrorMessage(res.status, body) ?? `Notion API request failed (${res.status})`,
      )
    }

    try {
      return (await res.json()) as T
    } catch (err) {
      if (isAbortError(err, signal)) throw notionTimeoutError()
      throw err
    }
  }
}

/** Fetch the page title (the property whose type === 'title'). */
export async function fetchNotionPageTitle(
  token: string,
  pageId: string,
  signal: AbortSignal = AbortSignal.timeout(NOTION_OPERATION_TIMEOUT_MS),
): Promise<string> {
  const page = await notionGet<{ properties?: Record<string, unknown> }>(
    token,
    `/pages/${pageId}`,
    signal,
  )
  for (const prop of Object.values(page.properties ?? {})) {
    const p = prop as { type?: string; title?: NotionRichText[] }
    if (p.type === 'title') {
      const title = (p.title ?? []).map((t) => t.plain_text ?? '').join('')
      return title.trim() || 'Untitled'
    }
  }
  return 'Untitled'
}

interface FetchContext {
  requests: number
}

interface NotionBlockListResponse {
  results: NotionBlockNode[]
  has_more: boolean
  next_cursor: string | null
}

// child_page / child_database are kept as placeholders but not recursed into
const NON_RECURSIVE_TYPES = new Set(['child_page', 'child_database'])

/** Fetch the block tree: cursor pagination + nested block recursion (subpages not recursed). */
export async function fetchNotionBlockTree(
  token: string,
  blockId: string,
  depth = 0,
  ctx: FetchContext = { requests: 0 },
  signal: AbortSignal = AbortSignal.timeout(NOTION_OPERATION_TIMEOUT_MS),
): Promise<NotionBlockNode[]> {
  const blocks: NotionBlockNode[] = []
  let cursor: string | null = null

  do {
    if (ctx.requests >= MAX_BLOCK_REQUESTS) {
      throw new Error(
        `The Notion page exceeds the sync request limit (${MAX_BLOCK_REQUESTS} requests). Please split the page.`,
      )
    }
    ctx.requests++
    const query: string = cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''
    const data: NotionBlockListResponse = await notionGet<NotionBlockListResponse>(
      token,
      `/blocks/${blockId}/children?page_size=100${query}`,
      signal,
    )
    blocks.push(...data.results)
    if (data.has_more && !data.next_cursor) {
      // Fail loudly rather than silently truncating the page on an inconsistent response.
      throw new Error(
        'Notion pagination returned has_more without a next_cursor; aborting to avoid dropping content.',
      )
    }
    cursor = data.has_more ? data.next_cursor : null
  } while (cursor)

  for (const blk of blocks) {
    if (blk.has_children && !NON_RECURSIVE_TYPES.has(blk.type)) {
      if (depth >= MAX_BLOCK_DEPTH) {
        throw new Error(
          `The Notion page nesting depth exceeds the sync limit (${MAX_BLOCK_DEPTH} levels). Please split the page.`,
        )
      }
      blk.children = await fetchNotionBlockTree(token, blk.id, depth + 1, ctx, signal)
    }
  }

  return blocks
}

function renderRichText(items: NotionRichText[] | undefined): string {
  if (!items?.length) return ''
  return items
    .map((item) => {
      if (item.type === 'equation') {
        return `$${item.equation?.expression ?? ''}$`
      }
      let text = item.plain_text ?? ''
      if (!text) return ''
      const a = item.annotations ?? {}
      if (a.code) text = `\`${text}\``
      if (a.bold) text = `**${text}**`
      if (a.italic) text = `*${text}*`
      if (a.strikethrough) text = `~~${text}~~`
      if (item.href) text = `[${text}](${item.href})`
      return text
    })
    .join('')
}

function payload(block: NotionBlockNode): Record<string, unknown> {
  return (block[block.type] as Record<string, unknown> | undefined) ?? {}
}

function blockRichText(block: NotionBlockNode): string {
  return renderRichText(payload(block).rich_text as NotionRichText[] | undefined)
}

function mediaSource(block: NotionBlockNode): { hostedByNotion: boolean; url: string } {
  const p = payload(block) as {
    external?: { url?: string }
    file?: { url?: string }
    url?: string
  }
  if (p.file) return { hostedByNotion: true, url: '' }
  return { hostedByNotion: false, url: p.external?.url ?? p.url ?? '' }
}

function indentLines(text: string, indent: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `${indent}${line}` : line))
    .join('\n')
}

function renderTable(block: NotionBlockNode): string {
  const rows = (block.children ?? []).filter((c) => c.type === 'table_row')
  if (!rows.length) return ''
  const cells = rows.map((row) =>
    ((payload(row).cells as NotionRichText[][] | undefined) ?? []).map((cell) =>
      renderRichText(cell).replace(/\|/g, '\\|'),
    ),
  )
  const width = Math.max(...cells.map((r) => r.length))
  const line = (r: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`
  const hasColumnHeader = payload(block).has_column_header === true
  const [firstRow, ...remainingRows] = cells
  const header = hasColumnHeader ? firstRow : Array.from({ length: width }, () => '')
  const body = hasColumnHeader ? remainingRows : cells
  const separator = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`
  return [line(header), separator, ...body.map(line)].join('\n')
}

interface MarkdownPart {
  text: string
  isListItem: boolean
}

/** Pure function: Notion block tree -> markdown text. */
export function notionBlocksToMarkdown(blocks: NotionBlockNode[], indent = ''): string {
  const parts: MarkdownPart[] = []
  let numberedIndex = 0

  for (const block of blocks) {
    numberedIndex = block.type === 'numbered_list_item' ? numberedIndex + 1 : 0
    const part = renderBlock(block, indent, numberedIndex)
    if (part) parts.push(part)
  }

  let out = ''
  parts.forEach((part, i) => {
    if (i > 0) out += part.isListItem && parts[i - 1].isListItem ? '\n' : '\n\n'
    out += part.text
  })
  return out
}

function renderChildren(block: NotionBlockNode, indent: string): string {
  if (!block.children?.length) return ''
  return notionBlocksToMarkdown(block.children, `${indent}  `)
}

function listItem(prefix: string, block: NotionBlockNode, indent: string): MarkdownPart {
  const children = renderChildren(block, indent)
  const line = `${indent}${prefix}${blockRichText(block)}`
  return { text: children ? `${line}\n${children}` : line, isListItem: true }
}

function renderBlock(
  block: NotionBlockNode,
  indent: string,
  numberedIndex: number,
): MarkdownPart | null {
  switch (block.type) {
    case 'paragraph': {
      const text = blockRichText(block)
      if (!text && !block.children?.length) return null
      const children = renderChildren(block, indent)
      const line = indentLines(text, indent)
      return { text: children ? `${line}\n${children}` : line, isListItem: false }
    }
    case 'heading_1':
    case 'heading_2':
    case 'heading_3': {
      const level = '#'.repeat(Number(block.type.slice(-1)))
      const heading = `${indent}${level} ${blockRichText(block)}`
      const children = renderChildren(block, indent)
      return { text: children ? `${heading}\n\n${children}` : heading, isListItem: false }
    }
    case 'bulleted_list_item':
    case 'toggle':
      return listItem('- ', block, indent)
    case 'numbered_list_item':
      return listItem(`${numberedIndex}. `, block, indent)
    case 'to_do': {
      const checked = (payload(block) as { checked?: boolean }).checked
      return listItem(checked ? '- [x] ' : '- [ ] ', block, indent)
    }
    case 'quote': {
      const children = renderChildren(block, indent)
      const line = `${indent}> ${blockRichText(block)}`
      return { text: children ? `${line}\n${children}` : line, isListItem: false }
    }
    case 'callout': {
      const emoji = (payload(block) as { icon?: { emoji?: string } }).icon?.emoji
      const children = renderChildren(block, indent)
      const line = `${indent}> ${emoji ? `${emoji} ` : ''}${blockRichText(block)}`
      return { text: children ? `${line}\n${children}` : line, isListItem: false }
    }
    case 'code': {
      const language = (payload(block) as { language?: string }).language ?? ''
      const raw = ((payload(block).rich_text as NotionRichText[] | undefined) ?? [])
        .map((t) => t.plain_text ?? '')
        .join('')
      return {
        text: indentLines(`\`\`\`${language}\n${raw}\n\`\`\``, indent),
        isListItem: false,
      }
    }
    case 'equation': {
      const expression = (payload(block) as { expression?: string }).expression ?? ''
      return { text: indentLines(`$$\n${expression}\n$$`, indent), isListItem: false }
    }
    case 'divider':
      return { text: `${indent}---`, isListItem: false }
    case 'table': {
      const table = renderTable(block)
      return table ? { text: indentLines(table, indent), isListItem: false } : null
    }
    case 'child_page': {
      const title = (payload(block) as { title?: string }).title ?? 'Untitled'
      return { text: `${indent}📄 ${title} (subpage, not synced)`, isListItem: false }
    }
    case 'child_database': {
      const title = (payload(block) as { title?: string }).title ?? 'Untitled'
      return { text: `${indent}🗄️ ${title} (subdatabase, not synced)`, isListItem: false }
    }
    case 'image': {
      const caption = renderRichText(payload(block).caption as NotionRichText[] | undefined)
      const source = mediaSource(block)
      if (source.hostedByNotion) {
        return {
          text: `${indent}Notion-hosted media: ${caption || 'image'} (temporary link not saved)`,
          isListItem: false,
        }
      }
      return source.url
        ? { text: `${indent}![${caption || 'image'}](${source.url})`, isListItem: false }
        : null
    }
    case 'video':
    case 'file':
    case 'pdf':
    case 'audio':
    case 'embed':
    case 'bookmark':
    case 'link_preview': {
      const caption = renderRichText(payload(block).caption as NotionRichText[] | undefined)
      const source = mediaSource(block)
      if (source.hostedByNotion) {
        return {
          text: `${indent}Notion-hosted media: ${caption || block.type} (temporary link not saved)`,
          isListItem: false,
        }
      }
      return source.url
        ? { text: `${indent}[${caption || block.type}](${source.url})`, isListItem: false }
        : null
    }
    case 'column_list':
    case 'column':
    case 'synced_block': {
      if (!block.children?.length) return null
      return { text: notionBlocksToMarkdown(block.children, indent), isListItem: false }
    }
    default: {
      const text = blockRichText(block)
      return text ? { text: indentLines(text, indent), isListItem: false } : null
    }
  }
}

/** Fetch page content from a Notion URL (convenience wrapper; signature matches how fetchFeishuDocByUrl is consumed). */
export async function fetchNotionDocByUrl(
  url: string,
  token: string,
): Promise<{ title: string; content: string; contentHash: string; pageId: string }> {
  const { pageId } = parseNotionPageUrl(url)
  const signal = AbortSignal.timeout(NOTION_OPERATION_TIMEOUT_MS)
  const title = await fetchNotionPageTitle(token, pageId, signal)
  const blocks = await fetchNotionBlockTree(token, pageId, 0, { requests: 0 }, signal)
  const body = notionBlocksToMarkdown(blocks)
  const content = body ? `# ${title}\n\n${body}` : `# ${title}`
  const contentHash = computeContentHash(content)
  return { title, content, contentHash, pageId }
}
