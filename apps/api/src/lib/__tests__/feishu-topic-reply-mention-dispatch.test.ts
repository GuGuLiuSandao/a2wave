import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * End-to-end wiring of `topicReplyMentionTarget` through the Feishu dispatcher.
 *
 * Lives in its own file rather than feishu-service.test.ts: that file is frozen at
 * its line-count baseline (scripts/gates/file-lines-allowlist.json) with the explicit
 * instruction to split by scenario instead of appending.
 *
 * The pure helpers are covered by feishu-reply-mention.test.ts / feishu-topic-root.test.ts.
 * What is only observable here is the ~100 lines of executeJob wiring: which target
 * triggers the root-message lookup, that the lookup is shared with content injection,
 * and that the resolved open_id actually reaches the outgoing reply payload.
 */

const mockImMessageReply = vi.hoisted(() => vi.fn())
const mockImMessageCreate = vi.hoisted(() => vi.fn())
const mockImMessageGet = vi.hoisted(() => vi.fn())
const mockImMessageReactionCreate = vi.hoisted(() => vi.fn())
const mockImMessageResourceGet = vi.hoisted(() => vi.fn())
const mockImFileCreate = vi.hoisted(() => vi.fn())
const mockClientRequest = vi.hoisted(() => vi.fn())
const capturedDispatchers = vi.hoisted(() => ({}) as Record<string, (data: unknown) => void>)

