import { type RunChannelContextSlack, type SlackConfig, slackConfigSchema } from '@a2wave/shared'
import { SocketModeClient } from '@slack/socket-mode'
import { WebClient } from '@slack/web-api'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agents } from '../db/schema.js'
import { buildArtifactLinkLinesSync } from './artifact-links.js'
import type { RegisteredArtifact } from './artifact-storage.js'
import { logger } from './logger.js'
import { prepareNativeArtifactUpload } from './native-chat-artifacts.js'
import type { NativeChatAttachment } from './native-chat-attachments.js'
import { reserveNativeChatRun } from './native-chat-runner.js'
import { appendNativeArtifactDownloadSection, prepareNativeChatText } from './native-chat-text.js'
import { buildSlackChannel } from './run-channel.js'

type NormalizedSlackConfig = ReturnType<typeof slackConfigSchema.parse>

export interface SlackMessageEvent {
  type: string
  channel: string
  channel_type?: string
  user?: string
  text?: string
  ts?: string
  thread_ts?: string
  subtype?: string
  bot_id?: string
  files?: SlackFileEvent[]
}

export interface SlackFileEvent {
  id?: string
  name?: string
  title?: string
  mimetype?: string
  size?: number
  url_private?: string
  url_private_download?: string
}

interface SlackEventEnvelope {
  ack: () => Promise<void>
  body?: { event_id?: string; team_id?: string }
  event?: SlackMessageEvent
}

interface SlackConnection {
  config: NormalizedSlackConfig
  socket: SocketModeClient
  web: WebClient
  botUserId: string
  teamId: string
  socketOpen: boolean
}

export function shouldTriggerSlackEvent(
  config: Pick<NormalizedSlackConfig, 'groupTriggerOnAt' | 'groupTriggerOnNewMessage'>,
  event: SlackMessageEvent,
  botUserId?: string,
): boolean {
  if (
    !event.user ||
    !event.channel ||
    !event.ts ||
    event.bot_id ||
    (event.subtype && event.subtype !== 'file_share')
  ) {
    return false
  }
  const isDirectMessage = event.channel_type === 'im' || event.channel.startsWith('D')
  if (isDirectMessage) return true
  const isMentioned = botUserId ? (event.text ?? '').includes(`<@${botUserId}>`) : false
  return (config.groupTriggerOnAt && isMentioned) || config.groupTriggerOnNewMessage
}

export function extractSlackNativeAttachments(
  event: Pick<SlackMessageEvent, 'files'>,
): NativeChatAttachment[] {
  return (event.files ?? []).flatMap((file) => {
    if (!file.id) return []
    return [
      {
        source: 'slack' as const,
        remoteId: file.id,
        name: file.name ?? file.title ?? `slack-file-${file.id}`,
        ...(file.mimetype ? { mimeType: file.mimetype } : {}),
        ...(file.size != null ? { size: file.size } : {}),
      },
    ]
  })
}

export function stripSlackBotMention(text: string, botUserId: string): string {
  return text.replaceAll(`<@${botUserId}>`, '').replace(/\s+/g, ' ').trim()
}

export function buildSlackConversationId(
  teamId: string,
  event: Pick<SlackMessageEvent, 'channel' | 'channel_type' | 'ts' | 'thread_ts'>,
): string {
  const isDirectMessage = event.channel_type === 'im' || event.channel.startsWith('D')
  if (isDirectMessage) return `${teamId}:${event.channel}`
  return `${teamId}:${event.channel}:${event.thread_ts ?? event.ts}`
}

const SLACK_MARKDOWN_BLOCK_LIMIT = 12_000
const SLACK_MARKDOWN_CHUNK_LIMIT = 11_500

