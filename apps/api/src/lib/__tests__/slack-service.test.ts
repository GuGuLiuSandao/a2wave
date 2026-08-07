import { describe, expect, it, vi } from 'vitest'

vi.mock('../artifact-links.js', () => ({
  buildArtifactLinkLinesSync: (
    artifacts: Array<{
      id: string
      filename: string
    }>,
  ) =>
    artifacts
      .map(
        (artifact) =>
          `- [${artifact.filename}](https://a2wave.example.com/api/artifacts/${artifact.id}/download)`,
      )
      .join('\n'),
}))

import {
  SlackConnectionManager,
  buildSlackConversationId,
  extractSlackNativeAttachments,
  shouldTriggerSlackEvent,
  stripSlackBotMention,
} from '../slack-service.js'

const config = {
  groupTriggerOnAt: true,
  groupTriggerOnNewMessage: false,
}

describe('Slack service helpers', () => {
  it('always accepts human direct messages', async () => {
    expect(
      shouldTriggerSlackEvent(config, {
        type: 'message',
        channel: 'D123',
        channel_type: 'im',
        user: 'U123',
        text: 'hello',
        ts: '1710000000.000001',
      }),
    ).toBe(true)
  })

  it('requires a bot mention in channels by default', async () => {
    const event = {
      type: 'message',
      channel: 'C123',
      channel_type: 'channel',
      user: 'U123',
      text: 'hello',
      ts: '1710000000.000001',
    }
    expect(shouldTriggerSlackEvent(config, event, 'UBOT')).toBe(false)
    expect(shouldTriggerSlackEvent(config, { ...event, text: '<@UBOT> hello' }, 'UBOT')).toBe(true)
  })

  it('ignores bot and edited/deleted message events', async () => {
    const event = {
      type: 'message',
      channel: 'C123',
      channel_type: 'channel',
      user: 'U123',
      text: '<@UBOT> hello',
      ts: '1710000000.000001',
    }
    expect(shouldTriggerSlackEvent(config, { ...event, bot_id: 'B123' }, 'UBOT')).toBe(false)
    expect(shouldTriggerSlackEvent(config, { ...event, subtype: 'message_changed' }, 'UBOT')).toBe(
      false,
    )
  })

  it('accepts Slack file_share events and extracts durable file ids without private URLs', async () => {
    const event = {
      type: 'message',
      channel: 'D123',
      channel_type: 'im',
      user: 'U123',
      text: '',
      ts: '1710000000.000001',
      subtype: 'file_share',
      files: [
        {
          id: 'F123',
          name: 'report.pdf',
          mimetype: 'application/pdf',
          size: 42,
          url_private_download: 'https://files.slack.com/files-pri/T-F/download/report.pdf',
        },
      ],
    }

    expect(shouldTriggerSlackEvent(config, event)).toBe(true)
    expect(extractSlackNativeAttachments(event)).toEqual([
      {
        source: 'slack',
        remoteId: 'F123',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        size: 42,
      },
    ])
  })

  it('keeps direct messages together and scopes channel threads separately', async () => {
    expect(
      buildSlackConversationId('T123', {
        channel: 'D123',
        channel_type: 'im',
        ts: '1710000000.000001',
      }),
    ).toBe('T123:D123')
    expect(
      buildSlackConversationId('T123', {
        channel: 'C123',
        channel_type: 'channel',
        ts: '1710000000.000001',
        thread_ts: '1700000000.000001',
      }),
    ).toBe('T123:C123:1700000000.000001')
  })

  it('removes only the receiving bot mention from the prompt', async () => {
    expect(stripSlackBotMention('<@UBOT> ask <@UOTHER> for help', 'UBOT')).toBe(
      'ask <@UOTHER> for help',
    )
  })

  it('neutralizes outbound Slack mentions without changing ordinary links', async () => {
    const postMessage = vi.fn().mockResolvedValue(undefined)
    const manager = new SlackConnectionManager()
    ;(
      manager as unknown as {
        connections: Map<string, unknown>
      }
    ).connections.set('agt_1', {
      config: {
        appId: 'A123',
        appToken: 'xapp-test',
        botToken: 'xoxb-test',
        groupTriggerOnAt: true,
        groupTriggerOnNewMessage: false,
        groupReplyMode: 'new',
        p2pReplyMode: 'new',
        sendArtifactsAsFile: true,
      },
      web: { chat: { postMessage }, filesUploadV2: vi.fn() },
    })

    await manager.sendMessageByContext(
      'agt_1',
      {
        channel_type: 'slack',
        channel_info: {
          app_id: 'A123',
          team_id: 'T123',
          channel_id: 'C123',
          chat_type: 'channel',
          message_ts: '1710000000.000001',
          sender_user_id: 'U123',
        },
        user_info: null,
      },
      'Review <!channel> <!here> <!everyone> <@U123> <!subteam^S123> <https://example.com|link>',
    )

    const message = postMessage.mock.calls[0]?.[0] as {
      text: string
      blocks: Array<{ text: string }>
    }
    for (const rendered of [message.text, message.blocks[0]?.text]) {
      expect(rendered).not.toContain('<!channel>')
      expect(rendered).not.toContain('<!here>')
      expect(rendered).not.toContain('<!everyone>')
      expect(rendered).not.toContain('<@U123>')
      expect(rendered).not.toContain('<!subteam^S123>')
      expect(rendered).toContain('<https://example.com|link>')
    }
  })

  it('renders standard Markdown and uploads Agent artifacts into the configured Slack thread', async () => {
    const postMessage = vi.fn().mockResolvedValue(undefined)
    const filesUploadV2 = vi.fn().mockResolvedValue(undefined)
    const manager = new SlackConnectionManager()
    ;(
      manager as unknown as {
        connections: Map<string, unknown>
      }
    ).connections.set('agt_1', {
      config: {
        appId: 'A123',
        appToken: 'xapp-test',
        botToken: 'xoxb-test',
        groupTriggerOnAt: true,
        groupTriggerOnNewMessage: false,
        groupReplyMode: 'thread',
        p2pReplyMode: 'new',
        sendArtifactsAsFile: true,
      },
      web: { chat: { postMessage }, filesUploadV2 },
    })

    const output = [
      '### Gold price table',
      '',
      '| Date | Price |',
      '| --- | --- |',
      '| **July 23** | **$4,123.47** |',
      '',
      '[Download report](sandbox:/tmp/a2wave-sandbox/artifacts/report.pdf)',
      '',
      '---',
      '**产物下载**',
      '- [report.pdf](http://localhost:3502/api/artifacts/art_1/download)',
    ].join('\n')

    await manager.sendRunResultByContext(
      'agt_1',
      {
        channel_type: 'slack',
        channel_info: {
          app_id: 'A123',
          team_id: 'T123',
          channel_id: 'C123',
          chat_type: 'channel',
          message_ts: '1710000000.000001',
          sender_user_id: 'U123',
        },
        user_info: null,
      },
      output,
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

    const message = postMessage.mock.calls[0]?.[0] as {
      text: string
      blocks: Array<{ type: string; text: string }>
      channel: string
      thread_ts: string
    }
    expect(message.channel).toBe('C123')
    expect(message.thread_ts).toBe('1710000000.000001')
    expect(message.text).not.toContain('###')
    expect(message.blocks).toHaveLength(1)
    expect(message.blocks[0]).toEqual({
      type: 'markdown',
      text: expect.stringContaining('### Gold price table'),
    })
    expect(message.blocks[0]?.text).toContain('| **July 23** | **$4,123.47** |')
    expect(message.blocks[0]?.text).not.toContain('sandbox:')
    expect(message.blocks[0]?.text).not.toContain('产物下载')
    expect(message.blocks[0]?.text).not.toContain('localhost:3502')
    expect(filesUploadV2).toHaveBeenCalledWith({
      channel_id: 'C123',
      thread_ts: '1710000000.000001',
      file: '/artifacts/report.pdf',
      filename: 'report.pdf',
      title: 'report.pdf',
    })
  })

  it('keeps a download fallback when a Slack artifact upload fails', async () => {
    const postMessage = vi.fn().mockResolvedValue(undefined)
    const filesUploadV2 = vi.fn().mockRejectedValue(new Error('upload failed'))
    const manager = new SlackConnectionManager()
    ;(
      manager as unknown as {
        connections: Map<string, unknown>
      }
    ).connections.set('agt_1', {
      config: {
        appId: 'A123',
        appToken: 'xapp-test',
        botToken: 'xoxb-test',
        groupTriggerOnAt: true,
        groupTriggerOnNewMessage: false,
        groupReplyMode: 'thread',
        p2pReplyMode: 'new',
        sendArtifactsAsFile: true,
      },
      web: { chat: { postMessage }, filesUploadV2 },
    })

    await manager.sendRunResultByContext(
      'agt_1',
      {
        channel_type: 'slack',
        channel_info: {
          app_id: 'A123',
          team_id: 'T123',
          channel_id: 'C123',
          chat_type: 'channel',
          message_ts: '1710000000.000001',
          sender_user_id: 'U123',
        },
        user_info: null,
      },
      [
        'Done',
        '',
        '---',
        '**产物下载**',
        '- [report.pdf](https://a2wave.example.com/api/artifacts/art_1/download)',
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

    expect(postMessage).toHaveBeenCalledTimes(2)
    const fallback = postMessage.mock.calls[1]?.[0] as {
      blocks: Array<{ type: string; text: string }>
    }
    expect(fallback.blocks[0]?.text).toContain('report.pdf')
    expect(fallback.blocks[0]?.text).toContain('/api/artifacts/art_1/download')
  })
})
