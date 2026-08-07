import { renderWithProviders, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { McpServersPage } from '../mcp-servers'

const { useMcpServersMock, useCurrentUserMock } = vi.hoisted(() => ({
  useMcpServersMock: vi.fn(),
  useCurrentUserMock: vi.fn(),
}))

vi.mock('@/hooks/use-mcp-servers', () => ({
  useMcpServers: useMcpServersMock,
  useCloneMcpServer: () => ({ mutateAsync: vi.fn() }),
  useDeleteMcpServer: () => ({ mutateAsync: vi.fn() }),
}))

vi.mock('@/hooks/use-auth', () => ({ useCurrentUser: useCurrentUserMock }))

// The form modals pull in heavy editors; the page's URL wiring is what matters
// here, so stand in with something that just reports what it was handed.
vi.mock('@/components/mcp/mcp-server-form-modal', () => ({
  McpServerFormModal: ({ open, serverId }: { open: boolean; serverId?: string }) =>
    open ? <div data-testid="server-modal">{serverId ?? 'create'}</div> : null,
}))
vi.mock('@/components/mcp/mcp-group-form-modal', () => ({
  McpGroupFormModal: ({ open, serverId }: { open: boolean; serverId?: string }) =>
    open ? <div data-testid="group-modal">{serverId ?? 'create'}</div> : null,
}))

const SERVERS = [
  { id: 'mcp_1', name: 'alpha', type: 'stdio', description: 'a', config: {} },
  { id: 'mcp_2', name: 'beta', type: 'sse', description: 'b', config: {} },
  {
    id: 'mcp_3',
    name: 'gamma',
    type: 'group',
    description: 'g',
    groupConfig: { backends: { primary: ['tool_a'] } },
  },
]

function renderAt(path: string) {
  return renderWithProviders(<McpServersPage />, { routerProps: { initialEntries: [path] } })
}

describe('McpServersPage — URL state', () => {
  beforeEach(() => {
    useMcpServersMock.mockReturnValue({ data: { data: SERVERS }, isLoading: false })
    useCurrentUserMock.mockReturnValue({ data: { role: 'admin' } })
  })

  it('opens the server editor from a deep link', async () => {
    renderAt('/?server=mcp_1')
    expect(await screen.findByTestId('server-modal')).toHaveTextContent('mcp_1')
  })

  it('opens the group editor from a deep link', async () => {
    renderAt('/?group=mcp_3')
    expect(await screen.findByTestId('group-modal')).toHaveTextContent('mcp_3')
  })

  it('treats ?server=new as create mode', async () => {
    renderAt('/?server=new')
    expect(await screen.findByTestId('server-modal')).toHaveTextContent('create')
  })

  it('applies a type filter from the URL', async () => {
    renderAt('/?type=group')
    await waitFor(() => expect(screen.getByText('gamma')).toBeInTheDocument())
    expect(screen.queryByText('alpha')).not.toBeInTheDocument()
  })

  it('ignores an unknown type rather than rendering an empty page', async () => {
    // A hand-edited URL must degrade to "show everything", not to a blank grid.
    renderAt('/?type=bogus')
    await waitFor(() => expect(screen.getByText('alpha')).toBeInTheDocument())
    expect(screen.getByText('gamma')).toBeInTheDocument()
  })

  it('keeps the active filter when a modal is opened and closed', async () => {
    const user = userEvent.setup()
    renderAt('/?type=group&group=mcp_3')

    expect(await screen.findByTestId('group-modal')).toBeInTheDocument()
    await user.keyboard('{Escape}')

    // The filter must survive closing the dialog that was layered over it.
    await waitFor(() => expect(screen.getByText('gamma')).toBeInTheDocument())
    expect(screen.queryByText('alpha')).not.toBeInTheDocument()
  })
})
