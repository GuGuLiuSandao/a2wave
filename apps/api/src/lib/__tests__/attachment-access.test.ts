import { afterEach, describe, expect, it, vi } from 'vitest'

const insertValues = vi.fn()
const onConflictRun = vi.fn()

const state = {
  ref: undefined as { runId: string } | undefined,
  run: undefined as { agentId: string | null } | undefined,
  perm: null as unknown,
  // getPinnedAttachmentTokens 的两个来源：
  refRows: [] as { token: string }[], // innerJoin(attachment_refs, runs).all()（已 materialize）
  metaRows: [] as { executionMetadata: { attachments?: { token: string }[] } | null }[], // runs.all()（queued）
}

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () =>
          asyncQuery({
            // canAccessAttachment：attachmentRefs.where(eq).all() → ref；runs.where(eq).get() → run。
            // getPinnedAttachmentTokens 第二查：runs.where(inArray).all() → metaRows。
            all: () => (state.metaRows.length > 0 ? state.metaRows : state.ref ? [state.ref] : []),
            get: () => state.run,
          }),
        // getPinnedAttachmentTokens 第一查：innerJoin(runs).where(...).all() → refRows。
        innerJoin: () => ({
          where: () => asyncQuery({ all: () => state.refRows }),
        }),
      }),
    }),
    insert: () => ({
      values: (rows: unknown) => {
        insertValues(rows)
        return { onConflictDoNothing: () => asyncQuery({ run: onConflictRun }) }
      },
    }),
  },
}))

vi.mock('../agent-access.js', () => ({
  loadAgentWithPerm: () => state.perm,
}))

vi.mock('../owner-filter.js', () => ({
  getCurrentUserId: () => 'usr_me',
}))

import {
  canAccessAttachment,
  getPinnedAttachmentTokens,
  recordAttachmentRefs,
} from '../attachment-access.js'

import { asyncQuery } from '../../test/async-query.js'

function ctx(role?: string) {
  return { get: (k: string) => (k === 'userRole' ? role : undefined) } as never
}

const meta = { name: 'a.png', mimeType: 'image/png', size: 1, createdAt: '' }

afterEach(() => {
  state.ref = undefined
  state.run = undefined
  state.perm = null
  state.refRows = []
  state.metaRows = []
  vi.clearAllMocks()
})

describe('getPinnedAttachmentTokens', () => {
  it('pins tokens from materialized refs (attachment_refs)', async () => {
    state.refRows = [{ token: 'att_a' }, { token: 'att_b' }]
    expect(await getPinnedAttachmentTokens()).toEqual(new Set(['att_a', 'att_b']))
  })

  it('pins queued tokens from executionMetadata (not yet in attachment_refs)', async () => {
    // 真实 queued 场景：attachment_refs 为空，token 只在 run 行 executionMetadata。
    state.refRows = []
    state.metaRows = [
      { executionMetadata: { attachments: [{ token: 'att_queued1' }, { token: 'att_queued2' }] } },
      { executionMetadata: null },
    ]
    expect(await getPinnedAttachmentTokens()).toEqual(new Set(['att_queued1', 'att_queued2']))
  })

  it('unions both sources', async () => {
    state.refRows = [{ token: 'att_mat' }]
    state.metaRows = [{ executionMetadata: { attachments: [{ token: 'att_queued' }] } }]
    expect(await getPinnedAttachmentTokens()).toEqual(new Set(['att_mat', 'att_queued']))
  })

  it('empty when none active', async () => {
    expect((await getPinnedAttachmentTokens()).size).toBe(0)
  })
})

describe('canAccessAttachment', () => {
  it('admin always allowed', async () => {
    expect(await canAccessAttachment(ctx('admin'), 'att_x', meta)).toBe(true)
  })

  it('uploader allowed', async () => {
    expect(await canAccessAttachment(ctx('user'), 'att_x', { ...meta, uploaderId: 'usr_me' })).toBe(
      true,
    )
  })

  it('member of the referencing run’s agent allowed', async () => {
    state.ref = { runId: 'run_1' }
    state.run = { agentId: 'agt_1' }
    state.perm = { agent: {}, permission: 'viewer' }
    expect(await canAccessAttachment(ctx('user'), 'att_x', meta)).toBe(true)
  })

  it('non-uploader, no referencing run → denied', async () => {
    state.ref = undefined
    expect(await canAccessAttachment(ctx('user'), 'att_x', meta)).toBe(false)
  })

  it('non-member of the referencing agent → denied', async () => {
    state.ref = { runId: 'run_1' }
    state.run = { agentId: 'agt_1' }
    state.perm = null // no permission
    expect(await canAccessAttachment(ctx('user'), 'att_x', meta)).toBe(false)
  })
})

describe('recordAttachmentRefs', () => {
  it('inserts one row per token, deduped', async () => {
    await recordAttachmentRefs('run_1', ['att_a', 'att_b', 'att_a'])
    expect(insertValues).toHaveBeenCalledWith([
      { token: 'att_a', runId: 'run_1' },
      { token: 'att_b', runId: 'run_1' },
    ])
    expect(onConflictRun).toHaveBeenCalledOnce()
  })

  it('no-op for empty/undefined or all-empty tokens', async () => {
    await recordAttachmentRefs('run_1', undefined)
    await recordAttachmentRefs('run_1', [])
    await recordAttachmentRefs('run_1', [''])
    expect(insertValues).not.toHaveBeenCalled()
  })
})
