import { chmodSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { AgentConfig } from './agent-helpers.js'
import { logger } from './logger.js'

const RUNTIME_GROUP_DIRECTORY_PREFIX = 'a2wave-group-'

export interface RuntimeGroupConfigLease {
  agentConfig: AgentConfig
  directories: string[]
}

function cleanupDirectory(directory: string): void {
  const resolvedTemp = resolve(tmpdir())
  const resolvedDirectory = resolve(directory)
  if (
    dirname(resolvedDirectory) !== resolvedTemp ||
    !resolvedDirectory.slice(resolvedTemp.length + 1).startsWith(RUNTIME_GROUP_DIRECTORY_PREFIX)
  ) {
    return
  }
  try {
    unlinkSync(join(resolvedDirectory, 'config.json'))
  } catch {
    // The proxy removes the file immediately after reading it.
  }
  try {
    rmdirSync(resolvedDirectory)
  } catch {
    // Best effort: never recurse through a runtime path.
  }
}

const LEGACY_MCP_SERVER_ID_PATTERN = /^[A-Za-z0-9_-]+$/

/**
 * Remove one legacy deterministic carrier without allowing a database value to
 * influence the directory being unlinked. Invalid ids are skipped and failures
 * are logged without exposing the attempted path or OS error details.
 */
export function cleanupLegacyRuntimeGroupConfig(mcpServerId: string): void {
  if (!LEGACY_MCP_SERVER_ID_PATTERN.test(mcpServerId)) {
    logger.warn(
      { mcpServerId: '[invalid]' },
      'Skipped cleanup of a legacy MCP Group config with an invalid server id',
    )
    return
  }
  try {
    unlinkSync(join(tmpdir(), `a2wave-group-${mcpServerId}.json`))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    logger.warn(
      { mcpServerId },
      'Failed to remove a legacy MCP Group config; startup will continue',
    )
  }
}

/** Remove legacy carriers only for Group ids read from the current database. */
export function cleanupLegacyRuntimeGroupConfigs(mcpServerIds: readonly string[]): void {
  for (const mcpServerId of mcpServerIds) cleanupLegacyRuntimeGroupConfig(mcpServerId)
}

/**
 * Materialize filtered group credentials only when a real execution starts.
 * Each group receives an unpredictable, exclusive carrier; diagnostic and
 * snapshot builds therefore create no credential-bearing temporary files.
 */
export function materializeRuntimeGroupConfigs(agentConfig: AgentConfig): RuntimeGroupConfigLease {
  const directories: string[] = []
  try {
    const resolvedMcpServers = agentConfig.resolvedMcpServers?.map((server) => {
      const runtime = server.runtimeGroupConfig
      if (!runtime) return server

      cleanupLegacyRuntimeGroupConfig(runtime.legacyMcpServerId)
      const directory = mkdtempSync(join(tmpdir(), RUNTIME_GROUP_DIRECTORY_PREFIX))
      directories.push(directory)
      chmodSync(directory, 0o700)
      const configPath = join(directory, 'config.json')
      writeFileSync(configPath, JSON.stringify(runtime.config), {
        encoding: 'utf-8',
        flag: 'wx',
        mode: 0o600,
      })
      chmodSync(configPath, 0o600)

      const { runtimeGroupConfig: _runtimeGroupConfig, ...materialized } = server
      return {
        ...materialized,
        env: { ...server.env, A2WAVE_GROUP_CONFIG_PATH: configPath },
        publicEnvKeys: [...new Set([...(server.publicEnvKeys ?? []), 'A2WAVE_GROUP_CONFIG_PATH'])],
      }
    })
    return {
      agentConfig:
        resolvedMcpServers === undefined ? agentConfig : { ...agentConfig, resolvedMcpServers },
      directories,
    }
  } catch (error) {
    for (const directory of directories) cleanupDirectory(directory)
    throw error
  }
}

/** Idempotent lifecycle cleanup for every runtime group credential carrier. */
export function cleanupRuntimeGroupConfigs(lease: RuntimeGroupConfigLease): void {
  for (const directory of lease.directories) cleanupDirectory(directory)
}
