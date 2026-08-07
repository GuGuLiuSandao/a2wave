/**
 * Custom render wrapper with all necessary providers for component tests.
 *
 * Usage:
 *   import { renderWithProviders, screen } from '@/test/render'
 *
 *   it('renders the component', () => {
 *     renderWithProviders(<MyComponent />)
 *     expect(screen.getByText('Hello')).toBeInTheDocument()
 *   })
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type RenderOptions, type RenderResult, render } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter, type MemoryRouterProps } from 'react-router-dom'
import i18n from '../i18n'

interface ProvidersProps {
  children: ReactNode
  routerProps?: MemoryRouterProps
}

function AllProviders({ children, routerProps }: ProvidersProps) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  })

  return (
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter {...routerProps}>{children}</MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>
  )
}

interface CustomRenderOptions extends Omit<RenderOptions, 'wrapper'> {
  /** MemoryRouter props (initialEntries, initialIndex, etc.) */
  routerProps?: MemoryRouterProps
}

/**
 * Render a component wrapped in QueryClient + Router + i18n providers.
 * Prefer this over bare `render()` for component tests.
 */
export function renderWithProviders(
  ui: ReactElement,
  options: CustomRenderOptions = {},
): RenderResult {
  const { routerProps, ...renderOptions } = options
  return render(ui, {
    wrapper: ({ children }) => <AllProviders routerProps={routerProps}>{children}</AllProviders>,
    ...renderOptions,
  })
}

// Re-export common testing utilities for convenient imports
export { screen, waitFor, within, act, fireEvent } from '@testing-library/react'
export { default as userEvent } from '@testing-library/user-event'
