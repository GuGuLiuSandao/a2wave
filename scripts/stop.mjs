#!/usr/bin/env node
/**
 * Quickly stop whatever is listening on the given ports.
 * Usage: pnpm stop [port...]
 * Defaults to the Web/API ports THIS checkout actually uses (WEB_PORT/PORT from
 * the root .env, falling back to 3501/3502). Previously the defaults were
 * hardcoded 3501/3502, so on a re-ported checkout (e.g. a worktree on
 * 3503/3504) it would kill the sibling main tree's servers instead.
 */
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { platform } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function defaultPorts() {
  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '../.env')
  if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(envPath)
    } catch {
      // fall through to hardcoded defaults
    }
  }
  const web = Number(process.env.WEB_PORT) || 3501
  const api = Number(process.env.PORT) || 3502
  return [web, api]
}

const ports = process.argv.slice(2).map(Number).filter(Boolean).length
  ? process.argv.slice(2).map(Number)
  : defaultPorts()

function killPort(port) {
  const isWin = platform() === 'win32'
  if (isWin) {
    try {
      const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' })
      const pids = [
        ...new Set(
          out
            .split('\n')
            .map((l) => l.trim().split(/\s+/).pop())
            .filter(Boolean),
        ),
      ]
      for (const pid of pids) {
        execSync(`taskkill /F /PID ${pid}`, { stdio: 'pipe' })
        console.log(`[stop] closed port ${port} (PID ${pid})`)
      }
    } catch (e) {
      if (e.status === 1) return // findstr found no match
      throw e
    }
    return
  }
  try {
    const pids = execSync(`lsof -ti :${port}`, { encoding: 'utf8' }).trim()
    if (pids) {
      execSync(`kill -9 ${pids.split(/\s+/).join(' ')}`, { stdio: 'pipe' })
      console.log(`[stop] closed port ${port}`)
    }
  } catch (e) {
    if (e.status === 1) return // no lsof result means no process on that port
  }
}

for (const port of ports) {
  killPort(port)
}
