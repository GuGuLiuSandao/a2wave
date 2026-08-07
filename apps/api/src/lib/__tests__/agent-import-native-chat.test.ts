import AdmZip from 'adm-zip'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const insertValues = vi.fn((_values: unknown) => asyncQuery({ run: vi.fn() }))
const txStub = {
  insert: vi.fn(() => ({ values: insertValues })),
  select: vi.fn(() => ({
    from: vi.fn(() => ({ where: vi.fn(() => asyncQuery({ get: () => undefined })) })),
  })),
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
vi.mock('../id.js', () => ({ createId: (prefix?: string) => `${prefix}_test` }))
vi.mock('../url-safety.js', () => ({ isBlockedHost: () => false }))

import { importAgentFromZip } from '../agent-import.js'

import { asyncQuery } from '../../test/async-query.js'

function buildNativeChatExportZip(
  a2aRouteTargets: unknown = null,
  extraAgentFields: Record<string, unknown> = {},
): Buffer {
  const zip = new AdmZip()
  zip.addFile(
    'manifest.json',
    Buffer.from(JSON.stringify({ version: '1.0', exportedAt: '2026-01-01' })),
  )
  zip.addFile(
    'agent.json',
    Buffer.from(
      JSON.stringify({
        name: 'Imported native chat Agent',
        description: null,
        type: 'cursor',
        icon: 'bot',
        systemPrompt: null,
        config: {},
        workspaceType: 'temp',
        maxConcurrency: 1,
        env: null,
        feishuConfig: null,
        slackConfig: {
          appId: 'A123',
          appToken: '********',
          botToken: '********',
        },
        discordConfig: {
          applicationId: 'D123',
          botToken: '********',
        },
        scheduleConfig: null,
        publishChannels: ['api', 'slack', 'discord'],
        oauthAccessMode: 'all_idaas_users',
        a2aSkills: null,
        a2aRouteTargets,
        showLocalChildOutput: null,
        showRemoteChildOutput: null,
        mcpServerRefs: [],
        skillRefs: [],
        kbDocumentRefs: [],
        providerRef: null,
        scmSourceRef: null,
        ...extraAgentFields,
      }),
    ),
  )
  return zip.toBuffer()
}

beforeEach(() => {
  insertValues.mockClear()
})

describe('agent import native chat credentials', () => {
  it('disables Slack and Discord until credentials are reconfigured', async () => {
    const result = await importAgentFromZip(buildNativeChatExportZip(), 'usr_test')
    const insertedAgent = insertValues.mock.calls[0]?.[0] as {
      publishChannels: string[]
      slackConfig: unknown
      discordConfig: unknown
    }

    expect(insertedAgent.publishChannels).toEqual(['api'])
    expect(insertedAgent.slackConfig).toBeNull()
    expect(insertedAgent.discordConfig).toBeNull()
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Slack.*credentials/i),
        expect.stringMatching(/Discord.*credentials/i),
      ]),
    )
  })

  it('drops masked remote A2A credentials instead of importing the placeholder', async () => {
    const result = await importAgentFromZip(
      buildNativeChatExportZip([
        {
          type: 'remote',
          name: 'Protected standard Agent',
          url: 'https://agent.example.com/.well-known/agent-card.json',
          connectionMode: 'agent_card',
          apiKey: '********',
        },
      ]),
      'usr_test',
    )
    const insertedAgent = insertValues.mock.calls[0]?.[0] as {
      a2aRouteTargets: Array<Record<string, unknown>>
    }

    expect(insertedAgent.a2aRouteTargets).toEqual([
      {
        type: 'remote',
        name: 'Protected standard Agent',
        url: 'https://agent.example.com/.well-known/agent-card.json',
        connectionMode: 'agent_card',
      },
    ])
    expect(result.warnings).toContain(
      'Remote A2A route credentials are not imported; reconfigure protected routes before use',
    )
  })

  it('preserves a valid git trigger while dropping a masked A2A route credential', async () => {
    await importAgentFromZip(
      buildNativeChatExportZip(
        [
          {
            type: 'remote',
            name: 'Protected Agent',
            url: 'https://agent.example.com/a2a',
            connectionMode: 'direct',
            protocolVersion: '1.0',
            apiKey: '********',
          },
        ],
        {
          publishChannels: ['a2a', 'glab'],
          glabConfig: {
            provider: 'glab',
            repos: [{ project: 'group/repo' }],
            events: ['opened'],
            intent: 'Review {{url}}',
          },
        },
      ),
      'usr_test',
    )
    const insertedAgent = insertValues.mock.calls[0]?.[0] as {
      publishChannels: string[]
      glabConfig: Record<string, unknown>
      a2aRouteTargets: Array<Record<string, unknown>>
    }

    expect(insertedAgent.publishChannels).toEqual(['a2a', 'glab'])
    expect(insertedAgent.glabConfig).toMatchObject({
      provider: 'glab',
      repos: [{ project: 'group/repo' }],
      events: ['opened'],
      intent: 'Review {{url}}',
    })
    expect(insertedAgent.a2aRouteTargets[0]).not.toHaveProperty('apiKey')
  })
})
