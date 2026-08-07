import { Button } from '@/components/ui/button'
import { fireEvent, renderWithProviders, screen } from '@/test/render'
import { Link } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

describe('Button', () => {
  // A bare <button> defaults to type="submit". Since whole pages are wrapped in
  // a single <form>, an untyped Button anywhere inside one silently saved the
  // page on click — e.g. opening the evaluation case editor also saved the
  // agent config. Buttons opt into submitting; they do not default into it.
  it('does not submit its enclosing form unless asked to', () => {
    const onSubmit = vi.fn()
    renderWithProviders(
      <form onSubmit={onSubmit}>
        <Button>Open dialog</Button>
      </form>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open dialog' }))

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('still submits when explicitly typed as submit', () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault())
    renderWithProviders(
      <form onSubmit={onSubmit}>
        <Button type="submit">Save</Button>
      </form>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('preserves child content when rendered as a link', () => {
    renderWithProviders(
      <Button variant="outline" asChild>
        <Link to="/wiki">返回</Link>
      </Button>,
    )

    const link = screen.getByRole('link', { name: '返回' })
    expect(link).toHaveAttribute('href', '/wiki')
    expect(link).toHaveClass('text-foreground')
  })
})
