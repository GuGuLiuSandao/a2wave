import { renderWithProviders, screen, waitFor } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuditLogsPage } from '../audit-logs'

const fetchMock = vi.fn()

function log(action: string, extra: Record<string, unknown> = {}) {
  return {
    id: `aud_${action}`,
    userId: 'usr_1',
    username: 'testadmin',
    action,
    resource: null,
    resourceId: null,
    details: null,
    ipAddress: '127.0.0.1',
    createdAt: '2026-07-29T10:00:00.000Z',
    ...extra,
  }
}

function respondWith(logs: ReturnType<typeof log>[]) {
  fetchMock.mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve({
        data: logs,
        pagination: { page: 1, pageSize: 20, total: logs.length, totalPages: 1 },
      }),
  })
}

describe('AuditLogsPage — action labels', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('renders a translated label instead of the raw action key', async () => {
    respondWith([log('auth.oauth.login')])
    renderWithProviders(<AuditLogsPage />)

    await waitFor(() => {
      expect(screen.getByText('企业身份登录')).toBeInTheDocument()
    })
    expect(screen.queryByText('auth.oauth.login')).not.toBeInTheDocument()
  })

  it('translates resource types too', async () => {
    respondWith([log('agent.create', { resource: 'scm_source' })])
    renderWithProviders(<AuditLogsPage />)

    await waitFor(() => {
      expect(screen.getByText('创建 Agent')).toBeInTheDocument()
    })
    expect(screen.getByText('代码源')).toBeInTheDocument()
  })

  it('offers every known action in the filter, not just those on the current page', async () => {
    // The dropdown used to be built from `logs`, so page 1 having three distinct
    // actions meant you could only ever filter by those three — and reaching any
    // other action required already being on a page that showed it.
    respondWith([log('auth.oauth.login')])
    const user = userEvent.setup()
    renderWithProviders(<AuditLogsPage />)

    await waitFor(() => expect(screen.getByText('企业身份登录')).toBeInTheDocument())
    await user.click(screen.getByLabelText('操作'))

    // "创建 Agent" is in the catalogue but absent from the single returned row,
    // so its presence proves the options no longer come from `logs`. antd
    // virtualises the list (jsdom gives it zero height, rendering only the first
    // couple of items), so asserting on the full option count is not viable here
    // — the search box is what a user reaches for anyway.
    expect(await screen.findByTitle('创建 Agent')).toBeInTheDocument()
    await user.type(screen.getByLabelText('操作'), '删除技能')
    expect(await screen.findByTitle('删除技能')).toBeInTheDocument()
  })

  it('keeps retired action labels available for historical audit records', async () => {
    respondWith([log('auth.oauth.login')])
    const user = userEvent.setup()
    renderWithProviders(<AuditLogsPage />)

    await waitFor(() => expect(screen.getByText('企业身份登录')).toBeInTheDocument())
    await user.click(screen.getByLabelText('操作'))
    await user.type(screen.getByLabelText('操作'), '执行代码源初始化脚本')

    expect(await screen.findByTitle('执行代码源初始化脚本')).toBeInTheDocument()
  })

  it('puts the selected filter in the URL and resets to page 1', async () => {
    respondWith([log('auth.oauth.login')])
    const user = userEvent.setup()
    renderWithProviders(<AuditLogsPage />, { routerProps: { initialEntries: ['/?page=5'] } })

    await waitFor(() => expect(screen.getByText('企业身份登录')).toBeInTheDocument())
    await user.click(screen.getByLabelText('操作'))
    await user.click(await screen.findByTitle('创建 Agent'))

    // Both writes must survive: selecting a filter while on page 5 has to record
    // the filter *and* drop the stale page, or the user lands on an empty page.
    // MemoryRouter keeps the URL out of window.location, so assert on the request
    // the page actually issues — which is what the URL state exists to drive.
    await waitFor(() => {
      const last = fetchMock.mock.calls.at(-1)?.[0] as string
      const requested = new URL(last, 'http://localhost')
      expect(requested.searchParams.get('action')).toBe('agent.create')
      expect(requested.searchParams.get('page')).toBe('1')
    })
  })

  it('restores filters from a deep link', async () => {
    respondWith([log('agent.create')])
    renderWithProviders(<AuditLogsPage />, {
      routerProps: { initialEntries: ['/?action=agent.create'] },
    })

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const requested = new URL(fetchMock.mock.calls[0][0], 'http://localhost')
    expect(requested.searchParams.get('action')).toBe('agent.create')
  })

  it('sends a date range to the API when a preset is deep-linked', async () => {
    respondWith([log('agent.create')])
    renderWithProviders(<AuditLogsPage />, { routerProps: { initialEntries: ['/?range=7d'] } })

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const requested = new URL(fetchMock.mock.calls[0][0] as string, 'http://localhost')
    expect(requested.searchParams.get('startDate')).toBeTruthy()
    expect(requested.searchParams.get('endDate')).toBeTruthy()
  })

  it('sends no date bounds by default', async () => {
    // The audit log defaults to the full history; a silent 24h window would hide
    // entries an auditor came looking for.
    respondWith([log('agent.create')])
    renderWithProviders(<AuditLogsPage />)

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const requested = new URL(fetchMock.mock.calls[0][0] as string, 'http://localhost')
    expect(requested.searchParams.get('startDate')).toBeNull()
  })

  it('uses explicit bounds in custom mode', async () => {
    respondWith([log('agent.create')])
    renderWithProviders(<AuditLogsPage />, {
      routerProps: {
        initialEntries: [
          '/?range=custom&start=2026-07-01T00:00:00.000Z&end=2026-07-15T23:59:59.999Z',
        ],
      },
    })

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const requested = new URL(fetchMock.mock.calls[0][0] as string, 'http://localhost')
    expect(requested.searchParams.get('startDate')).toBe('2026-07-01T00:00:00.000Z')
    expect(requested.searchParams.get('endDate')).toBe('2026-07-15T23:59:59.999Z')
  })

  it('falls back to the raw key for an action with no translation', async () => {
    respondWith([log('future.unmapped_action')])
    renderWithProviders(<AuditLogsPage />)

    // An unknown action must stay legible rather than rendering an empty tag.
    await waitFor(() => {
      expect(screen.getByText('future.unmapped_action')).toBeInTheDocument()
    })
  })
})

