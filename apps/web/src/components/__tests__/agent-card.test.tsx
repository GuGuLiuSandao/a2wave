import { renderWithProviders, screen } from '@/test/render'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentCard } from '../agent-card'

// AgentCard 依赖 useProviders 拉取副标题 Provider 名称——mock 成空列表即可。
vi.mock('@/hooks/use-providers', () => ({
  useProviders: () => ({ data: [] }),
}))

const baseAgent = {
  id: 'agt_1',
  name: 'Alpha Agent',
  type: 'cursor' as const,
  icon: '🤖',
  description: 'desc',
  publishStatus: 'draft' as const,
  publishChannels: ['api'] as ('api' | 'a2a' | 'feishu' | 'schedule' | 'oauth')[],
  feishuConfig: null,
  providerId: null,
  pinnedAt: null,
}

describe('AgentCard pin button', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does not render the pin button when onTogglePin is absent (no write perm)', () => {
    renderWithProviders(<AgentCard agent={baseAgent} />)
    expect(screen.queryByRole('button', { name: /pin|置顶/i })).toBeNull()
  })

  it('renders an un-pressed pin button when un-pinned and writable', () => {
    renderWithProviders(<AgentCard agent={baseAgent} onTogglePin={vi.fn()} />)
    const btn = screen.getByRole('button', { name: /^pin$|^置顶$/i })
    expect(btn).toBeInTheDocument()
    expect(btn).toHaveAttribute('aria-pressed', 'false')
  })

  it('renders a pressed pin button when pinned', () => {
    renderWithProviders(
      <AgentCard agent={{ ...baseAgent, pinnedAt: new Date() }} onTogglePin={vi.fn()} />,
    )
    const btn = screen.getByRole('button', { name: /unpin|取消置顶/i })
    expect(btn).toHaveAttribute('aria-pressed', 'true')
  })

  it('clicking toggles pin without navigating (stops the card link)', async () => {
    const onTogglePin = vi.fn()
    const { container } = renderWithProviders(
      <AgentCard agent={baseAgent} onTogglePin={onTogglePin} />,
    )
    const btn = screen.getByRole('button', { name: /^pin$|^置顶$/i })
    btn.click()
    expect(onTogglePin).toHaveBeenCalledWith({ id: 'agt_1', pinned: true })
    // The click must not change the route (card is a <Link>); assert we stayed put.
    expect(container.querySelector('a[href="/agents/agt_1"]')).toBeInTheDocument()
  })

  it('clicking an already-pinned agent requests unpin (pinned:false)', () => {
    const onTogglePin = vi.fn()
    renderWithProviders(
      <AgentCard agent={{ ...baseAgent, pinnedAt: new Date() }} onTogglePin={onTogglePin} />,
    )
    screen.getByRole('button', { name: /unpin|取消置顶/i }).click()
    expect(onTogglePin).toHaveBeenCalledWith({ id: 'agt_1', pinned: false })
  })

  it('does not fire toggle while a pin request is pending', () => {
    const onTogglePin = vi.fn()
    renderWithProviders(<AgentCard agent={baseAgent} onTogglePin={onTogglePin} pinPending />)
    const btn = screen.getByRole('button', { name: /^pin$|^置顶$/i })
    expect(btn).toBeDisabled()
    btn.click()
    expect(onTogglePin).not.toHaveBeenCalled()
  })
})
