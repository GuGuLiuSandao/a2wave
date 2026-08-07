import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CliError } from './errors.js'

const CONFIG_DIR = join(homedir(), '.a2wave')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const URL_ENV_VAR = 'A2WAVE_URL'

export interface Config {
  /** a2wave instance URL; may be unset in OAuth-only scenarios (user provides via --url / env / config set-url) */
  url?: string
  token: string
}

export function loadConfig(): Config | null {
  if (!existsSync(CONFIG_FILE)) return null
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Config
  } catch {
    return null
  }
}

export function saveConfig(config: Config): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  writePrivateConfig(JSON.stringify(config, null, 2))
}

export function clearConfig(): void {
  if (existsSync(CONFIG_FILE)) writePrivateConfig('{}')
}

function writePrivateConfig(content: string): void {
  writeFileSync(CONFIG_FILE, content, { encoding: 'utf-8', mode: 0o600 })
  chmodSync(CONFIG_FILE, 0o600)
}

/** Get the token; if missing, the user has never logged in. */
export function requireToken(): string {
  const config = loadConfig()
  if (!config?.token) {
    throw new CliError('Not logged in. Run: a2wave login')
  }
  return config.token
}

/**
 * URL resolution: override (--url flag) > $A2WAVE_URL > config.url > throw a friendly error.
 * Returns the first non-empty match; if none, errors and shows the three ways to set it.
 */
export function resolveUrl(override?: string): string {
  const fromFlag = override?.trim()
  if (fromFlag) return fromFlag.replace(/\/+$/, '')

  const fromEnv = process.env[URL_ENV_VAR]?.trim()
  if (fromEnv) return fromEnv.replace(/\/+$/, '')

  const fromConfig = loadConfig()?.url?.trim()
  if (fromConfig) return fromConfig.replace(/\/+$/, '')

  throw new CliError(
    [
      'No a2wave instance URL specified. Provide one of the following:',
      '  1. One-off: <command> --url http://localhost:3502',
      `  2. Shell-persistent: export ${URL_ENV_VAR}=http://localhost:3502`,
      '  3. Globally persistent: a2wave config set-url http://localhost:3502',
    ].join('\n'),
  )
}
