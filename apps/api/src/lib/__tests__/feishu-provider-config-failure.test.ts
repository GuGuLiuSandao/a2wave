import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Feishu behaviour when an Agent's Provider configuration is unusable.
 *
 * Lives in its own file rather than feishu-service.test.ts: that file is frozen
 * at its line-count baseline (scripts/gates/file-lines-allowlist.json) with the
 * explicit instruction to split by scenario instead of appending.
 *
 * The failure matters because it happens BEFORE a Run exists. If the exception
 * reaches the dispatcher it is only logged, so the user gets no reply and no run
 * record — the bot is indistinguishable from being offline.
 */

const mockImMessageReply = vi.hoisted(() => vi.fn())
const mockImMessageCreate = vi.hoisted(() => vi.fn())
const mockImMessageGet = vi.hoisted(() => vi.fn())
const mockImMessageReactionCreate = vi.hoisted(() => vi.fn())
const mockImMessageResourceGet = vi.hoisted(() => vi.fn())
const mockImFileCreate = vi.hoisted(() => vi.fn())
const mockClientRequest = vi.hoisted(() => vi.fn())
const capturedDispatchers = vi.hoisted(() => ({}) as Record<string, (data: any) => void>)

const mockDbGet = vi.hoisted(() => vi.fn())
const mockExecuteWithRetry = vi.hoisted(() => vi.fn())
const mockBuildAgentConfig = vi.hoisted(() => vi.fn())

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeEventDispatcher {
    register(handlers: Record<string, (data: any) => void>) {
      for (const [k, v] of Object.entries(handlers)) capturedDispatchers[k] = v
      return this
    }
  }
  class FakeWSClient {
    start() {
      return undefined
    }
    close() {
      return undefined
    }
  }
  class FakeClient {
    request = (...args: any[]) => mockClientRequest(...args)
    im = {
      message: {
        reply: mockImMessageReply,
        create: mockImMessageCreate,
        get: mockImMessageGet,
      },
      messageReaction: { create: mockImMessageReactionCreate },
      messageResource: { get: mockImMessageResourceGet },
      file: { create: mockImFileCreate },
    }
  }
  return {
    WSClient: FakeWSClient,
    EventDispatcher: FakeEventDispatcher,
    Client: FakeClient,
    LoggerLevel: { error: 'error', info: 'info' },
  }
})

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => asyncQuery({ get: mockDbGet, all: () => [] }) }),
    }),
    insert: () => ({ values: () => asyncQuery({ run: vi.fn() }) }),
    update: () => ({ set: () => ({ where: () => asyncQuery({ run: vi.fn() }) }) }),
    delete: () => ({ where: () => asyncQuery({ run: vi.fn() }) }),
  },
}))

vi.mock('../../db/schema.js', () => ({
  agents: {},
  runs: {},
  chatMessages: {},
  feishuCardCallbacks: {},
  artifacts: {},
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  lt: vi.fn(),
  desc: vi.fn(),
  isNull: vi.fn(),
  sql: vi.fn(),
}))

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

vi.mock('../agent-helpers.js', () => ({
  buildAgentConfig: mockBuildAgentConfig,
  resolveWorkDir: vi.fn().mockResolvedValue('/tmp/workdir'),
  resolveEngineType: vi.fn(() => 'cursor'),
}))

vi.mock('../execute-with-retry.js', () => ({ executeWithRetry: mockExecuteWithRetry }))

import { UnusableProviderChainError } from '../errors.js'
import { feishuConnectionManager } from '../feishu-service.js'

import { asyncQuery } from '../../test/async-query.js'

const BASE_CONFIG = {
  appId: 'cli_test',
  appSecret: 'secret_test',
  groupTriggerOnAt: true,
  groupTriggerOnNewMessage: false,
  groupReplyMode: 'quote' as const,
  topicTriggerOnAt: true,
  topicTriggerOnNewTopic: false,
  topicTriggerOnNewComment: false,
  topicReplyMode: 'topic_reply' as const,
  p2pReplyMode: 'quote' as const,
}
/**
 * This is the only caller that leaves sendFeishuFailureReply's mention override
 * undefined, so it is where the resolver's self-resolve branch is observable: the
 * failure happens before executeJob, so no dispatch-resolved open_id exists yet.
 */
