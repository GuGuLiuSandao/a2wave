import { renderWithProviders, screen } from '@/test/render'
import { fireEvent } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AttachmentChip } from '../attachment-chip'

describe('AttachmentChip', () => {
  it('renders an image thumbnail when previewUrl is given', () => {
    renderWithProviders(<AttachmentChip name="pic.png" previewUrl="/api/attachments/att_x" />)
    const img = screen.getByAltText('pic.png') as HTMLImageElement
    expect(img).toBeInTheDocument()
    expect(img.src).toContain('/api/attachments/att_x')
  })

  it('falls back to the file icon when the image fails to load (expired)', () => {
    renderWithProviders(<AttachmentChip name="pic.png" previewUrl="/api/attachments/gone" />)
    const img = screen.getByAltText('pic.png')
    fireEvent.error(img)
    // after error the <img> is replaced by the filename chip (no img element)
    expect(screen.queryByAltText('pic.png')).not.toBeInTheDocument()
    expect(screen.getByText('pic.png')).toBeInTheDocument()
  })

  it('renders the file icon for non-image (no previewUrl)', () => {
    renderWithProviders(<AttachmentChip name="doc.pdf" />)
    expect(screen.queryByAltText('doc.pdf')).not.toBeInTheDocument()
    expect(screen.getByText('doc.pdf')).toBeInTheDocument()
  })
})
