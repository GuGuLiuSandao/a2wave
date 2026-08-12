import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Dialog, DialogContent, DialogTitle } from '../dialog'

describe('DialogTitle', () => {
  it('has stronger hierarchy than section headings', () => {
    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent>
          <DialogTitle>Create source</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    expect(screen.getByRole('heading', { name: 'Create source' })).toHaveClass('text-2xl')
  })
})
