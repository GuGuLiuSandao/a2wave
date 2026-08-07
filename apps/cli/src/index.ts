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

// Silent alias: rewrite the legacy `upgrade` to `update` without registering a
// second entry in subCommands — avoids two identical update commands in help.
// citty has no hidden mechanism, so this is the cleanest workaround.
if (process.argv[2] === 'upgrade') {
  process.argv[2] = 'update'
}

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

runMain(main).catch(handleError)
