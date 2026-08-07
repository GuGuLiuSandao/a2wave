import { renderWithProviders, screen, within } from '@/test/render'
import type { Skill } from '@a2wave/shared'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SkillGroupModal } from '../skill-group-modal'

const { useCurrentUserMock, useSkillsMock } = vi.hoisted(() => ({
  useCurrentUserMock: vi.fn(),
  useSkillsMock: vi.fn(),
}))

vi.mock('antd', () => ({
  Modal: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  Select: ({ options }: { options?: Array<{ value: string; label: ReactNode }> }) => (
    <div data-testid="skill-group-member-options">
      {(options ?? []).map((option) => (
        <span key={option.value}>{option.label}</span>
      ))}
    </div>
  ),
}))

vi.mock('@/hooks/use-auth', () => ({
  useCurrentUser: () => useCurrentUserMock(),
}))

vi.mock('@/hooks/use-skills', () => ({
  useSkills: () => useSkillsMock(),
}))

vi.mock('@/hooks/use-skill-groups', () => {
  const mutationStub = () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  })
  return {
    useSkillGroupMembers: () => ({ data: undefined, isLoading: false, isFetching: false }),
    useCreateSkillGroup: () => mutationStub(),
    useUpdateSkillGroup: () => mutationStub(),
    useDeleteSkillGroup: () => mutationStub(),
  }
})

const skills = [
  {
    id: 'skl_own',
    name: 'Owned Skill',
    userId: 'usr_regular',
    visibility: 'private',
  },
  {
    id: 'skl_shared',
    name: 'Shared Skill',
    userId: 'usr_admin',
    visibility: 'all-users',
  },
] as Skill[]

describe('SkillGroupModal membership options', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSkillsMock.mockReturnValue({ data: { data: skills } })
  })

  it('offers only caller-owned Skills to a regular user', () => {
    useCurrentUserMock.mockReturnValue({ data: { id: 'usr_regular', role: 'user' } })

    renderWithProviders(<SkillGroupModal open onOpenChange={vi.fn()} group={null} />)

    const options = within(screen.getByTestId('skill-group-member-options'))
    expect(options.getByText('Owned Skill')).toBeInTheDocument()
    expect(options.queryByText('Shared Skill')).not.toBeInTheDocument()
  })

  it('offers all visible Skills to an administrator', () => {
    useCurrentUserMock.mockReturnValue({ data: { id: 'usr_admin', role: 'admin' } })

    renderWithProviders(<SkillGroupModal open onOpenChange={vi.fn()} group={null} />)

    const options = within(screen.getByTestId('skill-group-member-options'))
    expect(options.getByText('Owned Skill')).toBeInTheDocument()
    expect(options.getByText('Shared Skill')).toBeInTheDocument()
  })
})
