#!/usr/bin/env node
import { defineCommand, runMain } from 'citty'
import { agentsCommand } from './commands/agents.js'
import { chatCommand } from './commands/chat.js'
import { configCommand } from './commands/config.js'
import { evalCommand } from './commands/eval.js'
import { kbCommand } from './commands/kb.js'
import { loginCommand, logoutCommand } from './commands/login.js'
import { mcpCommand } from './commands/mcp.js'
import { providersCommand } from './commands/providers.js'
import { runsCommand } from './commands/runs.js'
import { scmCommand } from './commands/scm.js'
import { setupCommand } from './commands/setup.js'
import { skillsCommand } from './commands/skills.js'
import { statusCommand } from './commands/status.js'
import { updateCommand } from './commands/update.js'
import { CliError } from './errors.js'
import { getVersion } from './version.js'

const main = defineCommand({
  meta: {
    name: 'a2wave',
    version: getVersion(),
    description: 'a2wave command-line tool',
  },
  subCommands: {
    setup: setupCommand,
    login: loginCommand,
    logout: logoutCommand,
    status: statusCommand,
    config: configCommand,
    skills: skillsCommand,
    agents: agentsCommand,
    chat: chatCommand,
    eval: evalCommand,
    mcp: mcpCommand,
    scm: scmCommand,
    kb: kbCommand,
    providers: providersCommand,
    runs: runsCommand,
    update: updateCommand,
  },
})

export function handleError(err: unknown): never {
  if (err instanceof CliError) {
    console.error(err.message)
    process.exit(1)
  }
  throw err
}

export function runCli(rawArgs: string[]): void {
  // citty only recognizes --version when it is the sole raw argument. Preserve
  // the documented compatibility form `a2wave setup --version` without
  // scanning option values such as `chat send -m "--version"`.
  if (
    rawArgs[0] === '--version' ||
    (rawArgs.length === 2 && rawArgs[0] === 'setup' && rawArgs[1] === '--version')
  ) {
    console.log(getVersion())
    return
  }

  // Silent alias: rewrite the legacy `upgrade` to `update` without registering
  // a duplicate command in help output.
  const normalizedArgs = rawArgs[0] === 'upgrade' ? ['update', ...rawArgs.slice(1)] : rawArgs
  runMain(main, { rawArgs: normalizedArgs }).catch(handleError)
}

runCli(process.argv.slice(2))
