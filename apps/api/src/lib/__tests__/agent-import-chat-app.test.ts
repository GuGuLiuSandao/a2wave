import AdmZip from 'adm-zip'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Same tx stub shape as agent-import-provider-chain.test.ts: insert/select are
// no-ops so the import runs far enough to reach the config validation, and the
// captured insert values let us assert what would land in the DB.
type InsertedAgent = { chatAppConfig?: Record<string, unknown> | null }

const insertRun = vi.fn()
const insertValues = vi.fn((_values: InsertedAgent) => asyncQuery({ run: insertRun }))
const txStub = {
  insert: vi.fn(() => asyncQuery({ values: insertValues })),
  select: vi.fn(() =>
    asyncQuery({
      from: vi.fn(() => ({ where: vi.fn(() => asyncQuery({ get: () => undefined })) })),
    }),
  ),
}
// `isPostgres: true` keeps `withTransaction` on the branch that calls
// `db.transaction`, so the callback still receives `txStub`. The SQLite branch
// would hand it the shared `db`, which here only carries `transaction`.
vi.mock('../../db/client.js', () => ({
  db: { transaction: (fn: (tx: unknown) => unknown) => fn(txStub) },
  isPostgres: true,
}))
vi.mock('../../db/schema.js', () => ({
  agents: {},
  kbDocuments: {},
  mcpServers: {},
  providers: {},
  scmSources: {},
  skills: {},
}))
vi.mock('../skill-storage.js', () => ({
  ensureDir: vi.fn(),
  getSkillStoragePath: (id: string) => `/tmp/skills/${id}`,
}))
vi.mock('../id.js', () => ({ createId: (p?: string) => `${p}_test` }))
vi.mock('../url-safety.js', () => ({ isBlockedHost: () => false }))

import { importAgentFromZip } from '../agent-import.js'

import { asyncQuery } from '../../test/async-query.js'

function buildZip(agentOverrides: Record<string, unknown>): Buffer {
  const zip = new AdmZip()
  zip.addFile(
    'manifest.json',
    Buffer.from(JSON.stringify({ version: '1.0', exportedAt: '2026-01-01' })),
  )
  zip.addFile(
    'agent.json',
    Buffer.from(
      JSON.stringify({
        name: 'Imported',
        type: 'cursor',
        config: {},
        mcpServerRefs: [],
        skillRefs: [],
        kbDocumentRefs: [],
        providerRef: null,
        scmSourceRef: null,
        ...agentOverrides,
      }),
    ),
  )
  return zip.toBuffer()
}

/** The chatAppConfig actually handed to the insert, or undefined if none ran. */
function insertedChatAppConfig(): Record<string, unknown> | null | undefined {
  return insertValues.mock.calls[0]?.[0]?.chatAppConfig
}

beforeEach(() => {
  insertRun.mockReset()
  insertValues.mockClear()
})

/**
 * The chat page config is rendered straight into a user-facing page, so a
 * malformed import (hand-edited ZIP, an export from a different schema version)
 * must be rejected at the boundary rather than surfacing as a crashed page.
 * Mirrors the provider-chain validation in the same file.
 */
describe('agent import — chatAppConfig validation', () => {
  it('rejects a config whose suggestedQuestions is not an array', async () => {
    const zip = buildZip({ chatAppConfig: { suggestedQuestions: 'not-an-array' } })
    await expect(importAgentFromZip(zip, 'usr_alice', false)).rejects.toThrow(/chat page config/i)
    expect(insertRun).not.toHaveBeenCalled()
  })

  it('rejects more suggested questions than the cap', async () => {
    const zip = buildZip({
      chatAppConfig: { suggestedQuestions: Array.from({ length: 7 }, (_, i) => `q${i}`) },
    })
    await expect(importAgentFromZip(zip, 'usr_alice', false)).rejects.toThrow(/chat page config/i)
  })

  it('rejects a whitespace-only suggested question', async () => {
    const zip = buildZip({ chatAppConfig: { suggestedQuestions: ['   '] } })
    await expect(importAgentFromZip(zip, 'usr_alice', false)).rejects.toThrow(/chat page config/i)
  })

  it('accepts an Agent with no chatAppConfig at all', async () => {
    const zip = buildZip({})
    await expect(importAgentFromZip(zip, 'usr_alice', false)).resolves.not.toThrow()
    expect(insertedChatAppConfig()).toBeNull()
  })
})

/**
 * Round-trip: the export side masks credentials on every other channel, but the
 * chat page config is presentation copy only — it must survive export → import
 * unchanged, or a re-imported Agent silently loses its welcome copy.
 */
describe('agent import — chatAppConfig round-trip', () => {
  it('preserves the presentation config verbatim', async () => {
    const exported = {
      displayName: 'Helpdesk',
      welcomeMessage: 'Ask me anything',
      suggestedQuestions: ['How do I reset my password?', 'Where are the docs?'],
      showCreator: false,
      allowAttachments: false,
      showThinking: false,
    }
    const zip = buildZip({ chatAppConfig: exported })
    await expect(importAgentFromZip(zip, 'usr_alice', false)).resolves.not.toThrow()
    expect(insertedChatAppConfig()).toMatchObject(exported)
  })

  it('fills in schema defaults for a partial config', async () => {
    const zip = buildZip({ chatAppConfig: { welcomeMessage: 'hi' } })
    await importAgentFromZip(zip, 'usr_alice', false)
    // Normalising through the schema (rather than casting) is what supplies these.
    expect(insertedChatAppConfig()).toMatchObject({
      welcomeMessage: 'hi',
      suggestedQuestions: [],
      showCreator: true,
      allowAttachments: true,
      showThinking: true,
    })
  })

  it('trims a suggested question, matching the publish form', async () => {
    const zip = buildZip({ chatAppConfig: { suggestedQuestions: ['  padded  '] } })
    await importAgentFromZip(zip, 'usr_alice', false)
    expect(insertedChatAppConfig()).toMatchObject({ suggestedQuestions: ['padded'] })
  })
})
