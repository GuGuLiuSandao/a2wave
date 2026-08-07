import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dbSelect = vi.fn()
vi.mock('../../db/client.js', () => ({
  db: {
    select: (...args: unknown[]) => dbSelect(...args),
  },
}))

vi.mock('../../db/schema.js', () => ({
  agents: { id: 'agents.id' },
  kbDocuments: { id: 'kb.id' },
  mcpServers: { id: 'mcp.id' },
  providers: { id: 'prv.id' },
  scmSources: { id: 'scm.id' },
  skills: { id: 'skl.id', groupId: 'skl.groupId' },
}))

const getSkillStoragePathMock = vi.fn()
vi.mock('../skill-storage.js', () => ({
  getSkillStoragePath: (...args: unknown[]) => getSkillStoragePathMock(...args),
}))

vi.mock('../slug.js', () => ({
  slugify: (s: string) => s.toLowerCase().replace(/\s+/g, '-'),
}))

import { asyncQuery } from '../../test/async-query.js'
import {
  buildExportZip,
  computeExportedSkillPackageDigest,
  deduplicateSlug,
  sanitizeAgent,
} from '../agent-export.js'

describe('deduplicateSlug', () => {
  it('returns the base when unused, and registers it', async () => {
    const used = new Set<string>()
    expect(deduplicateSlug('foo', used)).toBe('foo')
    expect(used.has('foo')).toBe(true)
  })

  it('appends -2 on the first collision', async () => {
    const used = new Set(['foo'])
    expect(deduplicateSlug('foo', used)).toBe('foo-2')
    expect(used.has('foo-2')).toBe(true)
  })

  it('keeps incrementing past taken suffixes', async () => {
    const used = new Set(['foo', 'foo-2', 'foo-3'])
    expect(deduplicateSlug('foo', used)).toBe('foo-4')
  })
})

describe('sanitizeAgent.providerChain', () => {
  it('masks providerApiKey / providerBaseUrl / providerOauthToken inside config.providerChain', async () => {
    const out = sanitizeAgent({
      name: 'A',
      description: null,
      type: 'llm',
      icon: 'i',
      systemPrompt: null,
      config: {
        providerChain: [
          { providerId: 'p1', providerApiKey: 'k', providerOauthToken: 't' },
          { providerId: 'p2', providerBaseUrl: 'b' },
          { providerId: 'p3' },
        ],
      },
      workspaceType: 'temp',
      maxConcurrency: 1,
      env: null,
      feishuConfig: null,
      scheduleConfig: null,
      publishChannels: null,
      a2aSkills: null,
      a2aRouteTargets: null,
      showLocalChildOutput: null,
      showRemoteChildOutput: null,
    } as never)
    expect(out.config).toEqual({
      providerChain: [
        { providerId: 'p1', providerApiKey: '********', providerOauthToken: '********' },
        { providerId: 'p2', providerBaseUrl: '********' },
        { providerId: 'p3' },
      ],
    })
  })

  it('keeps config untouched when providerChain is missing', async () => {
    const out = sanitizeAgent({
      name: 'A',
      description: null,
      type: 'llm',
      icon: 'i',
      systemPrompt: null,
      config: { other: true },
      workspaceType: 'temp',
      maxConcurrency: 1,
      env: null,
      feishuConfig: null,
      scheduleConfig: null,
      publishChannels: null,
      a2aSkills: null,
      a2aRouteTargets: null,
      showLocalChildOutput: null,
      showRemoteChildOutput: null,
    } as never)
    expect(out.config).toEqual({ other: true })
  })
})

