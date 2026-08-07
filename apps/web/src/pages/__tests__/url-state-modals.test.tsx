import { renderWithProviders, screen } from '@/test/render'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KbDocumentsPage } from '../kb-documents'
import { ScmSourcesPage } from '../scm-sources'
import { SkillsPage } from '../skills'

/**
 * Deep-link coverage for the single-modal pages. The form modals themselves are
 * stubbed — what is under test is that each page reads its record id out of the
 * URL, so an editor can be linked and survives a reload.
 */

const { useSkillsMock, useSkillGroupsMock, useScmSourcesMock, useKbDocumentsMock } = vi.hoisted(
  () => ({
    useSkillsMock: vi.fn(),
    useSkillGroupsMock: vi.fn(),
    useScmSourcesMock: vi.fn(),
    useKbDocumentsMock: vi.fn(),
  }),
)

vi.mock('@/hooks/use-skills', () => ({
  useSkills: useSkillsMock,
  useUploadSkill: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUploadSkillFolder: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))
vi.mock('@/hooks/use-skill-groups', () => ({ useSkillGroups: useSkillGroupsMock }))
vi.mock('@/hooks/use-scm-sources', () => ({
  useScmSources: useScmSourcesMock,
  useSyncScmSource: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))
vi.mock('@/hooks/use-kb-documents', () => ({
  useKbDocuments: useKbDocumentsMock,
  useUploadKbDocument: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

vi.mock('@/components/skill/skill-form-modal', () => ({
  SkillFormModal: ({ open, skillId }: { open: boolean; skillId?: string }) =>
    open ? <div data-testid="skill-modal">{skillId ?? 'create'}</div> : null,
}))
vi.mock('@/components/skill-group-modal', () => ({
  SkillGroupModal: ({ open, group }: { open: boolean; group?: { id: string } | null }) =>
    open ? <div data-testid="skill-group-modal">{group?.id ?? 'create'}</div> : null,
}))
vi.mock('@/components/remote-skill-install-dialog', () => ({
  RemoteSkillInstallDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="remote-install" /> : null,
}))
vi.mock('@/components/scm/scm-source-form-modal', () => ({
  ScmSourceFormModal: ({ open, sourceId }: { open: boolean; sourceId?: string }) =>
    open ? <div data-testid="source-modal">{sourceId ?? 'create'}</div> : null,
}))
vi.mock('@/components/kb/kb-document-form-modal', () => ({
  KbDocumentFormModal: ({ open, documentId }: { open: boolean; documentId?: string }) =>
    open ? <div data-testid="doc-modal">{documentId ?? 'create'}</div> : null,
}))

function renderAt(ui: React.ReactElement, path: string) {
  return renderWithProviders(ui, { routerProps: { initialEntries: [path] } })
}

describe('SkillsPage — URL state', () => {
  beforeEach(() => {
    useSkillsMock.mockReturnValue({ data: { data: [] }, isLoading: false })
    useSkillGroupsMock.mockReturnValue({
      data: { data: [{ id: 'skg_1', name: 'Group One', skillIds: [] }] },
      isLoading: false,
    })
  })

  it('opens the skill editor from a deep link', async () => {
    renderAt(<SkillsPage />, '/?skill=skl_7')
    expect(await screen.findByTestId('skill-modal')).toHaveTextContent('skl_7')
  })

  it('resolves the group object from the id in the URL', async () => {
    // The modal takes a group object, so a deep link has to look it up rather
    // than open an empty form.
    renderAt(<SkillsPage />, '/?group=skg_1')
    expect(await screen.findByTestId('skill-group-modal')).toHaveTextContent('skg_1')
  })

  it('opens the remote install dialog from a deep link', async () => {
    renderAt(<SkillsPage />, '/?install=1')
    expect(await screen.findByTestId('remote-install')).toBeInTheDocument()
  })

  it('does not fall back to create mode for a group id that no longer exists', async () => {
    // A deleted/mistyped `?group=` resolves to null, which the modal reads as
    // CREATE — so saving would silently make a new group instead of editing the
    // one the link named.
    renderAt(<SkillsPage />, '/?group=skg_gone')

    expect(await screen.findByText('分组不存在')).toBeInTheDocument()
    expect(screen.queryByTestId('skill-group-modal')).not.toBeInTheDocument()
  })

  it('waits for the group list before deciding a deep link is missing', () => {
    // Mid-load every id looks unresolvable; showing "not found" then would flash
    // an error on a link that is about to work.
    useSkillGroupsMock.mockReturnValue({ data: undefined, isLoading: true })
    renderAt(<SkillsPage />, '/?group=skg_1')

    expect(screen.queryByText('分组不存在')).not.toBeInTheDocument()
    expect(screen.queryByTestId('skill-group-modal')).not.toBeInTheDocument()
  })

  it('renders no modal for a bare path', () => {
    renderAt(<SkillsPage />, '/')
    expect(screen.queryByTestId('skill-modal')).not.toBeInTheDocument()
    expect(screen.queryByTestId('skill-group-modal')).not.toBeInTheDocument()
  })
})

describe('ScmSourcesPage — URL state', () => {
  beforeEach(() => {
    useScmSourcesMock.mockReturnValue({ data: { data: [] }, isLoading: false })
  })

  it('opens the source editor from a deep link', async () => {
    renderAt(<ScmSourcesPage />, '/?source=scm_3')
    expect(await screen.findByTestId('source-modal')).toHaveTextContent('scm_3')
  })

  it('treats ?source=new as create mode', async () => {
    renderAt(<ScmSourcesPage />, '/?source=new')
    expect(await screen.findByTestId('source-modal')).toHaveTextContent('create')
  })
})

describe('KbDocumentsPage — URL state', () => {
  beforeEach(() => {
    useKbDocumentsMock.mockReturnValue({ data: { data: [] }, isLoading: false })
  })

  it('opens the document editor from a deep link', async () => {
    renderAt(<KbDocumentsPage />, '/?doc=kbd_9')
    expect(await screen.findByTestId('doc-modal')).toHaveTextContent('kbd_9')
  })
})
