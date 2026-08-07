import { renderWithProviders, screen } from '@/test/render'
import type { Skill } from '@a2wave/shared'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteSkillUpdateDialog } from '../remote-skill-update-dialog'

const { checkMutateAsync, checkReset, updateMutateAsync, updateReset } = vi.hoisted(() => ({
  checkMutateAsync: vi.fn(),
  checkReset: vi.fn(),
  updateMutateAsync: vi.fn(),
  updateReset: vi.fn(),
}))

const skill = {
  id: 'skl_remote',
  name: 'demo-skill',
  description: 'A remote Skill',
  content: '# Demo',
  createdAt: new Date(),
  updatedAt: new Date(),
} as Skill

const check = {
  skillId: skill.id,
  source: {
    provider: 'github' as const,
    inputUrl: 'https://github.com/acme/tools',
    repository: 'acme/tools',
    repositoryUrl: 'https://github.com/acme/tools',
    requestedRef: 'main',
    revision: 'a'.repeat(40),
    path: 'skills/demo-skill',
    digest: `sha256:${'b'.repeat(64)}`,
    catalog: null,
  },
  installedRevision: 'a'.repeat(40),
  latestRevision: 'c'.repeat(40),
  latestDigest: `sha256:${'d'.repeat(64)}`,
  localDigest: `sha256:${'e'.repeat(64)}`,
  updateAvailable: true,
  sourceDirty: true,
  files: [
    {
      path: 'SKILL.md',
      localChange: 'modified' as const,
      remoteChange: 'modified' as const,
      conflict: true,
    },
  ],
  conflicts: ['SKILL.md'],
}

vi.mock('antd', () => ({
  Modal: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <dialog open>{children}</dialog> : null,
}))

vi.mock('@/hooks/use-skills', () => ({
  useCheckRemoteSkillUpdate: () => ({
    mutateAsync: checkMutateAsync,
    reset: checkReset,
    isPending: false,
    error: null,
    data: { data: check },
  }),
  useRemoteSkillUpdate: () => ({
    mutateAsync: updateMutateAsync,
    reset: updateReset,
    isPending: false,
    error: null,
  }),
}))

describe('RemoteSkillUpdateDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    checkMutateAsync.mockResolvedValue({ data: check })
    updateMutateAsync.mockResolvedValue({
      data: {
        skill,
        strategy: 'preserve_local',
        preservedLocalChanges: true,
      },
    })
  })

  it('shows three-way conflicts and preserves local files on request', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    const onUpdated = vi.fn()

    renderWithProviders(
      <RemoteSkillUpdateDialog
        open
        onOpenChange={onOpenChange}
        skill={skill}
        onUpdated={onUpdated}
      />,
    )

    expect(await screen.findByText('SKILL.md')).toBeInTheDocument()
    expect(screen.getByText('本地修改与本次更新冲突')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '保留本地版本' }))

    expect(checkMutateAsync).toHaveBeenCalledWith(skill.id)
    expect(updateMutateAsync).toHaveBeenCalledWith({
      skillId: skill.id,
      revision: check.latestRevision,
      digest: check.latestDigest,
      strategy: 'preserve_local',
    })
    expect(onUpdated).toHaveBeenCalledWith(skill)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
