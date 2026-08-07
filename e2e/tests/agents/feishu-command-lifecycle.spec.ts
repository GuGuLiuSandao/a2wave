import { expect, test } from '@playwright/test'
import {
  type AgentDetail,
  type ProviderSummary,
  createAgentWithPayload,
  deleteAgentAs,
  getAdminToken,
  injectFeishuMessage,
  listProviders,
  publishAgent,
} from '../../utils/api-helpers'

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

const REAL_CLAUDE_MODEL = process.env.E2E_CLAUDE_MODEL || 'claude-sonnet-4-6'
const REAL_CODEX_MODEL = process.env.E2E_CODEX_MODEL || 'gpt-5.3-codex'
const BARE_NEW_FALLBACK = '新会话已开始'
const DISABLED_PROVIDER_RUNTIMES = new Set(
  (process.env.E2E_DISABLED_PROVIDER_RUNTIMES || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
)

type ProviderRuntime = {
  key: 'claude' | 'codex'
  label: string
  providerName: string
  engineType: 'claude-code' | 'codex'
  model: string
  invalidModel: string
}

const PROVIDER_RUNTIMES: ProviderRuntime[] = [
  {
    key: 'claude',
    label: 'Claude Code',
    providerName: 'Claude Code',
    engineType: 'claude-code',
    model: REAL_CLAUDE_MODEL,
    invalidModel: '__a2wave_e2e_invalid_model__',
  },
  {
    key: 'codex',
    label: 'Codex CLI',
    providerName: 'Codex CLI',
    engineType: 'codex',
    model: REAL_CODEX_MODEL,
    invalidModel: '__a2wave_e2e_invalid_model__',
  },
]

function skipReasonForRuntime(runtime: ProviderRuntime): string | null {
  if (!DISABLED_PROVIDER_RUNTIMES.has(runtime.key)) return null
  return `${runtime.label} runtime is disabled by E2E_DISABLED_PROVIDER_RUNTIMES`
}

function providerByName(providers: ProviderSummary[], name: string): ProviderSummary {
  const provider = providers.find((p) => p.name === name)
  if (!provider) throw new Error(`${name} provider fixture is missing`)
  return provider
}

function replies(
  data: Record<string, unknown>,
): Array<{ text: string; kind: string; msgType: string }> {
  return data.replies as Array<{ text: string; kind: string; msgType: string }>
}

function probeEvents(data: Record<string, unknown>): string[] {
  return data.probeEvents as string[]
}

function latestRun(
  data: Record<string, unknown>,
): { id: string; status: string; intent: string; result?: Record<string, unknown> } | null {
  return data.latestRun as {
    id: string
    status: string
    intent: string
    result?: Record<string, unknown>
  } | null
}

function latestStep(
  data: Record<string, unknown>,
): { status: string; input?: Record<string, unknown>; output?: Record<string, unknown> } | null {
  return data.latestStep as {
    status: string
    input?: Record<string, unknown>
    output?: Record<string, unknown>
  } | null
}

function userTextFromPrompt(prompt: string): string {
  const match = prompt.match(/<user_query>\n([\s\S]*?)\n<\/user_query>/)
  return match?.[1] ?? prompt
}

function stepPrompt(data: Record<string, unknown>): string {
  const message = latestStep(data)?.input?.message
  expect(typeof message).toBe('string')
  return message as string
}

function runChatId(data: Record<string, unknown>): string {
  const chatId = latestRun(data)?.result?.chatId
  expect(typeof chatId).toBe('string')
  return chatId as string
}

function realProviderAgentPayload(
  runtime: ProviderRuntime,
  provider: ProviderSummary,
  name: string,
  model = runtime.model,
) {
  return {
    name,
    type: 'cursor',
    providerId: provider.id,
    authMode: 'localSession',
    // publishStatus is server-controlled and ignored on create (see publishAgent) —
    // kept off here so this payload doesn't imply it takes effect.
    feishuConfig: { appId: 'cli_e2e', appSecret: 'secret_e2e' },
    config: {
      engineType: runtime.engineType,
      model,
      timeoutMinutes: 2,
      readOnly: true,
    },
  }
}

/**
 * Create then publish for the `feishu` channel — the Feishu inbound handler
 * silently drops events for a non-published Agent (see feishu-service.ts), so
 * every fixture in this file needs the extra publish round trip before
 * `injectFeishuMessage` can reach it.
 */
async function createPublishedAgent(
  token: string,
  payload: Record<string, unknown>,
): Promise<AgentDetail> {
  const agent = await createAgentWithPayload(token, payload)
  return publishAgent(token, agent.id, { channels: ['feishu'] })
}

for (const runtime of PROVIDER_RUNTIMES) {
  test.describe(`${runtime.label} provider`, () => {
    const skipReason = skipReasonForRuntime(runtime)
    test.skip(Boolean(skipReason), skipReason ?? '')

    test('Feishu /new strips the command and starts a fresh provider session', async () => {
      const token = await getAdminToken()
      const providers = await listProviders(token)
      const provider = providerByName(providers, runtime.providerName)

      const agent = await createPublishedAgent(
        token,
        realProviderAgentPayload(runtime, provider, `e2e-${runtime.key}-feishu-new-${Date.now()}`),
      )

      try {
        const first = await injectFeishuMessage(token, agent.id, {
          chatId: `oc_e2e_${runtime.key}_new`,
          messageId: `om_e2e_${runtime.key}_new_1`,
          text: 'Reply exactly SEED_OK. Do not use tools.',
        })
        expect(latestRun(first)?.status).toBe('completed')
        expect(userTextFromPrompt(stepPrompt(first))).toContain('SEED_OK')
        const firstChatId = runChatId(first)

        const second = await injectFeishuMessage(token, agent.id, {
          chatId: `oc_e2e_${runtime.key}_new`,
          messageId: `om_e2e_${runtime.key}_new_2`,
          text: 'Reply exactly FOLLOW_OK. Do not use tools.',
        })
        expect(latestRun(second)?.status).toBe('completed')
        expect(userTextFromPrompt(stepPrompt(second))).toContain('FOLLOW_OK')
        expect(runChatId(second)).toBe(firstChatId)

        const reset = await injectFeishuMessage(token, agent.id, {
          chatId: `oc_e2e_${runtime.key}_new`,
          messageId: `om_e2e_${runtime.key}_new_3`,
          text: '/new Reply exactly RESET_OK. Do not use tools.',
        })
        expect(latestRun(reset)?.status).toBe('completed')
        const resetUserQuery = userTextFromPrompt(stepPrompt(reset))
        expect(resetUserQuery).toContain('RESET_OK')
        expect(resetUserQuery).not.toContain('/new')
        expect(runChatId(reset)).not.toBe(firstChatId)
      } finally {
        await deleteAgentAs(token, agent.id)
      }
    })

    test('Feishu bare /new injects fallback text and starts a fresh provider session', async () => {
      const token = await getAdminToken()
      const providers = await listProviders(token)
      const provider = providerByName(providers, runtime.providerName)

      const agent = await createPublishedAgent(
        token,
        realProviderAgentPayload(
          runtime,
          provider,
          `e2e-${runtime.key}-feishu-bare-new-${Date.now()}`,
        ),
      )

      try {
        const seed = await injectFeishuMessage(token, agent.id, {
          chatId: `oc_e2e_${runtime.key}_bare_new`,
          messageId: `om_e2e_${runtime.key}_bare_new_1`,
          text: 'Reply exactly BARE_SEED_OK. Do not use tools.',
        })
        expect(latestRun(seed)?.status).toBe('completed')
        expect(userTextFromPrompt(stepPrompt(seed))).toContain('BARE_SEED_OK')
        const seedChatId = runChatId(seed)

        const reset = await injectFeishuMessage(token, agent.id, {
          chatId: `oc_e2e_${runtime.key}_bare_new`,
          messageId: `om_e2e_${runtime.key}_bare_new_2`,
          text: '/new',
        })
        expect(latestRun(reset)?.status).toBe('completed')
        const resetUserQuery = userTextFromPrompt(stepPrompt(reset))
        expect(resetUserQuery).toContain(BARE_NEW_FALLBACK)
        expect(resetUserQuery).not.toContain('/new')
        expect(runChatId(reset)).not.toBe(seedChatId)
      } finally {
        await deleteAgentAs(token, agent.id)
      }
    })

    test('onBeforeRun abort after run step finalizes the step as failed', async () => {
      const token = await getAdminToken()
      const providers = await listProviders(token)
      const provider = providerByName(providers, runtime.providerName)
      const agent = await createPublishedAgent(
        token,
        realProviderAgentPayload(
          runtime,
          provider,
          `e2e-${runtime.key}-before-run-abort-${Date.now()}`,
        ),
      )

      try {
        const data = await injectFeishuMessage(token, agent.id, {
          chatId: `oc_e2e_${runtime.key}_abort`,
          messageId: `om_e2e_${runtime.key}_abort_1`,
          text: 'abort me',
          probe: 'abort-before-run',
        })
        expect(replies(data).at(-1)?.text).toContain('E2E abort before run')
        expect(latestRun(data)?.status).toBe('failed')
        expect(latestStep(data)?.status).toBe('failed')
        expect(latestStep(data)?.output).toEqual(
          expect.objectContaining({ error: expect.any(String) }),
        )
      } finally {
        await deleteAgentAs(token, agent.id)
      }
    })

    test('onAfterRun patch is used by Feishu reply and onAfterReply broadcast fires', async () => {
      const token = await getAdminToken()
      const providers = await listProviders(token)
      const provider = providerByName(providers, runtime.providerName)
      const agent = await createPublishedAgent(
        token,
        realProviderAgentPayload(
          runtime,
          provider,
          `e2e-${runtime.key}-after-run-patch-${Date.now()}`,
        ),
      )

      try {
        const data = await injectFeishuMessage(token, agent.id, {
          chatId: `oc_e2e_${runtime.key}_after_run`,
          messageId: `om_e2e_${runtime.key}_after_run_1`,
          text: 'Reply exactly PATCH_OK. Do not use tools.',
          probe: 'patch-after-run',
        })
        const finalReply = replies(data).at(-1)?.text ?? ''
        expect(finalReply).toContain('[afterRun patched]')
        expect(latestRun(data)?.status).toBe('completed')
        expect(userTextFromPrompt(stepPrompt(data))).toContain('PATCH_OK')
        expect(probeEvents(data)).toEqual(
          expect.arrayContaining([
            'afterRun:success',
            expect.stringContaining('beforeReply:[afterRun patched]'),
            'afterReply',
          ]),
        )
      } finally {
        await deleteAgentAs(token, agent.id)
      }
    })

    test('Feishu group /new is treated as normal text and does not reset the provider session', async () => {
      const token = await getAdminToken()
      const providers = await listProviders(token)
      const provider = providerByName(providers, runtime.providerName)
      const agent = await createPublishedAgent(
        token,
        realProviderAgentPayload(
          runtime,
          provider,
          `e2e-${runtime.key}-feishu-group-new-${Date.now()}`,
        ),
      )

      try {
        const rootMessageId = `om_e2e_${runtime.key}_group_new_root_${Date.now()}`
        const seed = await injectFeishuMessage(token, agent.id, {
          chatType: 'group',
          chatId: `oc_e2e_${runtime.key}_group_new`,
          messageId: rootMessageId,
          text: 'Reply exactly GROUP_SEED_OK. Do not use tools.',
        })
        const seedChatId = runChatId(seed)

        const data = await injectFeishuMessage(token, agent.id, {
          chatType: 'group',
          chatId: `oc_e2e_${runtime.key}_group_new`,
          messageId: `om_e2e_${runtime.key}_group_new_2`,
          rootId: rootMessageId,
          text: '/new Reply exactly GROUP_FOLLOW_OK. Do not use tools.',
        })

        expect(latestRun(data)?.status).toBe('completed')
        expect(runChatId(data)).toBe(seedChatId)
        const userQuery = userTextFromPrompt(stepPrompt(data))
        expect(userQuery).not.toContain('GROUP_SEED_OK')
        expect(userQuery).toContain('GROUP_FOLLOW_OK')
        expect(userQuery).toContain('/new')
      } finally {
        await deleteAgentAs(token, agent.id)
      }
    })

    test('话题回复开启 topicInjectRootMessage 时 prompt 注入根消息文本', async () => {
      const token = await getAdminToken()
      const providers = await listProviders(token)
      const provider = providerByName(providers, runtime.providerName)
      const agent = await createPublishedAgent(token, {
        ...realProviderAgentPayload(
          runtime,
          provider,
          `e2e-${runtime.key}-topic-root-inject-${Date.now()}`,
        ),
        feishuConfig: {
          appId: 'cli_e2e',
          appSecret: 'secret_e2e',
          topicInjectRootMessage: true,
        },
      })

      try {
        const rootMessageId = `om_e2e_${runtime.key}_topic_root_inject_${Date.now()}`
        const threadId = `th_e2e_${runtime.key}_topic_root_inject_${Date.now()}`
        const rootText = 'Reply exactly TOPIC_ROOT_OK. Do not use tools.'
        await injectFeishuMessage(token, agent.id, {
          chatType: 'group',
          chatId: `oc_e2e_${runtime.key}_topic_root_inject`,
          threadId,
          messageId: rootMessageId,
          text: rootText,
        })

        const data = await injectFeishuMessage(token, agent.id, {
          chatType: 'group',
          chatId: `oc_e2e_${runtime.key}_topic_root_inject`,
          threadId,
          messageId: `om_e2e_${runtime.key}_topic_root_inject_2`,
          root: { messageId: rootMessageId, text: rootText },
          text: 'Reply exactly TOPIC_FOLLOW_OK. Do not use tools.',
        })

        expect(latestRun(data)?.status).toBe('completed')
        const userQuery = userTextFromPrompt(stepPrompt(data))
        expect(userQuery).toContain('TOPIC_ROOT_OK')
        expect(userQuery).toContain('TOPIC_FOLLOW_OK')
      } finally {
        await deleteAgentAs(token, agent.id)
      }
    })

    test('onRunSucceeded and onRunFailed broadcasts are observed by the E2E route', async () => {
      const token = await getAdminToken()
      const providers = await listProviders(token)
      const provider = providerByName(providers, runtime.providerName)
      const agent = await createPublishedAgent(
        token,
        realProviderAgentPayload(
          runtime,
          provider,
          `e2e-${runtime.key}-broadcast-observe-${Date.now()}`,
        ),
      )
      const failingAgent = await createPublishedAgent(
        token,
        realProviderAgentPayload(
          runtime,
          provider,
          `e2e-${runtime.key}-broadcast-observe-fail-${Date.now()}`,
          runtime.invalidModel,
        ),
      )

      try {
        const success = await injectFeishuMessage(token, agent.id, {
          chatId: `oc_e2e_${runtime.key}_broadcast`,
          messageId: `om_e2e_${runtime.key}_broadcast_success`,
          text: 'Reply exactly BROADCAST_OK. Do not use tools.',
          probe: 'observe-broadcast',
        })
        expect(probeEvents(success)).toEqual(
          expect.arrayContaining([expect.stringMatching(/^runSucceeded:/)]),
        )

        const failed = await injectFeishuMessage(token, failingAgent.id, {
          chatId: `oc_e2e_${runtime.key}_broadcast`,
          messageId: `om_e2e_${runtime.key}_broadcast_failed`,
          text: 'broadcast failure',
          probe: 'observe-broadcast',
        })
        expect(probeEvents(failed)).toEqual(
          expect.arrayContaining([expect.stringMatching(/^runFailed:/)]),
        )
      } finally {
        await deleteAgentAs(token, agent.id)
        await deleteAgentAs(token, failingAgent.id)
      }
    })

    test('onAfterRun can patch provider failure errors before Feishu replies', async () => {
      const token = await getAdminToken()
      const providers = await listProviders(token)
      const provider = providerByName(providers, runtime.providerName)
      const agent = await createPublishedAgent(
        token,
        realProviderAgentPayload(
          runtime,
          provider,
          `e2e-${runtime.key}-after-run-error-patch-${Date.now()}`,
          runtime.invalidModel,
        ),
      )

      try {
        const data = await injectFeishuMessage(token, agent.id, {
          chatId: `oc_e2e_${runtime.key}_after_run_error`,
          messageId: `om_e2e_${runtime.key}_after_run_error_1`,
          text: 'patch provider failure',
          probe: 'patch-after-run-error',
        })
        expect(replies(data).at(-1)?.text).toContain('Agent 未返回有效内容')
        expect(probeEvents(data)).toEqual(expect.arrayContaining(['afterRun:failed']))
      } finally {
        await deleteAgentAs(token, agent.id)
      }
    })

    test('throwing onAfterRun probe is isolated and does not replace provider output', async () => {
      const token = await getAdminToken()
      const providers = await listProviders(token)
      const provider = providerByName(providers, runtime.providerName)
      const agent = await createPublishedAgent(
        token,
        realProviderAgentPayload(
          runtime,
          provider,
          `e2e-${runtime.key}-after-run-throw-${Date.now()}`,
        ),
      )

      try {
        const data = await injectFeishuMessage(token, agent.id, {
          chatId: `oc_e2e_${runtime.key}_after_run_throw`,
          messageId: `om_e2e_${runtime.key}_after_run_throw_1`,
          text: 'Reply exactly THROW_OK. Do not use tools.',
          probe: 'throw-after-run',
        })
        expect(latestRun(data)?.status).toBe('completed')
        expect(userTextFromPrompt(stepPrompt(data))).toContain('THROW_OK')
        expect(probeEvents(data)).toEqual(expect.arrayContaining(['afterRun:throw']))
      } finally {
        await deleteAgentAs(token, agent.id)
      }
    })

    // This matches current production behavior: card.create() fails before
    // runWithLifecycle, so the provider pipeline does not run and no compact summary
    // is expected. Degrading to text mode and continuing execution would be a
    // separate product behavior change.

    test('multiple onBeforeReply plugins patch content in priority order', async () => {
      const token = await getAdminToken()
      const providers = await listProviders(token)
      const provider = providerByName(providers, runtime.providerName)
      const agent = await createPublishedAgent(
        token,
        realProviderAgentPayload(
          runtime,
          provider,
          `e2e-${runtime.key}-multi-patch-chain-${Date.now()}`,
        ),
      )

      try {
        const data = await injectFeishuMessage(token, agent.id, {
          chatId: `oc_e2e_${runtime.key}_multi_patch_chain`,
          messageId: `om_e2e_${runtime.key}_multi_patch_chain_1`,
          text: 'Reply exactly CHAIN_OK. Do not use tools.',
          probe: 'multi-patch-chain',
        })
        const finalReply = replies(data).at(-1)?.text ?? ''
        expect(finalReply).toContain('[p2] [p1]')
        expect(userTextFromPrompt(stepPrompt(data))).toContain('CHAIN_OK')
        expect(probeEvents(data)).toEqual(
          expect.arrayContaining([
            expect.stringContaining('beforeReply:p1:'),
            expect.stringContaining('beforeReply:p2:[p1]'),
            'afterReply',
          ]),
        )
      } finally {
        await deleteAgentAs(token, agent.id)
      }
    })
  })
}
