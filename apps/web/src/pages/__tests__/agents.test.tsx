import { renderWithProviders, screen, userEvent } from '@/test/render'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentsPage } from '../agents'

const { startOnboarding, useAgentsMock } = vi.hoisted(() => ({
  startOnboarding: vi.fn(),
  useAgentsMock: vi.fn(),
}))

vi.mock('@/components/agent-card', () => ({
  AgentCard: ({ agent }: { agent: { id: string; name: string } }) => (
    <a href={`/agents/${agent.id}`}>{agent.name}</a>
  ),
}))

vi.mock('@/components/import-agent-dialog', () => ({
  ImportAgentDialog: () => null,
}))

vi.mock('@/hooks/use-agents', () => ({
  useAgents: (params: { page?: number; pageSize?: number }) => useAgentsMock(params),
  useFeishuConnections: () => ({ data: { byId: new Map() }, isLoading: false }),
  useNativeChatConnections: () => ({
    connections: { feishu: new Map(), slack: new Map(), discord: new Map() },
    isLoading: false,
    errorByChannel: { feishu: false, slack: false, discord: false },
  }),
  useSetAgentPinned: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
}))

vi.mock('@/hooks/use-onboarding', () => ({
  useOnboarding: () => ({ start: startOnboarding }),
}))

describe('AgentsPage', () => {
  beforeEach(() => {
    startOnboarding.mockClear()
    useAgentsMock.mockReset()
    useAgentsMock.mockImplementation(({ page, pageSize }: { page: number; pageSize: number }) => ({
      data: {
        data:
          page === 1
            ? [{ id: 'agt_page_1', name: '第一页 Agent' }]
            : [{ id: 'agt_page_2', name: '第二页 Agent' }],
        pagination: { total: 51, page, pageSize, totalPages: 2 },
      },
      isLoading: false,
    }))
  })

  it('uses paginated agent data and can navigate to the next page', async () => {
    const user = userEvent.setup()

    renderWithProviders(<AgentsPage />, { routerProps: { initialEntries: ['/agents'] } })

    expect(screen.getByText('第一页 Agent')).toBeInTheDocument()
    expect(screen.getByText('共 51 个 Agent')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '第 1 页' })).toHaveAttribute('aria-current', 'page')
    expect(useAgentsMock).toHaveBeenLastCalledWith({ page: 1, pageSize: 24 })

    await user.click(screen.getByRole('button', { name: /下一页/ }))

    expect(screen.getByText('第二页 Agent')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '第 2 页' })).toHaveAttribute('aria-current', 'page')
    expect(useAgentsMock).toHaveBeenLastCalledWith({ page: 2, pageSize: 24 })
  })

  it('reads the current page from the route query', () => {
    renderWithProviders(<AgentsPage />, { routerProps: { initialEntries: ['/agents?page=2'] } })

    expect(screen.getByText('第二页 Agent')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '第 2 页' })).toHaveAttribute('aria-current', 'page')
    expect(useAgentsMock).toHaveBeenLastCalledWith({ page: 2, pageSize: 24 })
  })

  it('offers the full localized scenario template catalog', async () => {
    const user = userEvent.setup()
    renderWithProviders(<AgentsPage />, { routerProps: { initialEntries: ['/agents'] } })

    await user.click(screen.getByRole('button', { name: '新建 Agent' }))

    for (const name of [
      '空白创建',
      '我的第一个 Agent',
      '支持调查助手',
      '代码库问答',
      '代码审查助手',
      '事件分析助手',
      '数据巡检助手',
      '文档维护助手',
      '生成文件产物',
      '网页应用生成器',
    ]) {
      expect(screen.getByText(name, { exact: true })).toBeInTheDocument()
    }
  })
})
