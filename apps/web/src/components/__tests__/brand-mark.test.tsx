import { renderWithProviders, screen } from '@/test/render'
import { fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrandMark } from '../brand-mark'

const useSettingsMock = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/use-settings', () => ({
  useSettings: useSettingsMock,
}))

function settings(faviconUrl?: string) {
  return { data: { branding: { faviconUrl } } }
}

afterEach(() => vi.clearAllMocks())

describe('BrandMark', () => {
  it('renders the configured favicon image', () => {
    useSettingsMock.mockReturnValue(settings('/brand-icons/default.svg'))
    renderWithProviders(<BrandMark className="size-8" iconClassName="h-4 w-4" />)
    const img = screen.getByRole('presentation', { hidden: true }) as HTMLImageElement
    expect(img.tagName).toBe('IMG')
    expect(img).toHaveAttribute('src', '/brand-icons/default.svg')
  })

  it('falls back to the gradient placeholder when settings have no favicon', () => {
    useSettingsMock.mockReturnValue(settings(undefined))
    const { container } = renderWithProviders(<BrandMark iconClassName="h-4 w-4" />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
    expect(container.firstElementChild).toHaveClass('text-primary-foreground')
    expect(container.firstElementChild).not.toHaveClass('text-white')
  })

  it('falls back to the gradient placeholder when a stale preset favicon fails to load', () => {
    // Older installs persisted a now-removed preset path; the image 404s.
    useSettingsMock.mockReturnValue(settings('/brand-icons/aurora.svg'))
    const { container } = renderWithProviders(<BrandMark iconClassName="h-4 w-4" />)
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    // Simulate the broken-image load error → component swaps to the placeholder.
    fireEvent.error(img as HTMLImageElement)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })
})
