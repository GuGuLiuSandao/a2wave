import { describe, expect, it } from 'vitest'
import { runChannelContextSchema } from '../schemas/run-channel.js'

describe('QQ Official run channel context', () => {
  it('accepts a group message context without inventing an email identity', () => {
    expect(
      runChannelContextSchema.parse({
        channel_type: 'qq_official',
        channel_info: {
          app_id: '102000000',
          scene: 'group',
          message_id: 'msg-1',
          sender_open_id: 'member-open-id',
          group_open_id: 'group-open-id',
        },
        user_info: null,
      }),
    ).toMatchObject({
      channel_type: 'qq_official',
      channel_info: { scene: 'group', group_open_id: 'group-open-id' },
    })
  })

  it('rejects a group context without a group open id', () => {
    expect(
      runChannelContextSchema.safeParse({
        channel_type: 'qq_official',
        channel_info: {
          app_id: '102000000',
          scene: 'group',
          message_id: 'msg-1',
          sender_open_id: 'member-open-id',
        },
        user_info: null,
      }).success,
    ).toBe(false)
  })
})