/** A topic reply that @s the bot — the only shape that both triggers and has a creator. */
const TOPIC_REPLY_MESSAGE = {
  chat_type: 'group',
  thread_id: 'omt_thread',
  root_id: 'om_root',
  content: JSON.stringify({ text: '@_user_1 跑一下' }),
  mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot_test' } }],
}

describe('Feishu message with an unusable provider chain', () => {
  let messageSeq = 0

  beforeEach(() => {
    feishuConnectionManager.stopAll()
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    mockImMessageReply.mockResolvedValue({})
    mockImMessageCreate.mockResolvedValue({})
    mockImMessageReactionCreate.mockResolvedValue({})
  })

  function sentTexts(): string[] {
    return [...mockImMessageReply.mock.calls, ...mockImMessageCreate.mock.calls].map(
      (c) => JSON.parse(c[0].data.content).text as string,
    )
  }

  async function dispatchWithBrokenProvider(
    config: Record<string, unknown>,
    message: Record<string, unknown>,
  ) {
    await feishuConnectionManager.start('agt_001', config as never)
    mockDbGet.mockReturnValue({
      id: 'agt_001',
      publishStatus: 'published',
      maxConcurrency: 1,
      feishuConfig: config,
    })
    mockBuildAgentConfig.mockImplementation(() => {
      throw new UnusableProviderChainError('agt_001')
    })

    const handler = capturedDispatchers['im.message.receive_v1']
    if (!handler) throw new Error('Dispatcher handler not captured')
    messageSeq += 1
    handler({
      message: {
        message_type: 'text',
        // Unique per dispatch: the per-process `agentId:messageId` dedup cache
        // would silently drop a replayed id in a later test.
        message_id: `om_badcfg_${messageSeq}`,
        chat_id: 'oc_chat001',
        content: JSON.stringify({ text: '跑一下' }),
        mentions: [],
        ...message,
      },
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_user001' } },
    })
    for (let tick = 0; tick < 50 && sentTexts().length === 0; tick++) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  it('replies with a configuration failure instead of dropping the message', async () => {
    await dispatchWithBrokenProvider(BASE_CONFIG, { chat_type: 'p2p' })

    expect(mockExecuteWithRetry).not.toHaveBeenCalled()
    expect(sentTexts().some((t) => t.includes('Provider'))).toBe(true)
  })

  it('self-resolves the topic creator for the configuration failure reply', async () => {
    mockImMessageGet.mockResolvedValue({
      data: {
        items: [{ sender: { id: 'ou_topic_creator', id_type: 'open_id', sender_type: 'user' } }],
      },
    })

    await dispatchWithBrokenProvider(
      { ...BASE_CONFIG, topicReplyMentionTarget: 'topic_creator' },
      TOPIC_REPLY_MESSAGE,
    )

    expect(mockImMessageGet).toHaveBeenCalledWith({ path: { message_id: 'om_root' } })
    expect(sentTexts()[0]).toContain('<at user_id="ou_topic_creator"></at>')
  })

  it('mentions nobody when the topic creator cannot be resolved', async () => {
    mockImMessageGet.mockRejectedValue(new Error('missing im:message.group_msg'))

    await dispatchWithBrokenProvider(
      { ...BASE_CONFIG, topicReplyMentionTarget: 'topic_creator' },
      TOPIC_REPLY_MESSAGE,
    )

    expect(sentTexts()[0]).not.toContain('<at ')
  })

  it('skips the root lookup entirely when the mention target is none', async () => {
    await dispatchWithBrokenProvider(
      { ...BASE_CONFIG, topicReplyMentionTarget: 'none' },
      TOPIC_REPLY_MESSAGE,
    )

    expect(mockImMessageGet).not.toHaveBeenCalled()
    expect(sentTexts()[0]).not.toContain('<at ')
  })
})