const mockDbGet = vi.hoisted(() => vi.fn())
const mockExecuteWithRetry = vi.hoisted(() => vi.fn())
const mockBuildAgentConfig = vi.hoisted(() => vi.fn())
const mockResolveWorkDir = vi.hoisted(() => vi.fn())
const mockTryAcquireSlot = vi.hoisted(() => vi.fn())
const mockLoggerWarn = vi.hoisted(() => vi.fn())
const mockStreamingCardUpdateContent = vi.hoisted(() => vi.fn())
const mockStreamingCardFinish = vi.hoisted(() => vi.fn())

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeEventDispatcher {
    _handlers: Record<string, (data: unknown) => void> = {}
    register(handlers: Record<string, (data: unknown) => void>) {
      Object.assign(this._handlers, handlers)
      return this
    }
  }
  class FakeWSClient {
    wsConfig = { getWSInstance: () => ({ readyState: 1 }) }
    start(params: { eventDispatcher?: { _handlers?: Record<string, (d: unknown) => void> } }) {
      const handlers = params.eventDispatcher?._handlers ?? {}
      for (const key of Object.keys(handlers)) capturedDispatchers[key] = handlers[key]
      return undefined
    }
    close() {
      return undefined
    }
  }
  class FakeClient {
    request = (...args: unknown[]) => mockClientRequest(...args)
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

vi.mock('../../db/client.js', () => {
  const chain = {
    select: () => ({
      from: () =>
        asyncQuery({
          where: () =>
            asyncQuery({
              get: mockDbGet,
              all: () => [],
              orderBy: () => ({ limit: () => asyncQuery({ get: mockDbGet }) }),
            }),
        }),
    }),
    insert: () => ({ values: () => asyncQuery({ run: vi.fn() }) }),
    update: () => ({
      set: () => asyncQuery({ where: () => asyncQuery({ run: vi.fn(() => ({ changes: 1 })) }) }),
    }),
    delete: () => ({ where: () => asyncQuery({ run: vi.fn() }) }),
  }
  return { db: { ...chain, transaction: (fn: (tx: typeof chain) => unknown) => fn(chain) } }
})

vi.mock('../../db/schema.js', () => ({
  agents: { id: {}, publishStatus: {} },
  runs: {},
  runSteps: {},
  chatMessages: {},
  artifacts: {},
  feishuCardCallbacks: {},
  feishuPendingMessages: { messageId: {}, agentId: {}, runId: {}, payload: {}, createdAt: {} },
}))

vi.mock('../feishu-pending-store.js', () => ({
  persistPendingMessage: vi.fn(),
  removePendingMessage: vi.fn(),
  listPendingMessages: vi.fn().mockReturnValue([]),
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn().mockReturnValue({}),
  and: vi.fn().mockReturnValue({}),
  or: vi.fn().mockReturnValue({}),
  lt: vi.fn().mockReturnValue({}),
  desc: vi.fn().mockReturnValue({}),
  isNull: vi.fn().mockReturnValue({}),
  sql: vi.fn().mockReturnValue({}),
}))

vi.mock('../id.js', () => ({ createId: (prefix: string) => `${prefix}_test` }))

vi.mock('../logger.js', () => ({
  logger: { warn: mockLoggerWarn, error: vi.fn(), info: vi.fn() },
}))

vi.mock('../agent-helpers.js', () => ({
  buildAgentConfig: mockBuildAgentConfig,
  resolveWorkDir: mockResolveWorkDir,
  resolveEngineType: vi.fn(() => 'cursor'),
}))

vi.mock('../run-lifecycle.js', () => ({
  finishRunSuccess: vi.fn().mockResolvedValue([]),
  finishRunError: vi.fn(),
  finishRunAborted: vi.fn(),
  cleanupWorktreeIfEphemeral: vi.fn().mockResolvedValue(undefined),
  createLogCollector: vi.fn(() => ({ logs: [], onLogEntry: vi.fn() })),
  createPersistingLogCollector: vi.fn(() => ({
    logs: [],
    onLogEntry: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
  sanitizeLogsForStorage: vi.fn((logs: unknown[]) => logs),
}))

vi.mock('../run-log-registry.js', () => ({
  registerLogCollector: vi.fn(),
  unregisterLogCollector: vi.fn(),
  stopLogCollector: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../worker/index.js', () => ({ executeInWorker: vi.fn() }))
vi.mock('../execute-with-retry.js', () => ({ executeWithRetry: mockExecuteWithRetry }))
vi.mock('../../engine/task-queue.js', () => ({
  tryAcquireSlot: mockTryAcquireSlot,
  scheduleNext: vi.fn(),
}))
vi.mock('../../engine/task-queue-db.js', () => ({ taskQueueDb: {} }))

vi.mock('node:fs', () => ({
  promises: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    rmdir: vi.fn().mockResolvedValue(undefined),
  },
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue(Buffer.from('file-content')),
  statSync: vi.fn().mockReturnValue({ size: 1024 }),
}))

vi.mock('node:os', () => ({ tmpdir: () => '/tmp' }))
vi.mock('node:crypto', () => ({ randomUUID: () => 'test-uuid' }))

vi.mock('../server-url.js', () => ({
  getArtifactDownloadUrl: vi.fn((id: string) => `http://localhost:3502/api/artifacts/${id}`),
  getShareUrl: vi.fn((id: string) => `http://localhost:3502/s/${id}`),
}))

vi.mock('../artifact-links.js', () => ({ buildFeishuArtifactSection: vi.fn(() => null) }))

vi.mock('../feishu-card-streaming.js', () => ({
  FeishuStreamingCard: {
    create: vi.fn().mockResolvedValue({
      send: vi.fn(),
      updateContent: mockStreamingCardUpdateContent,
      finish: mockStreamingCardFinish,
      getMessageId: vi.fn().mockReturnValue('om_card_test'),
      getCardId: vi.fn().mockReturnValue('card_test_id'),
    }),
  },
}))

vi.mock('../streaming-card-registry.js', () => ({
  registerStreamingCard: vi.fn(),
  touchStreamingCard: vi.fn(),
  unregisterStreamingCard: vi.fn(),
}))

import { type FeishuConfig, feishuConnectionManager } from '../feishu-service.js'

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

const TRIGGER_OPEN_ID = 'ou_trigger_user'
const CREATOR_OPEN_ID = 'ou_topic_creator'

/** A topic reply below the root — the only shape that can resolve a topic creator. */
let messageSeq = 0

function makeTopicReply(overrides: Record<string, unknown> = {}) {
  messageSeq += 1
  return {
    message_type: 'text',
    // Unique per dispatch: feishu-service keeps a per-process `agentId:messageId`
    // dedup cache that would silently drop a replayed id in a later test.
    message_id: `om_reply_${messageSeq}`,
    chat_id: 'oc_chat001',
    chat_type: 'group',
    thread_id: 'omt_thread001',
    root_id: 'om_root',
    content: JSON.stringify({ text: '@_user_1 请处理' }),
    mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot_test' } }],
    ...overrides,
  }
}

function makeData(msgOverrides: Record<string, unknown> = {}) {
  return {
    message: makeTopicReply(msgOverrides),
    sender: { sender_type: 'user', sender_id: { open_id: TRIGGER_OPEN_ID } },
  }
}

function rootSenderResponse(sender: Record<string, unknown>, content?: string) {
  return {
    data: {
      items: [
        {
          sender,
          msg_type: 'text',
          body: { content: content ?? JSON.stringify({ text: '根消息正文' }) },
        },
      ],
    },
  }
}

/** Outgoing reply payloads, whichever send path (quote reply / new message) was taken. */
function replyCalls() {
  return [...mockImMessageReply.mock.calls, ...mockImMessageCreate.mock.calls]
}

/** The raw serialized content of the single outgoing reply. */
function sentReplyContent(): string {
  const calls = replyCalls()
  if (calls.length === 0) throw new Error('no reply was sent')
  return calls[0][0].data.content as string
}

/** The decoded text of the single outgoing reply (text replies only). */
function sentReplyText(): string {
  return JSON.parse(sentReplyContent()).text as string
}

/** The warning must name the party that went un-mentioned, not the triggering bot. */
function warnedAboutMissingCreator(): boolean {
  return mockLoggerWarn.mock.calls.some((call) =>
    String(call[1]).includes('will not mention the topic creator'),
  )
}

async function startAndDispatch(config: Partial<FeishuConfig>, data: unknown) {
  const merged = { ...BASE_CONFIG, ...config } as FeishuConfig
  await feishuConnectionManager.start('agt_001', merged)
  mockDbGet.mockReturnValue({
    id: 'agt_001',
    name: 'Test Agent',
    publishStatus: 'published',
    maxConcurrency: 1,
    feishuConfig: merged,
  })
  const handler = capturedDispatchers['im.message.receive_v1']
  if (!handler) throw new Error('Dispatcher handler not captured')
  handler(data)
  // handleMessage is fire-and-forget: drain the macrotask queue until the reply
  // lands rather than guessing a fixed number of awaits.
  for (let tick = 0; tick < 50 && replyCalls().length === 0; tick++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

describe('Feishu topic reply mention wiring', () => {
  beforeEach(() => {
    feishuConnectionManager.stopAll()
    vi.clearAllMocks()
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_bot_test' } })
    mockImMessageReply.mockResolvedValue({})
    mockImMessageCreate.mockResolvedValue({})
    mockImMessageReactionCreate.mockResolvedValue({})
    mockBuildAgentConfig.mockReturnValue({ engineType: 'cursor', model: 'gpt-4o', maxRetries: 0 })
    mockResolveWorkDir.mockResolvedValue('/tmp/workdir')
    mockTryAcquireSlot.mockReturnValue('acquired')
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: true, output: 'Agent 回复' },
      retries: [],
    })
  })

  it('mentions the topic creator, fetching the root even with content injection off', async () => {
    mockImMessageGet.mockResolvedValue(
      rootSenderResponse({ id: CREATOR_OPEN_ID, id_type: 'open_id', sender_type: 'user' }),
    )

    await startAndDispatch(
      { topicReplyMentionTarget: 'topic_creator', topicInjectRootMessage: false },
      makeData(),
    )

    expect(mockImMessageGet).toHaveBeenCalledExactlyOnceWith({ path: { message_id: 'om_root' } })
    expect(sentReplyText()).toContain(`<at user_id="${CREATOR_OPEN_ID}"></at>`)
    // The root body must NOT leak into the prompt when injection is off.
    expect(mockExecuteWithRetry.mock.calls[0][1].prompt).not.toContain('根消息正文')
  })

  it('shares one root-message fetch between content injection and the mention lookup', async () => {
    mockImMessageGet.mockResolvedValue(
      rootSenderResponse({ id: CREATOR_OPEN_ID, id_type: 'open_id', sender_type: 'user' }),
    )

    await startAndDispatch(
      { topicReplyMentionTarget: 'topic_creator', topicInjectRootMessage: true },
      makeData(),
    )

    expect(mockImMessageGet).toHaveBeenCalledOnce()
    expect(mockExecuteWithRetry.mock.calls[0][1].prompt).toContain('根消息正文')
    expect(sentReplyText()).toContain(`<at user_id="${CREATOR_OPEN_ID}"></at>`)
  })

  it('mentions nobody and warns when the root sender lookup fails', async () => {
    mockImMessageGet.mockRejectedValue(new Error('missing im:message.group_msg'))

    await startAndDispatch({ topicReplyMentionTarget: 'topic_creator' }, makeData())

    expect(sentReplyText()).not.toContain('<at ')
    expect(warnedAboutMissingCreator()).toBe(true)
  })

  it('never falls back to the triggering bot when the root was sent by a bot', async () => {
    mockImMessageGet.mockResolvedValue(
      rootSenderResponse({ id: 'ou_bot_test', id_type: 'open_id', sender_type: 'app' }),
    )

    await startAndDispatch({ topicReplyMentionTarget: 'topic_creator' }, makeData())

    expect(sentReplyText()).not.toContain('<at ')
    expect(warnedAboutMissingCreator()).toBe(true)
  })

  it('mentions the trigger sender without any root lookup by default', async () => {
    await startAndDispatch({ topicReplyMentionTarget: 'trigger_sender' }, makeData())

    expect(mockImMessageGet).not.toHaveBeenCalled()
    expect(sentReplyText()).toContain(`<at user_id="${TRIGGER_OPEN_ID}"></at>`)
  })

  it('mentions nobody without any root lookup when the target is none', async () => {
    await startAndDispatch({ topicReplyMentionTarget: 'none' }, makeData())

    expect(mockImMessageGet).not.toHaveBeenCalled()
    expect(sentReplyText()).not.toContain('<at ')
  })

  it('skips the root lookup for card replies, which cannot render a text mention', async () => {
    await startAndDispatch(
      { topicReplyMentionTarget: 'topic_creator', replyContentType: 'interactive' },
      makeData(),
    )

    expect(mockImMessageGet).not.toHaveBeenCalled()
    expect(sentReplyContent()).not.toContain('<at ')
  })

  it('keeps the historical trigger-sender mention for non-topic group replies', async () => {
    await startAndDispatch(
      { topicReplyMentionTarget: 'topic_creator' },
      makeData({ thread_id: undefined, root_id: undefined }),
    )

    expect(mockImMessageGet).not.toHaveBeenCalled()
    expect(sentReplyText()).toContain(`<at user_id="${TRIGGER_OPEN_ID}"></at>`)
  })

  it('suppresses the mention in ordinary group replies when the target is none', async () => {
    // Unlike the two "whom to mention" targets, none is an explicit opt-out and applies
    // to every group reply — a half-applied switch reads as a bug to whoever set it.
    await startAndDispatch(
      { topicReplyMentionTarget: 'none' },
      makeData({ thread_id: undefined, root_id: undefined }),
    )

    expect(mockImMessageGet).not.toHaveBeenCalled()
    expect(sentReplyText()).not.toContain('<at ')
  })

  it('reuses the dispatch-resolved mention for the failure reply without a second lookup', async () => {
    mockImMessageGet.mockResolvedValue(
      rootSenderResponse({ id: CREATOR_OPEN_ID, id_type: 'open_id', sender_type: 'user' }),
    )
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: false, output: '', error: 'engine exploded' },
      retries: [],
    })

    await startAndDispatch({ topicReplyMentionTarget: 'topic_creator' }, makeData())

    expect(mockImMessageGet).toHaveBeenCalledOnce()
    const text = sentReplyText()
    expect(text).toContain(`<at user_id="${CREATOR_OPEN_ID}"></at>`)
    expect(text).not.toContain('engine exploded')
  })

  it('does not re-query the root for the failure reply after the mention lookup failed', async () => {
    mockImMessageGet.mockRejectedValue(new Error('missing im:message.group_msg'))
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: false, output: '', error: 'engine exploded' },
      retries: [],
    })

    await startAndDispatch({ topicReplyMentionTarget: 'topic_creator' }, makeData())

    // An explicit null override means "already resolved to nobody" — a second
    // self-resolve here would repeat the request that just failed.
    expect(mockImMessageGet).toHaveBeenCalledOnce()
    expect(sentReplyText()).not.toContain('<at ')
  })

  it('mentions the trigger sender on failure replies when the target is the default', async () => {
    mockExecuteWithRetry.mockResolvedValue({
      result: { success: false, output: '', error: 'engine exploded' },
      retries: [],
    })

    await startAndDispatch({ topicReplyMentionTarget: 'trigger_sender' }, makeData())

    expect(mockImMessageGet).not.toHaveBeenCalled()
    expect(sentReplyText()).toContain(`<at user_id="${TRIGGER_OPEN_ID}"></at>`)
  })
})