describe('buildExportZip', () => {
  let storageTmp: string
  const ownerAudience = {
    kind: 'authenticated' as const,
    requesterUserId: 'usr_owner',
    requesterIsAdmin: false,
  }

  function chain(returns: Array<unknown>) {
    let i = 0
    dbSelect.mockImplementation(() => {
      const ret = returns[i++]
      // An array entry stands for a multi-row result, so it must surface via
      // `all`; exposing it through `get` too would make the adapter wrap the
      // whole array as a single row.
      const terminator = Array.isArray(ret) ? { all: () => ret } : { get: () => ret, all: () => [] }
      return asyncQuery({
        from: () => asyncQuery({ where: () => asyncQuery(terminator) }),
      })
    })
  }

  beforeEach(() => {
    dbSelect.mockReset()
    getSkillStoragePathMock.mockReset()
    storageTmp = mkdtempSync(path.join(os.tmpdir(), 'agent-export-skill-'))
  })

  afterEach(() => {
    rmSync(storageTmp, { recursive: true, force: true })
  })

  function fullAgent(overrides: Record<string, unknown> = {}) {
    return {
      id: 'agt_1',
      name: 'A',
      description: null,
      type: 'llm',
      icon: 'i',
      systemPrompt: null,
      config: null,
      workspaceType: 'temp',
      maxConcurrency: 1,
      env: null,
      feishuConfig: null,
      scheduleConfig: null,
      publishChannels: null,
      a2aSkills: null,
      a2aRouteTargets: null,
      showLocalChildOutput: null,
      showRemoteChildOutput: null,
      providerId: null,
      scmSourceId: null,
      kbDocumentIds: null,
      mcpServerIds: null,
      skills: null,
      skillGroupIds: null,
      userId: 'usr_owner',
      ...overrides,
    }
  }

  function fullMcp(overrides: Record<string, unknown> = {}) {
    return {
      id: 'mcp_1',
      name: 'My MCP',
      description: null,
      type: 'stdio',
      command: null,
      args: [],
      cwd: null,
      url: null,
      headers: null,
      env: null,
      isEnabled: true,
      groupConfig: null,
      ...overrides,
    }
  }

  it('throws when the agent is not found', async () => {
    chain([undefined])
    await expect(buildExportZip('agt_404', ownerAudience)).rejects.toThrow(/Agent not found/)
  })

  it('writes manifest + agent.json with provider/scm/kb refs resolved by name', async () => {
    chain([
      fullAgent({
        providerId: 'prv_1',
        scmSourceId: 'scm_1',
        kbDocumentIds: ['kb_1', 'kb_2'],
      }),
      { id: 'prv_1', name: 'OpenAI' },
      { id: 'scm_1', name: 'main-repo' },
      [{ name: 'doc-a' }, { name: 'doc-b' }],
    ])

    const buf = await buildExportZip('agt_1', ownerAudience)
    const zip = new AdmZip(buf)
    const exported = JSON.parse(zip.getEntry('agent.json')!.getData().toString('utf-8'))
    expect(exported.providerRef).toBe('OpenAI')
    expect(exported.scmSourceRef).toBe('main-repo')
    expect(exported.kbDocumentRefs).toEqual(['doc-a', 'doc-b'])
    const manifest = JSON.parse(zip.getEntry('manifest.json')!.getData().toString('utf-8'))
    expect(manifest.version).toBe('1.0')
    expect(manifest.agentName).toBe('A')
  })

  it('leaves refs null when the linked entity is no longer present', async () => {
    chain([fullAgent({ providerId: 'prv_x', scmSourceId: 'scm_x' }), undefined, undefined])
    const zip = new AdmZip(await buildExportZip('agt_1', ownerAudience))
    const exported = JSON.parse(zip.getEntry('agent.json')!.getData().toString('utf-8'))
    expect(exported.providerRef).toBeNull()
    expect(exported.scmSourceRef).toBeNull()
  })

  it('packs mcp-servers with deduplicated slugs', async () => {
    chain([
      fullAgent({ mcpServerIds: ['mcp_1', 'mcp_2'] }),
      [fullMcp({ name: 'Dup Name' }), fullMcp({ id: 'mcp_2', name: 'Dup Name' })],
    ])
    const zip = new AdmZip(await buildExportZip('agt_1', ownerAudience))
    const names = zip
      .getEntries()
      .map((e) => e.entryName)
      .sort()
    expect(names).toContain('mcp-servers/dup-name.json')
    expect(names).toContain('mcp-servers/dup-name-2.json')

    const exported = JSON.parse(zip.getEntry('agent.json')!.getData().toString('utf-8'))
    expect(exported.mcpServerRefs).toEqual(['dup-name.json', 'dup-name-2.json'])
  })

  it('never writes MCP URL, env, or header credentials into the export archive', async () => {
    chain([
      fullAgent({ mcpServerIds: ['mcp_secret'] }),
      [
        fullMcp({
          id: 'mcp_secret',
          type: 'http',
          url: 'https://user:pass@mcp.example.com/sse/private?token=query-secret',
          env: { CUSTOM_VALUE: 'hidden-env-secret' },
          headers: { 'X-Custom': 'hidden-header-secret' },
        }),
      ],
    ])

    const archive = await buildExportZip('agt_1', ownerAudience)
    const archiveText = new AdmZip(archive)
      .getEntry('mcp-servers/my-mcp.json')!
      .getData()
      .toString('utf-8')

    expect(archiveText).toContain('https://mcp.example.com/********')
    expect(archiveText).not.toContain('query-secret')
    expect(archiveText).not.toContain('hidden-env-secret')
    expect(archiveText).not.toContain('hidden-header-secret')
  })

  it('packs skill folders (skill.json + SKILL.md) and dedups dir names', async () => {
    chain([
      fullAgent({ skills: ['skl_1', 'skl_2'] }),
      // Note: order is byId first (skills only, since we have no groupIds)
      [
        {
          id: 'skl_1',
          name: 'Same',
          description: 'd1',
          content: 'md1',
          storagePath: null,
          userId: 'usr_owner',
          visibility: 'private',
        },
        {
          id: 'skl_2',
          name: 'Same',
          description: 'd2',
          content: null,
          storagePath: null,
          userId: 'usr_owner',
          visibility: 'private',
        },
      ],
    ])
    const zip = new AdmZip(await buildExportZip('agt_1', ownerAudience))
    const names = zip
      .getEntries()
      .map((e) => e.entryName)
      .sort()
    expect(names).toContain('skills/same/skill.json')
    expect(names).toContain('skills/same/SKILL.md')
    expect(names).toContain('skills/same-2/skill.json')
    // skl_2 has no content, no SKILL.md
    expect(names).not.toContain('skills/same-2/SKILL.md')
  })

  it('merges skills picked by groupId and dedups against direct skills', async () => {
    chain([
      fullAgent({ skills: ['skl_1'], skillGroupIds: ['skg_1'] }),
      // Direct
      [
        {
          id: 'skl_1',
          name: 'A',
          description: null,
          content: 'x',
          storagePath: null,
          userId: 'usr_owner',
          visibility: 'private',
        },
      ],
      // By group — overlap on skl_1 plus a new one
      [
        {
          id: 'skl_1',
          name: 'A',
          description: null,
          content: 'x',
          storagePath: null,
          userId: 'usr_owner',
          visibility: 'private',
        },
        {
          id: 'skl_2',
          name: 'B',
          description: null,
          content: 'y',
          storagePath: null,
          userId: 'usr_owner',
          visibility: 'private',
        },
      ],
    ])
    const zip = new AdmZip(await buildExportZip('agt_1', ownerAudience))
    const names = zip.getEntries().map((e) => e.entryName)
    expect(names).toContain('skills/a/skill.json')
    expect(names).toContain('skills/b/skill.json')
    // skl_1 must NOT appear twice
    expect(names.filter((n) => n === 'skills/a/skill.json')).toHaveLength(1)
  })

  it('copies extra files from skill storage when storagePath is set', async () => {
    const storageDir = path.join(storageTmp, 'skl_1')
    require('node:fs').mkdirSync(storageDir, { recursive: true })
    writeFileSync(path.join(storageDir, 'extra.md'), '## extra')
    writeFileSync(
      path.join(storageDir, 'SKILL.md'),
      'should be skipped (already added via content)',
    )
    writeFileSync(
      path.join(storageDir, 'skill.json'),
      JSON.stringify({ origin: { kind: 'system-builtin', name: 'a2wave-memory' } }),
    )

    chain([
      fullAgent({ skills: ['skl_1'] }),
      [
        {
          id: 'skl_1',
          name: 'WithFiles',
          description: null,
          content: 'main content',
          storagePath: 'skl_1',
          userId: 'usr_owner',
          visibility: 'private',
        },
      ],
    ])
    getSkillStoragePathMock.mockReturnValue(storageDir)

    const zip = new AdmZip(await buildExportZip('agt_1', ownerAudience))
    const names = zip.getEntries().map((e) => e.entryName)
    expect(names).toContain('skills/withfiles/extra.md')
    // Reserved files must come from trusted DB/export metadata, not Skill storage.
    expect(names.filter((n) => n === 'skills/withfiles/SKILL.md')).toHaveLength(1)
    expect(names.filter((n) => n === 'skills/withfiles/skill.json')).toHaveLength(1)
    const skillMd = zip.getEntry('skills/withfiles/SKILL.md')!.getData().toString('utf-8')
    expect(skillMd).toBe('main content')
    const metadata = JSON.parse(
      zip.getEntry('skills/withfiles/skill.json')?.getData().toString('utf-8') ?? '',
    )
    expect(metadata.origin).toEqual({ kind: 'user-owned' })
  })

  it("prevents a viewer from exporting another owner's private Skill", async () => {
    chain([
      fullAgent({ userId: 'usr_agent_owner', skills: ['skl_private', 'skl_shared', 'skl_own'] }),
      [
        {
          id: 'skl_private',
          name: 'Owner Private',
          description: null,
          content: 'owner-only',
          storagePath: null,
          userId: 'usr_agent_owner',
          visibility: 'private',
        },
        {
          id: 'skl_shared',
          name: 'Shared',
          description: null,
          content: 'shared',
          storagePath: null,
          userId: 'usr_admin',
          visibility: 'all-users',
        },
        {
          id: 'skl_own',
          name: 'Viewer Own',
          description: null,
          content: 'viewer-owned',
          storagePath: null,
          userId: 'usr_viewer',
          visibility: 'private',
        },
      ],
    ])

    const zip = new AdmZip(
      await buildExportZip('agt_1', {
        kind: 'authenticated',
        requesterUserId: 'usr_viewer',
        requesterIsAdmin: false,
      }),
    )
    const names = zip.getEntries().map((entry) => entry.entryName)
    expect(names).not.toContain('skills/owner-private/skill.json')
    expect(names).toContain('skills/shared/skill.json')
    expect(names).toContain('skills/viewer-own/skill.json')
  })

  it('exports a system-owned all-users built-in for an authenticated regular user', async () => {
    chain([
      fullAgent({ skills: ['skl_memory'] }),
      [
        {
          id: 'skl_memory',
          name: 'a2wave-memory',
          description: null,
          content: 'builtin-memory',
          storagePath: null,
          userId: null,
          visibility: 'all-users',
        },
      ],
    ])

    const zip = new AdmZip(await buildExportZip('agt_1', ownerAudience))
    expect(zip.getEntry('skills/a2wave-memory/SKILL.md')?.getData().toString('utf-8')).toBe(
      'builtin-memory',
    )
    const metadataEntry = zip.getEntry('skills/a2wave-memory/skill.json')
    expect(metadataEntry).not.toBeNull()
    expect(JSON.parse(metadataEntry?.getData().toString('utf-8') ?? '')).toMatchObject({
      origin: {
        kind: 'system-builtin',
        name: 'a2wave-memory',
        digest: computeExportedSkillPackageDigest({ name: 'a2wave-memory', description: null }, [
          { path: 'SKILL.md', data: Buffer.from('builtin-memory') },
        ]),
      },
    })
  })

  it('marks a user-owned same-name Skill distinctly from a system built-in', async () => {
    chain([
      fullAgent({ skills: ['skl_user_memory'] }),
      [
        {
          id: 'skl_user_memory',
          name: 'a2wave-memory',
          description: null,
          content: 'user-memory',
          storagePath: null,
          userId: 'usr_owner',
          visibility: 'private',
        },
      ],
    ])

    const zip = new AdmZip(await buildExportZip('agt_1', ownerAudience))
    const metadataEntry = zip.getEntry('skills/a2wave-memory/skill.json')
    expect(metadataEntry).not.toBeNull()
    const metadata = JSON.parse(metadataEntry?.getData().toString('utf-8') ?? '')
    expect(metadata.origin).toEqual({ kind: 'user-owned' })
  })

  it('does not package any Skill contents for an unauthenticated share', async () => {
    chain([
      fullAgent({ skills: ['skl_private', 'skl_shared'] }),
      [
        {
          id: 'skl_private',
          name: 'Owner Private',
          description: null,
          content: 'owner-only',
          storagePath: null,
          userId: 'usr_owner',
          visibility: 'private',
        },
        {
          id: 'skl_shared',
          name: 'Shared',
          description: null,
          content: 'signed-in-only',
          storagePath: null,
          userId: 'usr_admin',
          visibility: 'all-users',
        },
      ],
    ])

    const zip = new AdmZip(await buildExportZip('agt_1', { kind: 'public' }))
    expect(zip.getEntries().some((entry) => entry.entryName.startsWith('skills/'))).toBe(false)
    const exported = JSON.parse(zip.getEntry('agent.json')!.getData().toString('utf-8'))
    expect(exported.skillRefs).toEqual([])
  })

  it("preserves an administrator's ability to export foreign private Skills", async () => {
    chain([
      fullAgent({ skills: ['skl_private'] }),
      [
        {
          id: 'skl_private',
          name: 'Foreign Private',
          description: null,
          content: 'admin-visible',
          storagePath: null,
          userId: 'usr_other',
          visibility: 'private',
        },
      ],
    ])

    const zip = new AdmZip(
      await buildExportZip('agt_1', {
        kind: 'authenticated',
        requesterUserId: 'usr_admin',
        requesterIsAdmin: true,
      }),
    )
    expect(zip.getEntry('skills/foreign-private/SKILL.md')?.getData().toString('utf-8')).toBe(
      'admin-visible',
    )
  })
})
