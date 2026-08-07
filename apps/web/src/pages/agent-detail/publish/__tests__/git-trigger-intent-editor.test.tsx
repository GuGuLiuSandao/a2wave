/**
 * The intent field is a CodeMirror editor, but two controls outside it write to
 * the same value: the placeholder chips append, and Reset replaces. CodeMirror
 * owns its own document, so those writes only land if the editor keeps
 * following the `value` prop — a plain "controlled component" assumption that
 * is not automatic here. These tests pin it, since a desync would look like a
 * chip click doing nothing at all.
 */
import { renderWithProviders } from '@/test/render'
import { GIT_TRIGGER_INTENT_PLACEHOLDERS } from '@a2wave/shared'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { GitTriggerChannelSection } from '../git-trigger-channel-section'

/** Mirrors how publish-tab drives the section: fully controlled. */
function Harness({ initialIntent }: { initialIntent: string }) {
  const [intent, setIntent] = useState(initialIntent)
  return (
    <>
      <GitTriggerChannelSection
        provider="glab"
        repos={[{ url: '', project: '', host: '' }]}
        onReposChange={vi.fn()}
        events={['opened']}
        onEventsChange={vi.fn()}
        intervalSeconds={60}
        onIntervalSecondsChange={vi.fn()}
        intent={intent}
        onIntentChange={setIntent}
        targetBranches=""
        onTargetBranchesChange={vi.fn()}
        ignoreDrafts
        onIgnoreDraftsChange={vi.fn()}
        cliStatus={null}
        cliStatusLoading={false}
        onCheckCliStatus={vi.fn()}
      />
      {/* Read the controlled value back without depending on CodeMirror's DOM. */}
      <output data-testid="intent-value">{intent}</output>
    </>
  )
}

describe('git trigger intent editor', () => {
  it('appends a placeholder when its chip is clicked', async () => {
    const user = userEvent.setup()
    renderWithProviders(<Harness initialIntent="review" />)

    await user.click(screen.getByRole('button', { name: '{{title}}' }))

    await waitFor(() =>
      expect(screen.getByTestId('intent-value')).toHaveTextContent('review{{title}}'),
    )
  })

  it('offers a chip for every placeholder the API can substitute', () => {
    renderWithProviders(<Harness initialIntent="" />)
    for (const placeholder of GIT_TRIGGER_INTENT_PLACEHOLDERS) {
      expect(screen.getByRole('button', { name: placeholder })).toBeInTheDocument()
    }
  })

  it('restores the prefilled template when Reset is clicked', async () => {
    const user = userEvent.setup()
    renderWithProviders(<Harness initialIntent="something I regret" />)

    const reset = screen.getByRole('button', { name: /恢复默认/ })
    expect(reset).toBeEnabled()
    await user.click(reset)

    await waitFor(() => {
      const value = screen.getByTestId('intent-value').textContent ?? ''
      expect(value).toContain('{{repo}}')
      expect(value).toContain('{{url}}')
    })
  })

  it('disables Reset once the intent is back at the default', async () => {
    // Nothing left to restore, so the control must not look actionable.
    const user = userEvent.setup()
    renderWithProviders(<Harness initialIntent="edited" />)

    const reset = screen.getByRole('button', { name: /恢复默认/ })
    expect(reset).toBeEnabled()
    await user.click(reset)

    await waitFor(() => expect(screen.getByRole('button', { name: /恢复默认/ })).toBeDisabled())
  })

  it('drops the repeated channel heading, keeping the explanation', () => {
    renderWithProviders(<Harness initialIntent="" />)
    expect(screen.queryByText(/GitLab 仓库轮询/)).not.toBeInTheDocument()
    expect(screen.getByText(/平台会按设定周期用 CLI 读取仓库状态/)).toBeInTheDocument()
  })

  it('labels the field as a prompt rather than an intent', () => {
    renderWithProviders(<Harness initialIntent="" />)
    expect(screen.getByText('触发提示词')).toBeInTheDocument()
    expect(screen.queryByText('触发意图')).not.toBeInTheDocument()
  })
})
