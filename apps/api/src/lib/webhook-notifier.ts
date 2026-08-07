import { logger } from './logger.js'
import { getCategorySettings } from './settings.js'
import { UnsafeUrlError, assertSafePublicUrl, safePublicFetch } from './url-safety.js'

function formatDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19)
}

function formatFeishuMessage(params: {
  agentId: string
  agentName: string
  runId: string
  errorMsg: string
  errorTime: Date
}) {
  return {
    msg_type: 'post',
    content: {
      post: {
        zh_cn: {
          title: 'Agent 运行错误',
          content: [
            [{ tag: 'text', text: `时间: ${formatDateTime(params.errorTime)}` }],
            [{ tag: 'text', text: `Agent: ${params.agentName} (${params.agentId})` }],
            [{ tag: 'text', text: `Run ID: ${params.runId}` }],
            [{ tag: 'text', text: `错误: ${params.errorMsg}` }],
          ],
        },
      },
    },
  }
}

function formatCustomMessage(params: {
  agentId: string
  agentName: string
  runId: string
  errorMsg: string
  errorTime: Date
}) {
  return {
    event: 'run.failed',
    timestamp: params.errorTime.toISOString(),
    agent: { id: params.agentId, name: params.agentName },
    run: { id: params.runId },
    error: params.errorMsg,
  }
}

function formatFeishuScmMessage(params: {
  sourceId: string
  sourceName: string
  errorMsg: string
  errorTime: Date
}) {
  return {
    msg_type: 'post',
    content: {
      post: {
        zh_cn: {
          title: '代码源同步失败',
          content: [
            [{ tag: 'text', text: `时间: ${formatDateTime(params.errorTime)}` }],
            [{ tag: 'text', text: `来源: ${params.sourceName} (${params.sourceId})` }],
            [{ tag: 'text', text: `错误: ${params.errorMsg}` }],
          ],
        },
      },
    },
  }
}

function formatCustomScmMessage(params: {
  sourceId: string
  sourceName: string
  errorMsg: string
  errorTime: Date
}) {
  return {
    event: 'scm.sync.failed',
    timestamp: params.errorTime.toISOString(),
    source: { id: params.sourceId, name: params.sourceName },
    error: params.errorMsg,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function sendWithRetry(url: string, body: unknown, maxRetries: number): Promise<void> {
  try {
    assertSafePublicUrl(url)
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      logger.warn({ url, reason: err.reason }, 'Webhook URL blocked by SSRF filter, skipping')
      return
    }
    throw err
  }

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(2 ** attempt * 1000)
    }
    try {
      // safePublicFetch pins the validated IP and refuses redirects, so a webhook
      // target cannot 302 us onto an internal/metadata address (bare fetch would
      // follow it) nor DNS-rebind between check and connect.
      const resp = await safePublicFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (resp.ok) return
      logger.warn({ attempt, status: resp.status }, 'Webhook notification failed, will retry')
    } catch (err) {
      // An SSRF rejection (blocked/rebinding) is terminal — retrying the same URL
      // will fail identically, so stop rather than burn the retry budget.
      if (err instanceof UnsafeUrlError) {
        logger.warn({ url, reason: err.reason }, 'Webhook URL blocked by SSRF filter, skipping')
        return
      }
      logger.warn({ attempt, err }, 'Webhook notification request error, will retry')
    }
  }
}

/** 发送一次测试消息（不重试，直接返回结果） */
export async function sendWebhookTest(
  url: string,
  type: 'feishu' | 'custom',
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const testParams = {
    agentId: 'agt_test',
    agentName: 'Test Agent',
    runId: 'run_test',
    errorMsg: '这是来自 A2WAVE 的 Webhook 测试消息，请忽略。',
    errorTime: new Date(),
  }

  const body = type === 'feishu' ? formatFeishuMessage(testParams) : formatCustomMessage(testParams)

  try {
    assertSafePublicUrl(url)
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      return { ok: false, error: `URL blocked: ${err.message}` }
    }
    throw err
  }

  try {
    const resp = await safePublicFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (resp.ok) return { ok: true }
    return { ok: false, status: resp.status, error: `HTTP ${resp.status}` }
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      return { ok: false, error: `URL blocked: ${err.message}` }
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function notifyRunError(params: {
  agentId: string
  agentName: string
  runId: string
  errorMsg: string
  errorTime: Date
}): Promise<void> {
  const s = getCategorySettings('webhook')
  if (s.enabled !== 'true' || !s.url) return

  const type = s.type || 'feishu'
  const maxRetries = Math.min(10, Math.max(3, Number(s.maxRetries) || 3))
  const body = type === 'feishu' ? formatFeishuMessage(params) : formatCustomMessage(params)

  await sendWithRetry(s.url, body, maxRetries)
}

export async function notifyScmSyncError(params: {
  sourceId: string
  sourceName: string
  errorMsg: string
  errorTime: Date
}): Promise<void> {
  const s = getCategorySettings('webhook')
  if (s.enabled !== 'true' || !s.url) return

  const type = s.type || 'feishu'
  const maxRetries = Math.min(10, Math.max(3, Number(s.maxRetries) || 3))
  const body = type === 'feishu' ? formatFeishuScmMessage(params) : formatCustomScmMessage(params)

  await sendWithRetry(s.url, body, maxRetries)
}
