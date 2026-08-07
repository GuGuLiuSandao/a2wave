import { renderWithProviders, screen, userEvent } from '@/test/render'
import { describe, expect, it, vi } from 'vitest'
import { Pagination } from '../pagination'

describe('Pagination', () => {
  it('renders total, current page and navigates with bounds', async () => {
    const onPageChange = vi.fn()
    const user = userEvent.setup()

    renderWithProviders(
      <Pagination
        pagination={{ total: 51, page: 1, pageSize: 50, totalPages: 2 }}
        onPageChange={onPageChange}
        totalLabel="共 51 个 Agent"
        previousLabel="上一页"
        nextLabel="下一页"
      />,
    )

    expect(screen.getByText('共 51 个 Agent')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '第 1 页' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: '第 2 页' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /上一页/ })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: /下一页/ }))
    expect(onPageChange).toHaveBeenCalledWith(2)
  })

  it('condenses large page ranges and allows jumping to a nearby page', async () => {
    const onPageChange = vi.fn()
    const user = userEvent.setup()

    renderWithProviders(
      <Pagination
        pagination={{ total: 240, page: 6, pageSize: 24, totalPages: 10 }}
        onPageChange={onPageChange}
        totalLabel="共 240 个 Agent"
        previousLabel="上一页"
        nextLabel="下一页"
      />,
    )

    expect(screen.getByRole('button', { name: '第 1 页' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '第 5 页' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '第 6 页' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: '第 7 页' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '第 10 页' })).toBeInTheDocument()
    expect(screen.getAllByText('...')).toHaveLength(2)

    await user.click(screen.getByRole('button', { name: '第 7 页' }))
    expect(onPageChange).toHaveBeenCalledWith(7)
  })

  it('does not render when there is only one page', () => {
    const { container } = renderWithProviders(
      <Pagination
        pagination={{ total: 3, page: 1, pageSize: 50, totalPages: 1 }}
        onPageChange={vi.fn()}
        totalLabel="共 3 个 Agent"
        previousLabel="上一页"
        nextLabel="下一页"
      />,
    )

    expect(container).toBeEmptyDOMElement()
  })
})
