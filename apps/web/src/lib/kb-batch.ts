/**
 * Batch creation of Knowledge Base documents.
 *
 * One link or one file becomes one KB document, so "add several at once" is a client
 * concern: the api stays one-document-per-request and this module drives it N times.
 */

/**
 * How many sources one submit may add, shared by links and files.
 *
 * Each link costs a synchronous remote fetch on the server — Feishu spends 2-3 upstream
 * calls at a 60s timeout, Notion walks paginated blocks under a 5-minute budget — so the
 * cap is really a bound on how long the user stares at an open dialog. Ten is roughly
 * 20-50s, and ten sequential Notion pages stay inside its rate limit.
 */
export const KB_BATCH_MAX = 10

/**
 * Reads a pasted list of source URLs, one per line.
 *
 * Same shape as `parseSuggestedQuestions` in the publish tab (trim, drop blanks), with
 * two deliberate differences. Exact duplicates are collapsed, because each surviving line
 * becomes its own document and a doubled paste would leave two rows pointing at one page,
 * each syncing on its own timer. And the batch cap is *not* applied here: silently slicing
 * an over-long paste would drop links the user believes they added, so the caller compares
 * against `KB_BATCH_MAX` and says so instead.
 *
 * Deduping is exact-string only — no host lowercasing, no query stripping. Notion page
 * slugs are case-sensitive, and a "smart" normaliser would eventually merge two genuinely
 * different links.
 */
export function parseKbSourceUrls(raw: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of raw.split('\n')) {
    const url = line.trim()
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

/**
 * Rejects lines that are not absolute http(s) URLs, before any request is fired.
 *
 * Deliberately does not reimplement token extraction: `parseFeishuDocUrl` and
 * `parseNotionPageUrl` live in `apps/api` and cannot be imported here (arch gate R1), and
 * a copy of their rules would drift the next time a URL shape changes. Both server parsers
 * begin with `new URL(...)`, so this check is strictly weaker than either — it can never
 * reject something the server would have accepted. Everything source-specific stays server
 * side and comes back as prose.
 */
export function isLikelySourceUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value.trim())
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export type KbBatchStatus = 'pending' | 'running' | 'success' | 'error'

export interface KbBatchItem {
  /** The URL, or the filename for an upload batch. */
  label: string
  status: KbBatchStatus
  /** Server-assigned document name, on success. */
  name?: string
  /** Server-assigned document id, on success. */
  id?: string
  /** User-facing message, on failure. */
  error?: string
}

export interface KbBatchOptions {
  onProgress?: (items: KbBatchItem[]) => void
  formatError: (err: unknown) => string
  shouldStop?: () => boolean
}

export interface KbBatchResult {
  items: KbBatchItem[]
  succeeded: number
  /** Failures plus anything skipped by a stop, in input order — what a retry should submit. */
  remaining: string[]
  /** Ids of the documents actually created, in completion order. */
  createdIds: string[]
  /** Message of the first failure, or `''` when nothing failed. */
  firstError: string
}

/**
 * Runs `create` over `labels` one at a time, reporting progress after every transition.
 *
 * Sequential on purpose, three times over: each remote fetch is a synchronous server round
 * trip holding a request slot; Notion rate-limits around 3 req/s and a single page already
 * costs several calls; and a partial result is only actionable if the user can see which
 * item failed. `shouldStop` is polled *between* items — the in-flight request has no abort
 * channel, so a stop takes effect after the current document finishes.
 */
export async function runKbBatch(
  labels: string[],
  create: (label: string, index: number) => Promise<{ name?: string; id?: string }>,
  { onProgress, formatError, shouldStop }: KbBatchOptions,
): Promise<KbBatchResult> {
  const items: KbBatchItem[] = labels.map((label) => ({ label, status: 'pending' }))
  const emit = () => onProgress?.(items.map((item) => ({ ...item })))

  for (const [index, item] of items.entries()) {
    if (shouldStop?.()) break

    item.status = 'running'
    emit()
    try {
      const { name, id } = await create(item.label, index)
      item.status = 'success'
      item.name = name
      item.id = id
    } catch (err) {
      item.status = 'error'
      item.error = formatError(err)
    }
    emit()
  }

  const succeededItems = items.filter((item) => item.status === 'success')
  return {
    items,
    succeeded: succeededItems.length,
    remaining: items.filter((item) => item.status !== 'success').map((item) => item.label),
    createdIds: succeededItems.map((item) => item.id).filter((id): id is string => !!id),
    firstError: items.find((item) => item.status === 'error')?.error ?? '',
  }
}
