import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentConfig } from '../agent-helpers.js'
import {
  cleanupLegacyRuntimeGroupConfig,
  cleanupLegacyRuntimeGroupConfigs,
  cleanupRuntimeGroupConfigs,
  materializeRuntimeGroupConfigs,
} from '../runtime-group-config.js'

const leases: Array<ReturnType<typeof materializeRuntimeGroupConfigs>> = []
const legacyTestPaths = new Set<string>()

function groupConfig(name: string, backend: object): AgentConfig {
  return {
    resolvedMcpServers: [
      {
        name,
        type: 'stdio',
        command: 'node',
        args: ['proxy.js'],
        env: { A2WAVE_GROUP_NAME: name },
        publicEnvKeys: ['A2WAVE_GROUP_NAME'],
        runtimeGroupConfig: {
          legacyMcpServerId: `mcp_${name}`,
          config: { backends: { default: [backend] } },
        },
      },
    ],
  }
}

function requireConfigPath(path: string | undefined): string {
  expect(path).toBeTypeOf('string')
  if (!path) throw new Error('Expected a materialized runtime group config path')
  return path
}

afterEach(() => {
  for (const lease of leases.splice(0)) cleanupRuntimeGroupConfigs(lease)
  for (const path of legacyTestPaths) {
    try {
      unlinkSync(path)
    } catch {
      // The cleanup under test may already have removed it.
    }
  }
  legacyTestPaths.clear()
})

function createLegacyConfig(id: string, content = 'legacy'): string {
  const path = join(tmpdir(), `a2wave-group-${id}.json`)
  writeFileSync(path, content, { mode: 0o600 })
  legacyTestPaths.add(path)
  return path
}

describe('legacy runtime group config migration cleanup', () => {
  it('removes a deterministic carrier for a database-known Group id', async () => {
    const id = `mcp_legacy_${process.pid}_${Date.now()}`
    const path = createLegacyConfig(id)

    cleanupLegacyRuntimeGroupConfigs([id])

    expect(existsSync(path)).toBe(false)
  })

  it('treats an already-missing legacy carrier as a successful no-op', async () => {
    const id = `mcp_missing_${process.pid}_${Date.now()}`
    expect(() => cleanupLegacyRuntimeGroupConfig(id)).not.toThrow()
  })

  it('rejects an abnormal database id without touching temp files', async () => {
    const unrelated = createLegacyConfig(`unrelated_${process.pid}_${Date.now()}`)

    cleanupLegacyRuntimeGroupConfig('../unrelated')

    expect(readFileSync(unrelated, 'utf-8')).toBe('legacy')
  })

  it('does not remove a valid legacy-looking file whose id was not supplied', async () => {
    const selectedId = `selected_${process.pid}_${Date.now()}`
    const selected = createLegacyConfig(selectedId)
    const unrelated = createLegacyConfig(`other_${process.pid}_${Date.now()}`)

    cleanupLegacyRuntimeGroupConfigs([selectedId])

    expect(existsSync(selected)).toBe(false)
    expect(readFileSync(unrelated, 'utf-8')).toBe('legacy')
  })
})

describe('runtime group config materialization', () => {
  it('creates independent private files for concurrent privileged and unprivileged runs', async () => {
    const admin = materializeRuntimeGroupConfigs(
      groupConfig('admin', {
        mode: 'inline',
        name: 'admin-backend',
        type: 'stdio',
        command: 'admin-cli',
        env: { ADMIN_SECRET: 'secret' },
      }),
    )
    const user = materializeRuntimeGroupConfigs(
      groupConfig('user', {
        mode: 'inline',
        name: 'safe-backend',
        type: 'http',
        url: 'https://mcp.example.com',
      }),
    )
    leases.push(admin, user)

    const adminPath = requireConfigPath(
      admin.agentConfig.resolvedMcpServers?.[0].env?.A2WAVE_GROUP_CONFIG_PATH,
    )
    const userPath = requireConfigPath(
      user.agentConfig.resolvedMcpServers?.[0].env?.A2WAVE_GROUP_CONFIG_PATH,
    )
    expect(adminPath).not.toBe(userPath)
    expect(statSync(adminPath).mode & 0o777).toBe(0o600)
    expect(statSync(userPath).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(adminPath)).mode & 0o777).toBe(0o700)

    const adminContent = readFileSync(adminPath, 'utf-8')
    const userContent = readFileSync(userPath, 'utf-8')
    expect(adminContent).toContain('ADMIN_SECRET')
    expect(userContent).not.toContain('ADMIN_SECRET')
    expect(userContent).toContain('safe-backend')
  })

  it('uses a distinct file for every group in the same run', async () => {
    const config: AgentConfig = {
      resolvedMcpServers: [
        ...(groupConfig('one', { mode: 'inline', name: 'one', type: 'http' }).resolvedMcpServers ??
          []),
        ...(groupConfig('two', { mode: 'inline', name: 'two', type: 'http' }).resolvedMcpServers ??
          []),
      ],
    }
    const lease = materializeRuntimeGroupConfigs(config)
    leases.push(lease)
    const paths = lease.agentConfig.resolvedMcpServers?.map(
      (server) => server.env?.A2WAVE_GROUP_CONFIG_PATH,
    )
    expect(new Set(paths).size).toBe(2)
  })

  it('removes every materialized file and directory idempotently', async () => {
    const lease = materializeRuntimeGroupConfigs(
      groupConfig('cleanup', { mode: 'inline', name: 'safe', type: 'http' }),
    )
    const path = requireConfigPath(
      lease.agentConfig.resolvedMcpServers?.[0].env?.A2WAVE_GROUP_CONFIG_PATH,
    )
    expect(existsSync(path)).toBe(true)

    cleanupRuntimeGroupConfigs(lease)
    cleanupRuntimeGroupConfigs(lease)

    expect(existsSync(path)).toBe(false)
    expect(existsSync(dirname(path))).toBe(false)
  })
})
