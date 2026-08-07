import {
  CancelTaskRequest,
  type SendMessageRequest,
  SubscribeToTaskRequest,
  TaskState,
} from '@a2a-js/sdk'
import { DefaultRequestHandler, InMemoryTaskStore, ServerCallContext } from '@a2a-js/sdk/server'
import { describe, expect, it, vi } from 'vitest'
import { buildAgentCard } from '../agent-card.js'
import { createScopedEventBusManager } from '../event-bus-manager.js'
import { A2waveAgentExecutor, type CancelFn, type ExecuteFn } from '../executor.js'

function callContext(owner = 'lifecycle-client') {
  return new ServerCallContext({
    requestedVersion: '1.0',
    tenant: 'agt_lifecycle',
    user: { isAuthenticated: true, userName: owner },
  })
}

function sendRequest(messageId: string): SendMessageRequest {
  return {
    tenant: '',
    message: {
      messageId,
      role: 1,
      parts: [
        {
          content: { $case: 'text', value: 'wait for lifecycle test' },
          mediaType: 'text/plain',
          filename: '',
          metadata: undefined,
        },
      ],
      contextId: '',
      taskId: '',
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: {
      returnImmediately: true,
      acceptedOutputModes: [],
      taskPushNotificationConfig: undefined,
    },
    metadata: undefined,
  }
}

function createHandler(
  taskStore: InMemoryTaskStore,
  context: ServerCallContext,
  executeFn: ExecuteFn,
  cancelFn: CancelFn = vi.fn<CancelFn>().mockResolvedValue('cancelled'),
) {
  const card = buildAgentCard(
    {
      id: 'agt_lifecycle',
      name: 'Lifecycle Agent',
      description: null,
      publishDescription: null,
      a2aAuthType: 'none',
      a2aSkills: [],
    },
    'https://example.com',
  )
  const eventBusManager = createScopedEventBusManager(context)
  return new DefaultRequestHandler(
    card,
    taskStore,
    new A2waveAgentExecutor({ agentConfig: {}, workDir: '/tmp' }, executeFn, cancelFn, (taskId) =>
      eventBusManager.wasReused(taskId),
    ),
    eventBusManager,
  )
}

function deferredExecution() {
  let resolve!: (result: Awaited<ReturnType<ExecuteFn>>) => void
  const promise = new Promise<Awaited<ReturnType<ExecuteFn>>>((settle) => {
    resolve = settle
  })
  const executeFn = vi.fn<ExecuteFn>(async (_taskId, _payload, options) => {
    executeFn.onUpdate = options?.onUpdate
    return await promise
  }) as ReturnType<typeof vi.fn<ExecuteFn>> & { onUpdate?: (content: string) => void }
  return { executeFn, resolve }
}

describe('A2A cross-request lifecycle', () => {
  it('cancels execution through a second request handler in the same caller scope', async () => {
    const context = callContext('cancel-client')
    const taskStore = new InMemoryTaskStore()
    const pending = deferredExecution()
    const firstHandler = createHandler(taskStore, context, pending.executeFn)

    const submitted = await firstHandler.sendMessage(sendRequest('msg-cancel'), context)
    expect('id' in submitted).toBe(true)
    if (!('id' in submitted)) throw new Error('Expected a task response')

    const cancelFn = vi.fn<CancelFn>().mockResolvedValue('cancelled')
    const secondHandler = createHandler(taskStore, context, pending.executeFn, cancelFn)
    const canceled = await secondHandler.cancelTask(
      CancelTaskRequest.fromJSON({ id: submitted.id }),
      context,
    )

    expect(cancelFn).toHaveBeenCalledWith(submitted.id)
    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED)

    pending.resolve({ success: false, output: '', error: 'cancelled', durationMs: 1 })
  })

  it('streams future events to a subscriber created by a second request handler', async () => {
    const context = callContext('subscribe-client')
    const taskStore = new InMemoryTaskStore()
    const pending = deferredExecution()
    const firstHandler = createHandler(taskStore, context, pending.executeFn)

    const submitted = await firstHandler.sendMessage(sendRequest('msg-subscribe'), context)
    expect('id' in submitted).toBe(true)
    if (!('id' in submitted)) throw new Error('Expected a task response')

    const secondHandler = createHandler(taskStore, context, pending.executeFn)
    const subscription = secondHandler.resubscribe(
      SubscribeToTaskRequest.fromJSON({ id: submitted.id }),
      context,
    )
    const snapshot = await subscription.next()
    expect(snapshot.value?.payload?.$case).toBe('task')

    pending.executeFn.onUpdate?.('future update')
    const update = await subscription.next()
    expect(update.value).toMatchObject({
      payload: {
        $case: 'statusUpdate',
        value: { taskId: submitted.id, status: { state: TaskState.TASK_STATE_WORKING } },
      },
    })

    pending.resolve({ success: true, output: 'done', durationMs: 1 })
    const remaining = []
    for await (const event of subscription) remaining.push(event)
    expect(remaining).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            $case: 'statusUpdate',
            value: expect.objectContaining({
              status: expect.objectContaining({ state: TaskState.TASK_STATE_COMPLETED }),
            }),
          }),
        }),
      ]),
    )
  })

  it('keeps a duplicate in-progress request attached until the original task completes', async () => {
    const context = callContext('duplicate-client')
    const taskStore = new InMemoryTaskStore()
    let resolveOriginal!: (result: Awaited<ReturnType<ExecuteFn>>) => void
    const original = new Promise<Awaited<ReturnType<ExecuteFn>>>((resolve) => {
      resolveOriginal = resolve
    })
    let callCount = 0
    const executeFn = vi.fn<ExecuteFn>(async () => {
      callCount += 1
      if (callCount === 1) return await original
      return {
        success: false,
        output: '',
        error: 'Task already in progress',
        durationMs: 0,
        inProgress: true,
      }
    })
    const firstHandler = createHandler(taskStore, context, executeFn)

    const submitted = await firstHandler.sendMessage(sendRequest('msg-original'), context)
    expect('id' in submitted).toBe(true)
    if (!('id' in submitted)) throw new Error('Expected a task response')

    const retryRequest = sendRequest('msg-retry')
    if (!retryRequest.message) throw new Error('Expected a retry message')
    retryRequest.message.taskId = submitted.id
    const secondHandler = createHandler(taskStore, context, executeFn)
    await secondHandler.sendMessage(retryRequest, context)
    expect(executeFn).toHaveBeenCalledTimes(2)

    resolveOriginal({ success: true, output: 'original result', durationMs: 1 })

    await vi.waitFor(async () => {
      const stored = await taskStore.load(submitted.id, context)
      expect(stored?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
      expect(stored?.artifacts).toHaveLength(1)
      expect(stored?.artifacts[0]?.parts[0]?.content).toEqual({
        $case: 'text',
        value: 'original result',
      })
      expect(stored?.history?.slice(0, 2).map((message) => message.messageId)).toEqual([
        'msg-original',
        'msg-retry',
      ])
    })
  })

  it('does not share an event bus between caller scopes', () => {
    const first = createScopedEventBusManager(callContext('scope-a'))
    const second = createScopedEventBusManager(callContext('scope-b'))

    expect(first.createOrGetByTaskId('same-task-id')).not.toBe(
      second.createOrGetByTaskId('same-task-id'),
    )
    first.cleanupByTaskId('same-task-id')
    second.cleanupByTaskId('same-task-id')
  })
})
