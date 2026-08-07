import AdmZip from 'adm-zip'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Run the transaction callback with a tx whose insert/select are no-ops, so we
// reach the per-MCP stdio check inside the loop.
const insertRun = vi.fn()
const txStub = {
  insert: vi.fn(() => asyncQuery({ values: vi.fn(() => asyncQuery({ run: insertRun })) })),
  select: vi.fn(() =>
    asyncQuery({
      from: vi.fn(() => asyncQuery({ where: vi.fn(() => asyncQuery({ get: () => undefined })) })),
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

function buildZip(mcp: Record<string, unknown>): Buffer {
  const zip = new AdmZip()
  zip.addFile(
    'manifest.json',
    Buffer.from(JSON.stringify({ version: '1.0', exportedAt: '2026-01-01' })),
  )
  zip.addFile(
    'agent.json',
    Buffer.from(
      JSON.stringify({
        agent: { name: 'Imported', type: 'cursor', config: {} },
        mcpServerRefs: ['m1.json'],
        skillRefs: [],
        kbDocumentRefs: [],
        providerRef: null,
        scmSourceRef: null,
      }),
    ),
  )
  zip.addFile('mcp-servers/m1.json', Buffer.from(JSON.stringify(mcp)))
  return zip.toBuffer()
}

beforeEach(() => {
  insertRun.mockReset()
})

describe('agent import stdio gate (P0-1 escape path)', () => {
  it('rejects a non-admin import containing a top-level stdio MCP server', async () => {
    const zip = buildZip({ name: 'evil', type: 'stdio', command: '/bin/sh', args: ['-c', 'id'] })
    await expect(importAgentFromZip(zip, 'usr_alice', false)).rejects.toThrow(/admin.*stdio/i)
    expect(insertRun).not.toHaveBeenCalled()
  })

  it('rejects a non-admin import with an inline stdio backend inside a group MCP', async () => {
    const zip = buildZip({
      name: 'grp',
      type: 'group',
      groupConfig: { backends: { main: [{ mode: 'inline', type: 'stdio', command: '/bin/sh' }] } },
    })
    await expect(importAgentFromZip(zip, 'usr_alice', false)).rejects.toThrow(/admin.*stdio/i)
    expect(insertRun).not.toHaveBeenCalled()
  })

  it('allows a non-admin import of an sse MCP server (URL-only, no RCE)', async () => {
    const zip = buildZip({ name: 'remote', type: 'sse', url: 'https://example.com/mcp' })
    // Passes the stdio gate; the insert stub runs, no throw from the gate.
    await expect(importAgentFromZip(zip, 'usr_alice', false)).resolves.not.toThrow()
  })

  it('allows an admin (allowStdio=true) to import a stdio MCP server', async () => {
    const zip = buildZip({ name: 'ok', type: 'stdio', command: 'npx' })
    await expect(importAgentFromZip(zip, 'usr_admin', true)).resolves.not.toThrow()
  })
})

describe('agent import MCP URL safety gate', () => {
  it('rejects a top-level MCP URL targeting a private address', async () => {
    const zip = buildZip({ name: 'private', type: 'http', url: 'http://127.0.0.1/mcp' })

    await expect(importAgentFromZip(zip, 'usr_alice', false)).rejects.toThrow(
      /public HTTP\(S\) address/,
    )
    expect(insertRun).not.toHaveBeenCalled()
  })

  it('rejects a private inline backend URL inside a group MCP', async () => {
    const zip = buildZip({
      name: 'private-group',
      type: 'group',
      groupConfig: {
        backends: {
          main: [
            {
              mode: 'inline',
              type: 'sse',
              name: 'metadata',
              url: 'http://169.254.169.254/latest/meta-data',
            },
          ],
        },
      },
    })

    await expect(importAgentFromZip(zip, 'usr_alice', false)).rejects.toThrow(/main\/metadata/)
    expect(insertRun).not.toHaveBeenCalled()
  })

  it('applies the URL safety gate to admin imports too', async () => {
    const zip = buildZip({ name: 'private', type: 'sse', url: 'http://[::1]/mcp' })

    await expect(importAgentFromZip(zip, 'usr_admin', true)).rejects.toThrow(
      /public HTTP\(S\) address/,
    )
    expect(insertRun).not.toHaveBeenCalled()
  })

  it('allows public top-level and inline MCP URLs', async () => {
    const topLevel = buildZip({ name: 'public', type: 'http', url: 'https://example.com/mcp' })
    const group = buildZip({
      name: 'public-group',
      type: 'group',
      groupConfig: {
        backends: {
          main: [
            {
              mode: 'inline',
              type: 'sse',
              name: 'public',
              url: 'https://example.com/events',
            },
          ],
        },
      },
    })

    await expect(importAgentFromZip(topLevel, 'usr_alice', false)).resolves.not.toThrow()
    await expect(importAgentFromZip(group, 'usr_alice', false)).resolves.not.toThrow()
  })
})