function chunkSlackText(text: string): string[] {
  if (text.length <= SLACK_MARKDOWN_BLOCK_LIMIT) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > SLACK_MARKDOWN_BLOCK_LIMIT) {
    let splitAt = remaining.lastIndexOf('\n\n', SLACK_MARKDOWN_CHUNK_LIMIT)
    if (splitAt < SLACK_MARKDOWN_CHUNK_LIMIT / 2) {
      splitAt = remaining.lastIndexOf('\n', SLACK_MARKDOWN_CHUNK_LIMIT)
    }
    if (splitAt < SLACK_MARKDOWN_CHUNK_LIMIT / 2) splitAt = SLACK_MARKDOWN_CHUNK_LIMIT
    chunks.push(remaining.slice(0, splitAt).trim())
    remaining = remaining.slice(splitAt).trim()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

function buildSlackPlainTextFallback(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^(```)[^\n]*$/gm, '')
    .replace(/^[ \t]*\|?[ \t:|\-]+\|?[ \t]*$/gm, '')
    .replace(/!\[([^\]\n]*)\]\(([^)\n]+)\)/g, '$1 ($2)')
    .replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '$1: $2')
    .replaceAll('**', '')
    .replaceAll('__', '')
    .replaceAll('~~', '')
    .replace(/^---+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Slack treats angle-bracket control sequences as broadcast, user, or user-group
 * mentions. Insert an invisible separator so untrusted Agent output is rendered
 * as text instead of notifying workspace members.
 */
export function neutralizeSlackMentions(text: string): string {
  return text.replace(/<(?=[!@])/g, '<\u200b')
}

export class SlackConnectionManager {
  private readonly connections = new Map<string, SlackConnection>()
  private readonly appHolders = new Map<string, string>()

  async start(agentId: string, rawConfig: SlackConfig | Record<string, unknown>): Promise<void> {
    const config = slackConfigSchema.parse(rawConfig)
    const holder = this.appHolders.get(config.appId)
    if (holder && holder !== agentId) {
      throw new Error(`Slack app ${config.appId} is already connected by Agent ${holder}`)
    }

    const previous = this.connections.get(agentId)
    if (previous) {
      this.connections.delete(agentId)
      if (this.appHolders.get(previous.config.appId) === agentId) {
        this.appHolders.delete(previous.config.appId)
      }
      previous.socketOpen = false
    }
    // Reserve synchronously before the first await so concurrent starters cannot both pass.
    this.appHolders.set(config.appId, agentId)

    try {
      if (previous) {
        await previous.socket
          .disconnect()
          .catch((error) =>
            logger.warn({ error, agentId }, 'Failed to replace the prior Slack connection cleanly'),
          )
      }
      const web = new WebClient(config.botToken)
      const auth = await web.auth.test()
      const botUserId = typeof auth.user_id === 'string' ? auth.user_id : ''
      const teamId = typeof auth.team_id === 'string' ? auth.team_id : ''
      if (!botUserId || !teamId)
        throw new Error('Slack auth.test did not return bot user or team id')

      const socket = new SocketModeClient({ appToken: config.appToken })
      const connection: SlackConnection = {
        config,
        socket,
        web,
        botUserId,
        teamId,
        socketOpen: false,
      }
      this.connections.set(agentId, connection)

      socket.on('connected', () => {
        connection.socketOpen = true
      })
      socket.on('disconnecting', () => {
        connection.socketOpen = false
      })
      socket.on('disconnected', (error?: unknown) => {
        connection.socketOpen = false
        if (error) logger.warn({ error, agentId }, 'Slack Socket Mode disconnected')
      })
      socket.on('error', (error: unknown) => {
        logger.error({ error, agentId }, 'Slack Socket Mode error')
      })

      const handleEvent = (envelope: SlackEventEnvelope) => {
        void this.handleEnvelope(agentId, connection, envelope).catch((error) =>
          logger.error({ error, agentId }, 'Slack event handler failed unexpectedly'),
        )
      }
      socket.on('message', handleEvent)
      socket.on('app_mention', handleEvent)
      await socket.start()
    } catch (error) {
      this.connections.delete(agentId)
      if (this.appHolders.get(config.appId) === agentId) this.appHolders.delete(config.appId)
      throw error
    }
  }

  private async handleEnvelope(
    agentId: string,
    connection: SlackConnection,
    envelope: SlackEventEnvelope,
  ): Promise<void> {
    const event = envelope.event
    if (!event || !shouldTriggerSlackEvent(connection.config, event, connection.botUserId)) {
      await envelope.ack()
      return
    }

    const nativeAttachments = extractSlackNativeAttachments(event)
    const textIntent = stripSlackBotMention(event.text ?? '', connection.botUserId)
    if (!textIntent && nativeAttachments.length === 0) {
      await envelope.ack()
      return
    }
    const intent = textIntent || 'Please review the attached files.'

    const isDirectMessage = event.channel_type === 'im' || event.channel.startsWith('D')
    const { ctx, displayName } = buildSlackChannel({
      appId: connection.config.appId,
      teamId: envelope.body?.team_id ?? connection.teamId,
      channelId: event.channel,
      messageTs: event.ts ?? '',
      ...(event.thread_ts ? { threadTs: event.thread_ts } : {}),
      senderUserId: event.user ?? '',
      chatType: isDirectMessage ? 'p2p' : 'channel',
    })
    const eventId =
      envelope.body?.event_id ??
      `slack:${connection.teamId}:${event.channel}:${event.ts ?? 'unknown'}`

    try {
      const result = await reserveNativeChatRun({
        agentId,
        source: 'slack',
        eventId,
        conversationId: buildSlackConversationId(connection.teamId, event),
        intent,
        channel: ctx as RunChannelContextSlack,
        displayName,
        nativeAttachments,
      })
      // Acknowledge only after the unique event reservation has committed.
      await envelope.ack()
      if (result.status === 'queue_full') {
        await this.sendMessageByContext(
          agentId,
          ctx as RunChannelContextSlack,
          'Agent queue is full.',
        )
      }
    } catch (error) {
      // No acknowledgement on persistence failure: Slack will redeliver the event.
      logger.error({ error, agentId, eventId }, 'Failed to reserve Slack event')
    }
  }

  async sendMessageByContext(
    agentId: string,
    context: RunChannelContextSlack,
    text: string,
  ): Promise<void> {
    await this.sendRunResultByContext(agentId, context, text, [])
  }

  async sendRunResultByContext(
    agentId: string,
    context: RunChannelContextSlack,
    text: string,
    artifacts: RegisteredArtifact[],
  ): Promise<void> {
    const info = context.channel_info
    const activeConnection = this.connections.get(agentId)
    let replyConnection: Pick<SlackConnection, 'config' | 'web'>
    if (activeConnection) {
      replyConnection = activeConnection
    } else {
      const agent = (
        await db
          .select({ slackConfig: agents.slackConfig })
          .from(agents)
          .where(eq(agents.id, agentId))
          .limit(1)
      )[0]
      if (!agent?.slackConfig) throw new Error('Slack configuration is unavailable')
      const config = slackConfigSchema.parse(agent.slackConfig)
      replyConnection = {
        config,
        web: new WebClient(config.botToken),
      }
    }

    const replyMode =
      info.chat_type === 'p2p'
        ? replyConnection.config.p2pReplyMode
        : replyConnection.config.groupReplyMode
    if (replyMode === 'none') return
    const threadTs = replyMode === 'thread' ? (info.thread_ts ?? info.message_ts) : undefined
    const postMarkdown = async (markdown: string): Promise<void> => {
      const neutralizedMarkdown = neutralizeSlackMentions(markdown)
      for (const chunk of chunkSlackText(neutralizedMarkdown)) {
        await replyConnection.web.chat.postMessage({
          channel: info.channel_id,
          text: buildSlackPlainTextFallback(chunk),
          blocks: [{ type: 'markdown', text: chunk }],
          ...(threadTs ? { thread_ts: threadTs } : {}),
        })
      }
    }
    const uploadArtifacts = replyConnection.config.sendArtifactsAsFile && artifacts.length > 0
    const preparedText = prepareNativeChatText(text, uploadArtifacts)
    if (preparedText) await postMarkdown(preparedText)
    if (!replyConnection.config.sendArtifactsAsFile) return

    const failedArtifacts: RegisteredArtifact[] = []
    for (const artifact of artifacts) {
      try {
        const upload = prepareNativeArtifactUpload(artifact)
        if (!upload) {
          failedArtifacts.push(artifact)
          continue
        }
        const uploadArgs = {
          channel_id: info.channel_id,
          file: upload.data,
          filename: upload.filename,
          title: upload.filename,
        }
        if (threadTs) {
          await replyConnection.web.filesUploadV2({ ...uploadArgs, thread_ts: threadTs })
        } else {
          await replyConnection.web.filesUploadV2(uploadArgs)
        }
      } catch (error) {
        failedArtifacts.push(artifact)
        logger.warn(
          { error, agentId, artifactId: artifact.id, filename: artifact.filename },
          'Failed to upload artifact to Slack',
        )
      }
    }
    if (failedArtifacts.length > 0) {
      await postMarkdown(
        appendNativeArtifactDownloadSection(
          '⚠️ Some artifacts could not be uploaded.',
          await buildArtifactLinkLinesSync(failedArtifacts),
        ),
      )
    }
  }

  async stop(agentId: string): Promise<void> {
    const connection = this.connections.get(agentId)
    if (!connection) return
    this.connections.delete(agentId)
    if (this.appHolders.get(connection.config.appId) === agentId) {
      this.appHolders.delete(connection.config.appId)
    }
    connection.socketOpen = false
    await connection.socket
      .disconnect()
      .catch((error) =>
        logger.warn({ error, agentId }, 'Failed to disconnect Slack Socket Mode cleanly'),
      )
  }

  stopAll(): void {
    for (const agentId of this.connections.keys()) void this.stop(agentId)
  }

  isRegistered(agentId: string): boolean {
    return this.connections.has(agentId)
  }

  isSocketOpen(agentId: string): boolean {
    return this.connections.get(agentId)?.socketOpen ?? false
  }

  getConnectionStatuses(): Array<{ agentId: string; socketOpen: boolean }> {
    return [...this.connections.entries()].map(([agentId, value]) => ({
      agentId,
      socketOpen: value.socketOpen,
    }))
  }

  async restoreConnections(): Promise<void> {
    const published = await (
      await db.select().from(agents).where(eq(agents.publishStatus, 'published'))
    ).filter((agent) => (agent.publishChannels ?? []).includes('slack') && agent.slackConfig)
    for (const agent of published) {
      try {
        await this.start(agent.id, agent.slackConfig as SlackConfig)
      } catch (error) {
        logger.error({ error, agentId: agent.id }, 'Failed to restore Slack connection')
      }
    }
  }
}

export const slackConnectionManager = new SlackConnectionManager()