describe('AuditLogsPage — details column', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('keeps the details JSON collapsed until the toggle is clicked', async () => {
    respondWith([log('agent.update', { details: { changedField: 'description' } })])
    const user = userEvent.setup()
    renderWithProviders(<AuditLogsPage />)

    await waitFor(() => expect(screen.getByText('更新 Agent')).toBeInTheDocument())

    // Collapsed by default: the raw JSON must not be in the DOM at all, not
    // just visually hidden — a large payload otherwise blows out row height.
    expect(screen.queryByText(/"changedField"/)).not.toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: '详情' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await user.click(toggle)

    expect(screen.getByText(/"changedField"/)).toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })

  it('expands the JSON into a full-width row instead of inside the details cell', async () => {
    // A 200px details cell shatters a real payload — a masked SCM source config
    // carries full repo URLs — into an unreadable sliver, so the expanded JSON
    // has to escape the cell and span the table.
    respondWith([
      log('scm_source.create', {
        details: { name: 'platform', config: { repos: ['https://git.example.com/org/repo.git'] } },
      }),
    ])
    const user = userEvent.setup()
    renderWithProviders(<AuditLogsPage />)

    await waitFor(() => expect(screen.getByText('创建代码源')).toBeInTheDocument())
    const toggle = screen.getByRole('button', { name: '详情' })
    await user.click(toggle)

    const json = screen.getByText(/"platform"/)
    expect(toggle.closest('td')).not.toContainElement(json)

    const headerCount = screen.getAllByRole('columnheader').length
    expect(json.closest('td')).toHaveAttribute('colspan', String(headerCount))
    expect(json.closest('tr')).toHaveClass('ant-table-expanded-row')
  })

  it('keeps the details column itself, without antd adding a second toggle column', async () => {
    // Driving antd's expansion from a toggle inside the details column must not
    // let antd insert its own expand column: e2e/tests/admin/audit-logs.spec.ts
    // asserts the `详情` columnheader, and a duplicate toggle would be worse UI.
    respondWith([log('agent.update', { details: { changedField: 'description' } })])
    const user = userEvent.setup()
    renderWithProviders(<AuditLogsPage />)

    await waitFor(() => expect(screen.getByText('更新 Agent')).toBeInTheDocument())
    expect(screen.getByRole('columnheader', { name: '详情' })).toBeInTheDocument()
    expect(screen.getAllByRole('columnheader')).toHaveLength(6)

    await user.click(screen.getByRole('button', { name: '详情' }))

    expect(screen.getByRole('columnheader', { name: '详情' })).toBeInTheDocument()
    expect(screen.getAllByRole('columnheader')).toHaveLength(6)
  })

  it('keeps the expanded JSON breakable so one long token cannot widen the table', async () => {
    // jsdom has no layout engine, so this guards the class rather than
    // reproducing the overflow. Still worth asserting: the table resolves to
    // table-layout: auto, so the expanded cell's min-content width feeds back
    // into every column, and dropping break-all let a single ~130+ char token
    // (a P4 depot path) widen the whole table — the very layout mess this
    // feature exists to fix. It was already removed once as "cosmetic".
    respondWith([
      log('scm_source.create', {
        details: { depotPath: `//depot/${'a_very_long_unbreakable_segment'.repeat(6)}/...` },
      }),
    ])
    const user = userEvent.setup()
    renderWithProviders(<AuditLogsPage />)

    await waitFor(() => expect(screen.getByText('创建代码源')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: '详情' }))

    expect(screen.getByText(/depotPath/).closest('pre')).toHaveClass('break-all')
  })

  it('shows no expand toggle and no expandable row when there is no details payload', async () => {
    respondWith([log('agent.create')])
    renderWithProviders(<AuditLogsPage />)

    await waitFor(() => expect(screen.getByText('创建 Agent')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: '详情' })).not.toBeInTheDocument()
    expect(document.querySelector('.ant-table-expanded-row')).toBeNull()
  })
})
