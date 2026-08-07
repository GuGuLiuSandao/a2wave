#!/usr/bin/env -S npx tsx
/**
 * Invoke a published a2wave Agent with the official A2A 1.0 JavaScript client.
 *
 * Prerequisites:
 * 1. Start a2wave with `pnpm run dev`.
 * 2. Publish an Agent with the A2A channel enabled.
 * 3. Set API_KEY when the Agent uses API-key authentication.
 *
 * Usage:
 *   pnpm a2a-demo -- agt_xxx "Hello" [--stream|--async]
 *   AGENT_ID=agt_xxx MESSAGE="Hello" API_KEY=xxx pnpm a2a-demo
 */

import { randomUUID } from 'node:crypto'
import {
  type Message,
  type Part,
  Role,
  type SendMessageRequest,
  type StreamResponse,
  type Task,
  TaskState,
} from '@a2a-js/sdk'
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
} from '@a2a-js/sdk/client'
import { endsCurrentInvocation, taskFailureLabel } from './a2a-demo-state.js'

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:3502'
const AGENT_ID = process.env.AGENT_ID ?? ''
const MESSAGE = process.env.MESSAGE ?? 'Hello, A2A!'
const API_KEY = process.env.API_KEY ?? ''
const DEBUG = process.env.DEBUG === '1' || process.env.A2A_DEMO_DEBUG === '1'
const TIMEOUT_MS = Number(process.env.TIMEOUT ?? 300_000)
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL ?? 2_000)

type Mode = 'blocking' | 'stream' | 'async'

function parseArgs(): { agentId: string; message: string; mode: Mode } {
  const args = process.argv.slice(2)
  let agentId = AGENT_ID
  let message = MESSAGE
  let mode: Mode = 'blocking'

  for (const arg of args) {
    if (arg === '--stream') mode = 'stream'
    else if (arg === '--async') mode = 'async'
    else if (arg.startsWith('agt_')) agentId = arg
    else if (!arg.startsWith('--')) message = arg
  }

  return { agentId, message, mode }
}

function createAuthFetch(apiKey: string): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${apiKey}`)
    return fetch(input, { ...init, headers })
  }
}

function textPart(text: string): Part {
  return {
    content: { $case: 'text', value: text },
    metadata: undefined,
    filename: '',
    mediaType: 'text/plain',
  }
}

function createRequest(text: string, returnImmediately: boolean): SendMessageRequest {
  return {
    tenant: '',
    message: {
      messageId: randomUUID(),
      contextId: '',
      taskId: '',
      role: Role.ROLE_USER,
      parts: [textPart(text)],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: {
      acceptedOutputModes: ['text/plain'],
      taskPushNotificationConfig: undefined,
      historyLength: undefined,
      returnImmediately,
    },
    metadata: undefined,
  }
}

function writeParts(parts: readonly Part[], trailingNewline = false): boolean {
  let wrote = false
  for (const part of parts) {
    if (part.content?.$case !== 'text' || !part.content.value) continue
    process.stdout.write(part.content.value)
    wrote = true
  }
  if (wrote && trailingNewline) process.stdout.write('\n')
  return wrote
}

function writeMessage(message: Message | undefined, trailingNewline = false): boolean {
  return message ? writeParts(message.parts, trailingNewline) : false
}

function isTask(value: Message | Task): value is Task {
  return 'status' in value
}

function printTaskResult(task: Task): void {
  const failureLabel = taskFailureLabel(task.status?.state)
  if (failureLabel) {
    process.stderr.write(`Agent ${failureLabel}: `)
    if (!writeMessage(task.status.message, true)) process.stderr.write('unknown error\n')
    process.exitCode = 1
    return
  }

  let wrote = writeMessage(task.status?.message, true)
  for (const artifact of task.artifacts) wrote = writeParts(artifact.parts, true) || wrote

  if (!wrote && task.status?.state === TaskState.TASK_STATE_COMPLETED) {
    console.log('(Task completed with no text output)')
  }
}

function writeStreamEvent(event: StreamResponse): boolean {
  const payload = event.payload
  if (!payload) return false

  if (DEBUG) process.stderr.write(`[DEBUG] stream event: ${payload.$case}\n`)

  switch (payload.$case) {
    case 'task': {
      const failureLabel = taskFailureLabel(payload.value.status?.state)
      if (failureLabel) {
        process.stderr.write(`[status] ${failureLabel}: `)
        if (!writeMessage(payload.value.status?.message, true))
          process.stderr.write('unknown error\n')
        process.exitCode = 1
      } else {
        writeMessage(payload.value.status?.message)
      }
      return endsCurrentInvocation(payload.value.status?.state)
    }
    case 'message':
      writeMessage(payload.value)
      return false
    case 'statusUpdate': {
      const failureLabel = taskFailureLabel(payload.value.status?.state)
      if (payload.value.status?.state === TaskState.TASK_STATE_WORKING) {
        if (!writeMessage(payload.value.status.message))
          process.stderr.write('[status] working...\n')
      } else if (failureLabel) {
        process.stderr.write(`[status] ${failureLabel}: `)
        if (!writeMessage(payload.value.status.message, true))
          process.stderr.write('unknown error\n')
        process.exitCode = 1
      } else {
        writeMessage(payload.value.status?.message)
      }
      return endsCurrentInvocation(payload.value.status?.state)
    }
    case 'artifactUpdate':
      if (payload.value.artifact) writeParts(payload.value.artifact.parts)
      return false
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runAsyncMode(
  client: Awaited<ReturnType<ClientFactory['createFromUrl']>>,
  request: SendMessageRequest,
): Promise<void> {
  process.stderr.write(
    `Async mode: submitting, then polling every ${POLL_INTERVAL_MS / 1000}s (timeout ${TIMEOUT_MS / 1000}s)\n`,
  )

  const submitted = await client.sendMessage(request)
  if (!isTask(submitted)) {
    writeMessage(submitted, true)
    return
  }

  process.stderr.write(`Task submitted: ${submitted.id} (state: ${submitted.status?.state})\n`)
  if (endsCurrentInvocation(submitted.status?.state)) {
    printTaskResult(submitted)
    return
  }

  const deadline = Date.now() + TIMEOUT_MS
  let pollCount = 0
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)
    pollCount++
    const task = await client.getTask({
      tenant: '',
      id: submitted.id,
      historyLength: undefined,
    })
    process.stderr.write(`Poll #${pollCount}: state=${task.status?.state ?? 'unknown'}\n`)
    if (endsCurrentInvocation(task.status?.state)) {
      printTaskResult(task)
      return
    }
  }

  throw new Error(`Task ${submitted.id} did not complete within ${TIMEOUT_MS / 1000}s`)
}

