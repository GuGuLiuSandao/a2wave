/**
 * KB remote data-source dispatch layer.
 * Shared by routes and the background scheduler: dispatches to the right document
 * fetcher by sourceType.
 */
import { fetchFeishuDocByUrl } from './feishu-doc-fetcher.js'
import { fetchNotionDocByUrl } from './notion-doc-fetcher.js'

export const REMOTE_KB_SOURCES = ['feishu', 'notion'] as const

const REMOTE_KB_FETCH_TIMEOUT_MS = 5 * 60 * 1000

export type RemoteKbSource = (typeof REMOTE_KB_SOURCES)[number]

export interface RemoteKbDoc {
  sourceType: string
  feishuUrl?: string | null
  feishuAppId?: string | null
  feishuAppSecret?: string | null
  notionUrl?: string | null
  notionToken?: string | null
}

export function isRemoteKbSource(sourceType: string): sourceType is RemoteKbSource {
  return (REMOTE_KB_SOURCES as readonly string[]).includes(sourceType)
}

/** Whether all credentials required for remote sync are present. */
export function hasRemoteKbCredentials(doc: RemoteKbDoc): boolean {
  if (doc.sourceType === 'feishu') {
    return Boolean(doc.feishuUrl && doc.feishuAppId && doc.feishuAppSecret)
  }
  if (doc.sourceType === 'notion') {
    return Boolean(doc.notionUrl && doc.notionToken)
  }
  return false
}

function withRemoteFetchTimeout<T>(operation: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Remote knowledge base sync timed out (5 minutes). Please retry later.'))
    }, REMOTE_KB_FETCH_TIMEOUT_MS)
    timer.unref()

    operation.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** Fetch remote document content by sourceType. */
export async function fetchRemoteKbContent(
  doc: RemoteKbDoc,
): Promise<{ title: string; content: string; contentHash: string }> {
  if (!hasRemoteKbCredentials(doc)) {
    throw new Error(`Missing sync credentials for source type: ${doc.sourceType}`)
  }
  if (doc.sourceType === 'feishu') {
    const { title, content, contentHash } = await withRemoteFetchTimeout(
      fetchFeishuDocByUrl(
        doc.feishuUrl as string,
        doc.feishuAppId as string,
        doc.feishuAppSecret as string,
      ),
    )
    return { title, content, contentHash }
  }
  const { title, content, contentHash } = await withRemoteFetchTimeout(
    fetchNotionDocByUrl(doc.notionUrl as string, doc.notionToken as string),
  )
  return { title, content, contentHash }
}
