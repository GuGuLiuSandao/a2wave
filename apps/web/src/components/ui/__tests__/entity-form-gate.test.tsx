import i18n from '@/i18n'
/**
 * Regression tests for the edit-form load gate.
 *
 * The bug it fixes: an edit form used to mount with blank `defaultValues` while
 * its detail query was still in flight, so a user on a slow connection could
 * type into that blank form and submit it — writing the defaults over the real
 * record (description/content nulled, credentials and sync config reset).
 */
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { EntityFormGate } from '../entity-form-gate'

const CHILD = <div data-testid="form">form body</div>

describe('EntityFormGate', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders children immediately in create mode', () => {
    render(
      <EntityFormGate isEditMode={false} isOpen isLoading={false} entity={undefined}>
        {CHILD}
      </EntityFormGate>,
    )
    expect(screen.getByTestId('form')).not.toBeNull()
  })

  it('withholds the form while the entity is still loading in edit mode', () => {
    render(
      <EntityFormGate isEditMode isOpen isLoading entity={undefined}>
        {CHILD}
      </EntityFormGate>,
    )
    // This is the core of the fix: no mounted form means nothing to submit.
    expect(screen.queryByTestId('form')).toBeNull()
    expect(screen.getByRole('status')).not.toBeNull()
  })

  it('renders the form once the entity has loaded', () => {
    render(
      <EntityFormGate isEditMode isOpen isLoading={false} entity={{ id: 'x' }}>
        {CHILD}
      </EntityFormGate>,
    )
    expect(screen.getByTestId('form')).not.toBeNull()
  })

  it('shows an error state (not a blank form) when the initial load fails', () => {
    render(
      <EntityFormGate
        isEditMode
        isOpen
        isLoading={false}
        error={{ message: 'HTTP_404' }}
        entity={undefined}
      >
        {CHILD}
      </EntityFormGate>,
    )
    expect(screen.queryByTestId('form')).toBeNull()
    expect(screen.getByText('Failed to load — close and try again')).not.toBeNull()
    // Translated copy, not the raw code — `HTTP_404` must never reach the user.
    expect(screen.getByText('Resource not found')).not.toBeNull()
    expect(screen.queryByText('HTTP_404')).toBeNull()
  })

  it('passes a prose error through — it is already user-facing', () => {
    render(
      <EntityFormGate
        isEditMode
        isOpen
        isLoading={false}
        error={{ message: 'Cannot delete: referenced by agents: Alpha' }}
        entity={undefined}
      >
        {CHILD}
      </EntityFormGate>,
    )
    expect(screen.getByText('Cannot delete: referenced by agents: Alpha')).not.toBeNull()
  })

  it('shows generic copy rather than leaking an unrecognised code', () => {
    render(
      <EntityFormGate
        isEditMode
        isOpen
        isLoading={false}
        error={{ message: 'SOME_UNMAPPED_CODE' }}
        entity={undefined}
      >
        {CHILD}
      </EntityFormGate>,
    )
    expect(screen.getByText('Something went wrong. Please try again.')).not.toBeNull()
    expect(screen.queryByText('SOME_UNMAPPED_CODE')).toBeNull()
  })

  it('keeps the form mounted when a background refetch fails but data is still held', () => {
    // TanStack keeps the last good `data` alongside a refetch error. Unmounting
    // here would wipe out whatever the user had already typed — KB documents
    // poll every 30s and every detail query refetches on window focus, so this
    // fires during ordinary editing.
    render(
      <EntityFormGate
        isEditMode
        isOpen
        isLoading={false}
        error={{ message: 'refresh failed' }}
        entity={{ id: 'x' }}
      >
        {CHILD}
      </EntityFormGate>,
    )
    expect(screen.getByTestId('form')).not.toBeNull()
    expect(screen.queryByText('Failed to load — close and try again')).toBeNull()
    // ...and the staleness is surfaced non-destructively.
    expect(screen.getByTestId('entity-refresh-warning')).not.toBeNull()
  })

  it('shows no refresh warning when the entity loaded cleanly', () => {
    render(
      <EntityFormGate isEditMode isOpen isLoading={false} entity={{ id: 'x' }}>
        {CHILD}
      </EntityFormGate>,
    )
    expect(screen.queryByTestId('entity-refresh-warning')).toBeNull()
  })

  it('treats a settled-but-missing entity as not found rather than an empty form', () => {
    render(
      <EntityFormGate isEditMode isOpen isLoading={false} entity={undefined}>
        {CHILD}
      </EntityFormGate>,
    )
    expect(screen.queryByTestId('form')).toBeNull()
    expect(screen.getByText('Failed to load — close and try again')).not.toBeNull()
  })

  it('passes children through when the host modal is closed', () => {
    // A closed modal disables its detail query, which pins `isPending` true —
    // gating on that would flash a skeleton into the hidden modal.
    render(
      <EntityFormGate isEditMode isOpen={false} isLoading entity={undefined}>
        {CHILD}
      </EntityFormGate>,
    )
    expect(screen.getByTestId('form')).not.toBeNull()
  })
})
