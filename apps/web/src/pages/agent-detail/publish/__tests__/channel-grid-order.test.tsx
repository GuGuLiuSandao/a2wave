/**
 * Card order in the publish grid.
 *
 * REST API is the one always-on channel and the baseline every Agent exposes,
 * so it anchors the grid. Onboarding pins Feishu to draw attention to it, and
 * that pin used to sort *above* the always-on card — shuffling the anchor into
 * second place for exactly the users least able to notice the order changed.
 */
import { renderWithProviders, screen } from '@/test/render'
import { describe, expect, it, vi } from 'vitest'
import { ChannelGrid } from '../channel-grid'
import { CHANNEL_REGISTRY, type ChannelKey } from '../channel-registry'

const noBlockers = Object.fromEntries(CHANNEL_REGISTRY.map((c) => [c.key, null])) as Record<
  ChannelKey,
  string | null
>
const allOff = Object.fromEntries(CHANNEL_REGISTRY.map((c) => [c.key, false])) as Record<
  ChannelKey,
  boolean
>

function renderGrid(pinnedChannel?: ChannelKey) {
  return renderWithProviders(
    <ChannelGrid
      enabled={{ ...allOff, api: true }}
      onEnabledChange={vi.fn()}
      blockReasons={noBlockers}
      onConfigure={vi.fn()}
      pinnedChannel={pinnedChannel}
    />,
  )
}

/** Card keys in the order they appear in the DOM. */
function renderedOrder(): string[] {
  return Array.from(document.querySelectorAll('[data-testid^="channel-card-"]')).map((node) =>
    (node.getAttribute('data-testid') ?? '').replace('channel-card-', ''),
  )
}

describe('ChannelGrid card order', () => {
  it('puts REST API first with no pin', () => {
    renderGrid()
    expect(renderedOrder()[0]).toBe('api')
  })

  it('keeps REST API first even when another channel is pinned', () => {
    renderGrid('feishu')
    const order = renderedOrder()
    expect(order[0]).toBe('api')
    // The pin still does its job — Feishu moves up, just not past the anchor.
    expect(order[1]).toBe('feishu')
  })

  it('renders every channel exactly once regardless of pinning', () => {
    // A comparator that returns -1 for both operands can drop or duplicate
    // entries in some engines; assert the set survives the sort.
    renderGrid('feishu')
    const order = renderedOrder()
    expect(order).toHaveLength(CHANNEL_REGISTRY.length)
    expect(new Set(order).size).toBe(CHANNEL_REGISTRY.length)
  })

  it('is a no-op when api itself is pinned', () => {
    renderGrid('api')
    expect(renderedOrder()).toEqual(CHANNEL_REGISTRY.map((c) => c.key))
  })
})
