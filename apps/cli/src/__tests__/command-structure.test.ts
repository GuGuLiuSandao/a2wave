import { describe, expect, it } from 'vitest'
import { agentsCommand } from '../commands/agents.js'
import { chatCommand } from '../commands/chat.js'
import { configCommand } from '../commands/config.js'
import { evalCommand } from '../commands/eval.js'
import { kbCommand } from '../commands/kb.js'
import { loginCommand } from '../commands/login.js'
import { mcpCommand } from '../commands/mcp.js'
import { providersCommand } from '../commands/providers.js'
import { runsCommand } from '../commands/runs.js'
import { scmCommand } from '../commands/scm.js'
import { skillsCommand } from '../commands/skills.js'

/**
 * Structural invariants of the citty command tree.
 *
 * Both rules below encode bugs that shipped and were invisible to unit tests,
 * because those tests call a command's `run()` directly and never exercise
 * citty's argument parser or router.
 */

type Node = {
  args?: Record<string, { type?: string; default?: unknown }>
  subCommands?: Record<string, Node>
}

const ROOTS: Array<[string, Node]> = [
  ['agents', agentsCommand as unknown as Node],
  ['chat', chatCommand as unknown as Node],
  ['config', configCommand as unknown as Node],
  ['eval', evalCommand as unknown as Node],
  ['kb', kbCommand as unknown as Node],
  ['login', loginCommand as unknown as Node],
  ['mcp', mcpCommand as unknown as Node],
  ['providers', providersCommand as unknown as Node],
  ['runs', runsCommand as unknown as Node],
  ['scm', scmCommand as unknown as Node],
  ['skills', skillsCommand as unknown as Node],
]

function walk(node: Node, path: string[], visit: (node: Node, path: string[]) => void): void {
  visit(node, path)
  for (const [name, sub] of Object.entries(node.subCommands ?? {})) {
    walk(sub, [...path, name], visit)
  }
}

describe('citty command tree invariants', () => {
  it('no node declares both subCommands and a positional argument', () => {
    // citty resolves the first non-flag argument against subCommands, so a
    // positional on the same node is unreachable: `a2wave chat my-agent` parsed
    // "my-agent" as a subcommand name and died with "Unknown command".
    const violations: string[] = []

    for (const [rootName, root] of ROOTS) {
      walk(root, [rootName], (node, path) => {
        const hasSubs = Object.keys(node.subCommands ?? {}).length > 0
        if (!hasSubs) return
        const positionals = Object.entries(node.args ?? {})
          .filter(([, spec]) => spec?.type === 'positional')
          .map(([name]) => name)
        if (positionals.length > 0) {
          violations.push(`a2wave ${path.join(' ')} → positionals ${JSON.stringify(positionals)}`)
        }
      })
    }

    expect(violations, `These nodes cannot be routed by citty:\n${violations.join('\n')}`).toEqual(
      [],
    )
  })

  it('no argument is named with a `no-` prefix', () => {
    // citty treats `--no-X` as negation of `X`: passing `--no-stream` sets
    // `args.stream = false` and never populates an arg literally named
    // "no-stream". Declaring the negative form makes the flag silently inert.
    // Declare the positive with `default: true` and read `=== false` instead.
    const violations: string[] = []

    for (const [rootName, root] of ROOTS) {
      walk(root, [rootName], (node, path) => {
        for (const name of Object.keys(node.args ?? {})) {
          if (name.startsWith('no-')) {
            violations.push(`a2wave ${path.join(' ')} → --${name}`)
          }
        }
      })
    }

    expect(violations, `These flags never receive a value:\n${violations.join('\n')}`).toEqual([])
  })
})
