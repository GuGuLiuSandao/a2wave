import type { FeishuStreamingCard } from './feishu-card-streaming.js'
import { logger } from './logger.js'

interface RegistryEntry {
  card: FeishuStreamingCard
  showLocalChildOutput: boolean
  showRemoteChildOutput: boolean
  lastActivityAt: number
}

const registry = new Map<string, RegistryEntry>()

/** Maximum run duration plus one cleanup interval — safety net when unregister is missed. */
const ENTRY_TTL_MS = 125 * 60 * 1000
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000

let cleanupTimer: ReturnType<typeof setInterval> | null = null

function ensureCleanupTimer(): void {
  if (cleanupTimer) return
  cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [cardId, entry] of registry) {
      if (now - entry.lastActivityAt > ENTRY_TTL_MS) {
        registry.delete(cardId)
        logger.warn({ cardId }, 'Streaming card registry entry expired (TTL)')
      }
    }
    if (registry.size === 0 && cleanupTimer) {
      clearInterval(cleanupTimer)
      cleanupTimer = null
    }
  }, CLEANUP_INTERVAL_MS)
  cleanupTimer.unref()
}

export function registerStreamingCard(
  cardId: string,
  card: FeishuStreamingCard,
  options: { showLocalChildOutput?: boolean; showRemoteChildOutput?: boolean } = {},
): void {
  registry.set(cardId, {
    card,
    showLocalChildOutput: options.showLocalChildOutput ?? true,
    showRemoteChildOutput: options.showRemoteChildOutput ?? true,
    lastActivityAt: Date.now(),
  })
  ensureCleanupTimer()
}

export function unregisterStreamingCard(cardId: string): void {
  registry.delete(cardId)
}

export function getStreamingCard(cardId: string): FeishuStreamingCard | undefined {
  return registry.get(cardId)?.card
}

export function touchStreamingCard(cardId: string): boolean {
  const entry = registry.get(cardId)
  if (!entry) return false
  entry.lastActivityAt = Date.now()
  return true
}

/** Check whether a local child agent's output should be shown on the parent card */
export function shouldShowLocalChildOutput(cardId: string): boolean {
  return registry.get(cardId)?.showLocalChildOutput ?? true
}

/** Check whether a remote child agent's output should be shown on the parent card */
export function shouldShowRemoteChildOutput(cardId: string): boolean {
  return registry.get(cardId)?.showRemoteChildOutput ?? true
}

/** @internal — test-only: reset module state so fake timers work correctly */
export function _resetForTesting(): void {
  registry.clear()
  if (cleanupTimer) {
    clearInterval(cleanupTimer)
    cleanupTimer = null
  }
}
