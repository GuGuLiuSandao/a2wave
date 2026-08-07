import i18n from '@/i18n'
import { renderWithProviders, screen, userEvent } from '@/test/render'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SkillUploadDialog } from '../skill-upload-dialog'

vi.mock('antd', () => ({
  Modal: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <dialog open>{children}</dialog> : null,
  Select: ({
    id,
    value,
    disabled,
    options,
    onChange,
  }: {
    id?: string
    value: string
    disabled?: boolean
    options: Array<{ value: string; label: string; disabled?: boolean }>
    onChange: (value: string) => void
  }) => (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}))

describe('SkillUploadDialog', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('defaults to private and prevents a regular user from choosing all-users', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    renderWithProviders(
      <SkillUploadDialog
        open
        isAdmin={false}
        isPending={false}
        selection={{ kind: 'file', name: 'SKILL.md' }}
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />,
    )

    expect(screen.getByText('Selected file: SKILL.md')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'All users' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Upload' }))

    expect(onConfirm).toHaveBeenCalledWith('private')
  })

  it('lets an administrator upload for all users', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    renderWithProviders(
      <SkillUploadDialog
        open
        isAdmin
        isPending={false}
        selection={{ kind: 'folder', count: 3 }}
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />,
    )

    expect(screen.getByText('Selected folder: 3 files')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Visibility'), 'all-users')
    await user.click(screen.getByRole('button', { name: 'Upload' }))

    expect(onConfirm).toHaveBeenCalledWith('all-users')
  })
})