async function main(): Promise<void> {
  const { agentId, message, mode } = parseArgs()
  if (!agentId) {
    console.error('Usage: pnpm a2a-demo -- AGENT_ID [MESSAGE] [--stream|--async]')
    console.error('AGENT_ID is required. Copy it from the Agent detail page.')
    process.exit(1)
  }

  const agentBaseUrl = `${BASE_URL.replace(/\/$/, '')}/api/a2a/${agentId}/`
  const cardUrl = `${agentBaseUrl}.well-known/agent-card.json`
  console.log('A2A Demo — official A2A 1.0 client')
  console.log('---')
  console.log(`Agent Card: ${cardUrl}`)
  console.log(`Message: ${message}`)
  console.log(`Mode: ${mode}`)
  if (API_KEY) console.log('Auth: Bearer (API_KEY set)')
  console.log('---')

  const authFetch = API_KEY ? createAuthFetch(API_KEY) : undefined
  const options = authFetch
    ? ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
        transports: [
          new JsonRpcTransportFactory({
            fetchImpl: authFetch,
            legacyCompat: { enabled: true },
          }),
        ],
        cardResolver: new DefaultAgentCardResolver({
          fetchImpl: authFetch,
          legacyCompat: { enabled: true },
        }),
      })
    : ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
        transports: [new JsonRpcTransportFactory({ legacyCompat: { enabled: true } })],
        cardResolver: new DefaultAgentCardResolver({ legacyCompat: { enabled: true } }),
      })
  const client = await new ClientFactory(options).createFromUrl(agentBaseUrl)
  console.log(`Negotiated protocol: ${client.protocolVersion}`)

  const request = createRequest(message, mode === 'async')
  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), TIMEOUT_MS)
  try {
    if (mode === 'stream') {
      let eventCount = 0
      for await (const event of client.sendMessageStream(request, {
        signal: abortController.signal,
      })) {
        eventCount++
        if (writeStreamEvent(event)) break
      }
      process.stdout.write('\n')
      if (DEBUG) process.stderr.write(`[DEBUG] stream ended after ${eventCount} events\n`)
    } else if (mode === 'async') {
      await runAsyncMode(client, request)
    } else {
      const result = await client.sendMessage(request, { signal: abortController.signal })
      if (isTask(result)) printTaskResult(result)
      else if (!writeMessage(result, true)) console.log('(Message contained no text output)')
    }
  } finally {
    clearTimeout(timeout)
  }

  if (process.exitCode !== 1) {
    console.log('---')
    console.log('Done.')
  }
}

main().catch((error) => {
  console.error('Failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
