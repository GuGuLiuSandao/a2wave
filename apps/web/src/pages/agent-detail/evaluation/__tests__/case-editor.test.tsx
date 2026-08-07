import { renderWithProviders, screen } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CaseEditor } from '../case-editor'

function setup(overrides: Partial<Parameters<typeof CaseEditor>[0]> = {}) {
  const onSubmit = vi.fn()
  renderWithProviders(
    <CaseEditor
      open
      onOpenChange={vi.fn()}
      editing={null}
      onSubmit={onSubmit}
      isPending={false}
      {...overrides}
    />,
  )
  return { onSubmit, user: userEvent.setup() }
}

const requestBoxes = () => screen.getAllByLabelText(/请求|Request/i)

describe('CaseEditor', () => {
  it('starts with a single turn, since most cases are single-turn', () => {
    setup()
    expect(requestBoxes()).toHaveLength(1)
  })

  it('adds and removes turns', async () => {
    const { user } = setup()

    await user.click(screen.getByRole('button', { name: /添加一轮|Add turn/i }))
    expect(requestBoxes()).toHaveLength(2)

    const removeButtons = screen.getAllByRole('button', { name: /删除该轮|Remove turn/i })
    await user.click(removeButtons[0])
    expect(requestBoxes()).toHaveLength(1)
  })

  // Per-turn controls are hidden entirely for a single-turn case rather than
  // shown disabled: there is nothing to reorder or remove, so an inert row of
  // greyed buttons would be pure noise.
  it('hides per-turn controls when there is only one turn', () => {
    setup()
    expect(screen.queryByRole('button', { name: /删除该轮|Remove turn/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /上移|Move turn up/i })).toBeNull()
  })

  it('keeps typed text attached to its turn when reordering', async () => {
    const { user } = setup()

    await user.type(requestBoxes()[0], 'first')
    await user.click(screen.getByRole('button', { name: /添加一轮|Add turn/i }))
    await user.type(requestBoxes()[1], 'second')

    // Only the second turn can move up, so this is that button. The text must
    // travel with the turn rather than staying at its old position.
    const moveUp = screen.getAllByRole('button', { name: /上移|Move turn up/i })
    expect(moveUp).toHaveLength(1)
    await user.click(moveUp[0])

    const values = requestBoxes().map((el) => (el as HTMLTextAreaElement).value)
    expect(values).toEqual(['second', 'first'])
  })

  it('submits trimmed turns without internal ids', async () => {
    const { onSubmit, user } = setup()

    await user.type(requestBoxes()[0], '  hello  ')
    await user.click(screen.getByRole('button', { name: /保存|Save/i }))

    expect(onSubmit).toHaveBeenCalledWith({
      name: 'hello',
      turns: [{ request: 'hello', expectedResponse: '' }],
    })
  })

  // The name field was removed: a case is identified by its first request, so
  // asking for a separate title made the user label what they just wrote.
  it('derives the name from the first request', async () => {
    const { onSubmit, user } = setup()

    await user.type(requestBoxes()[0], 'I want a refund')
    await user.click(screen.getByRole('button', { name: /保存|Save/i }))

    expect(onSubmit.mock.calls[0][0].name).toBe('I want a refund')
  })

  it('truncates a long derived name instead of storing a paragraph', async () => {
    const { onSubmit, user } = setup()

    await user.type(requestBoxes()[0], 'x'.repeat(120))
    await user.click(screen.getByRole('button', { name: /保存|Save/i }))

    const submitted = onSubmit.mock.calls[0][0].name as string
    expect(submitted.length).toBeLessThanOrEqual(61)
    expect(submitted.endsWith('…')).toBe(true)
  })

  it('keeps an existing name when editing rather than overwriting it', async () => {
    const { onSubmit, user } = setup({
      editing: {
        id: 'evc_1',
        setId: 'evs_1',
        name: 'renamed by user',
        turns: [{ request: 'original request', expectedResponse: '' }],
        sortOrder: 0,
        createdAt: '',
        updatedAt: '',
      },
    })

    await user.click(screen.getByRole('button', { name: /保存|Save/i }))
    expect(onSubmit.mock.calls[0][0].name).toBe('renamed by user')
  })

  it('blocks submit until every turn has a request', async () => {
    const { user } = setup()

    expect(screen.getByRole('button', { name: /保存|Save/i })).toBeDisabled()

    await user.type(requestBoxes()[0], 'now valid')
    expect(screen.getByRole('button', { name: /保存|Save/i })).toBeEnabled()
  })

  it('seeds turns from the case being edited', () => {
    setup({
      editing: {
        id: 'evc_1',
        setId: 'evs_1',
        name: 'existing',
        turns: [
          { request: 'r1', expectedResponse: 'e1' },
          { request: 'r2', expectedResponse: 'e2' },
        ],
        sortOrder: 0,
        createdAt: '',
        updatedAt: '',
      },
    })

    expect(requestBoxes()).toHaveLength(2)
    expect(screen.getByDisplayValue('r1')).toBeInTheDocument()
    expect(screen.getByDisplayValue('r2')).toBeInTheDocument()
  })
})
