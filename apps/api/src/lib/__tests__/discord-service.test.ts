import { describe, expect, it, vi } from 'vitest'
import {
  DiscordConnectionManager,
  buildDiscordConversationId,
  extractDiscordNativeAttachments,
  shouldTriggerDiscordMessage,
  stripDiscordBotMention,
} from '../discord-service.js'

const config = {
  guildTriggerOnMention: true,
  guildTriggerOnNewMessage: false,
}

describe('Discord service helpers', () => {
  it('always accepts human direct messages', async () => {
    expect(
      shouldTriggerDiscordMessage(config, {
        authorId: 'U123',
        authorIsBot: false,
        channelId: 'D123',
        messageId: 'M123',
        content: 'hello',
      }),
    ).toBe(true)
  })

  it('requires the bot mention in guild channels by default', async () => {
    const message = {
      authorId: 'U123',
      authorIsBot: false,
      guildId: 'G123',
      channelId: 'C123',
      messageId: 'M123',
      content: 'hello',
      mentionedUserIds: [] as string[],
    }
    expect(shouldTriggerDiscordMessage(config, message, 'BOT')).toBe(false)
    expect(
      shouldTriggerDiscordMessage(config, { ...message, mentionedUserIds: ['BOT'] }, 'BOT'),
    ).toBe(true)
  })

  it('accepts every human guild message when the all-message trigger is enabled', async () => {
    expect(
      shouldTriggerDiscordMessage(
        {
          guildTriggerOnMention: true,
          guildTriggerOnNewMessage: true,
        },
        {
          authorId: 'U123',
          authorIsBot: false,
          guildId: 'G123',
          channelId: 'C123',
          messageId: 'M123',
          content: 'hello without a mention',
          mentionedUserIds: [],
        },
        'BOT',
      ),
    ).toBe(true)
  })

  it('applies message behavior changes without reconnecting a ready Gateway client', async () => {
    const destroy = vi.fn()
    const previousConnection = {
      config: {
        applicationId: 'APP',
        botToken: 'discord-test',
        guildTriggerOnMention: true,
        guildTriggerOnNewMessage: false,
        guildReplyMode: 'reply' as const,
        dmReplyMode: 'reply' as const,
        sendArtifactsAsFile: true,
      },
      client: {
        isReady: () => true,
        destroy,
      },
    }
    const manager = new DiscordConnectionManager()
    const internals = manager as unknown as {
      connections: Map<string, typeof previousConnection>
      applicationHolders: Map<string, string>
    }
    internals.connections.set('agt_1', previousConnection)
    internals.applicationHolders.set('APP', 'agt_1')

    await manager.start('agt_1', {
      ...previousConnection.config,
      guildTriggerOnMention: false,
      guildTriggerOnNewMessage: true,
      guildReplyMode: 'new',
    })

    expect(previousConnection.config).toEqual(
      expect.objectContaining({
        guildTriggerOnMention: false,
        guildTriggerOnNewMessage: true,
        guildReplyMode: 'new',
      }),
    )
    expect(destroy).not.toHaveBeenCalled()
  })

  it('ignores bot messages', async () => {
    expect(
      shouldTriggerDiscordMessage(config, {
        authorId: 'BOT2',
        authorIsBot: true,
        channelId: 'D123',
        messageId: 'M123',
        content: 'hello',
      }),
    ).toBe(false)
  })

  it('extracts durable attachment ids without persisting signed CDN URLs', async () => {
    expect(
      extractDiscordNativeAttachments({
        authorId: 'U123',
        authorIsBot: false,
        guildId: 'G123',
        channelId: 'C123',
        messageId: 'M123',
        content: '',
        attachments: [
          {
            id: 'ATT123',
            name: 'diagram.png',
            contentType: 'image/png',
            size: 128,
            url: 'https://cdn.discordapp.com/attachments/C123/ATT123/diagram.png?ex=signed',
          },
        ],
      }),
    ).toEqual([
      {
        source: 'discord',
        remoteId: 'ATT123',
        channelId: 'C123',
        messageId: 'M123',
        name: 'diagram.png',
        mimeType: 'image/png',
        size: 128,
      },
    ])
  })

  it('keeps direct messages and per-user guild conversations stable', async () => {
    expect(
      buildDiscordConversationId('APP', {
        authorId: 'U123',
        channelId: 'D123',
        messageId: 'M123',
      }),
    ).toBe('APP:D123')
    expect(
      buildDiscordConversationId('APP', {
        authorId: 'U123',
        guildId: 'G123',
        channelId: 'C123',
        messageId: 'M123',
      }),
    ).toBe('G123:C123:U123')
  })

  it('removes both supported forms of the receiving bot mention', async () => {
    expect(stripDiscordBotMention('<@BOT> hello <@!BOT>', 'BOT')).toBe('hello')
  })

  it('uploads Agent artifacts as safe replies to the original Discord message', async () => {
    const reply = vi.fn().mockResolvedValue(undefined)
    const fetchMessage = vi.fn().mockResolvedValue({ reply })
    const fetchChannel = vi.fn().mockResolvedValue({
      isTextBased: () => true,
      send: vi.fn(),
      messages: { fetch: fetchMessage },
    })
    const manager = new DiscordConnectionManager()
    ;(
      manager as unknown as {
        connections: Map<string, unknown>
      }
    ).connections.set('agt_1', {
      config: {
        applicationId: 'APP',
        botToken: 'discord-test',
        guildTriggerOnMention: true,
        guildTriggerOnNewMessage: false,
        guildReplyMode: 'reply',
        dmReplyMode: 'reply',
        sendArtifactsAsFile: true,
      },
      client: {
        isReady: () => true,
        channels: { fetch: fetchChannel },
      },
    })

    await manager.sendRunResultByContext(
      'agt_1',
      {
        channel_type: 'discord',
        channel_info: {
          application_id: 'APP',
          channel_id: 'C123',
          chat_type: 'guild',
          message_id: 'M123',
          sender_user_id: 'U123',
        },
        user_info: null,
      },
      [
        'Done',
        '',
        '[Download report](sandbox:/tmp/a2wave-sandbox/artifacts/report.pdf)',
        '',
        '---',
        '**产物下载**',
        '- [report.pdf](http://localhost:3502/api/artifacts/art_1/download)',
      ].join('\n'),
      [
        {
          id: 'art_1',
          filename: 'report.pdf',
          storagePath: '/artifacts/report.pdf',
          kind: 'file',
          mimeType: 'application/pdf',
          agentId: 'agt_1',
        },
      ],
    )

    expect(fetchMessage).toHaveBeenCalledOnce()
    const textReply = reply.mock.calls[0]?.[0] as { content: string }
    expect(textReply.content).not.toContain('sandbox:')
    expect(textReply.content).not.toContain('产物下载')
    expect(textReply.content).not.toContain('localhost:3502')
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [{ attachment: '/artifacts/report.pdf', name: 'report.pdf' }],
        allowedMentions: { parse: [], repliedUser: false },
      }),
    )
  })
})
