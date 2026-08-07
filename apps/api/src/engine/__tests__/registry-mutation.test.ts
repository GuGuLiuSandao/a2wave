import { beforeEach, describe, expect, it, vi } from 'vitest'

const { FakeEngine, loggerMock, shutdownMock } = vi.hoisted(() => ({
  FakeEngine: class {
    constructor(
      readonly type: string,
      private readonly healthy = true,
    ) {}
    async healthCheck() {
      return this.healthy
    }
  },
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  shutdownMock: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../lib/logger.js', () => ({ logger: loggerMock }))
vi.mock('../provider-catalog.js', () => ({
  providerCatalog: { attachEngine: vi.fn() },
}))
vi.mock('../cli-process-runner.js', () => ({
  cliProcessRunner: {
    cancelAndWait: vi.fn(),
    shutdown: shutdownMock,
  },
}))

vi.mock('../cursor-agent.js', () => ({
  CursorAgentEngine: class extends FakeEngine {
    constructor() {
      super('cursor')
    }
  },
}))
vi.mock('../claude-code.js', () => ({
  ClaudeCodeEngine: class extends FakeEngine {
    constructor() {
      super('claude-code')
    }
  },
}))
vi.mock('../codex-agent.js', () => ({
  CodexAgentEngine: class extends FakeEngine {
    constructor() {
      super('codex', false)
    }
  },
}))
vi.mock('../opencode-agent.js', () => ({
  OpencodeAgentEngine: class extends FakeEngine {
    constructor() {
      super('opencode')
    }
  },
}))
vi.mock('../qoder-agent.js', () => ({
  QoderAgentEngine: class extends FakeEngine {
    constructor() {
      super('qoder')
    }
  },
}))
vi.mock('../trae-agent.js', () => ({
  TraeAgentEngine: class extends FakeEngine {
    constructor() {
      super('trae')
    }
  },
}))
vi.mock('../pi-agent.js', () => ({
  PiAgentEngine: class extends FakeEngine {
    constructor() {
      super('pi')
    }
  },
}))

import { engineRegistry } from '../registry.js'

beforeEach(() => {
  loggerMock.info.mockClear()
  loggerMock.error.mockClear()
  shutdownMock.mockClear()
  shutdownMock.mockResolvedValue(undefined)
})

describe('register diagnostics', () => {
  it('logs the registered engine type', async () => {
    const fake = { type: 'mutation-test-eng', healthCheck: async () => true } as never
    engineRegistry.register(fake)

    expect(loggerMock.info).toHaveBeenCalledWith(
      { type: 'mutation-test-eng' },
      'Registered agent engine',
    )
  })

  it('lists available engines with the canonical error format', async () => {
    expect(() => engineRegistry.getOrThrow('does-not-exist')).toThrow(
      /No engine registered for type "does-not-exist"\. Available: \[cursor, claude-code, codex, opencode, qoder, kimi, pi, trae/,
    )
  })
})

describe('process signal shutdown', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('%s delegates once to the global runner', (signal) => {
    const handlers = process.listeners(signal)
    expect(handlers.length).toBeGreaterThanOrEqual(1)

    handlers.at(-1)?.(signal)

    expect(shutdownMock).toHaveBeenCalledTimes(1)
    expect(loggerMock.info).toHaveBeenCalledWith(
      { signal },
      'Received shutdown signal, terminating all Agent CLI processes',
    )
  })
})
