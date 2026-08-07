import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const uploadMock = vi.fn()
const listMock = vi.fn()
const postMock = vi.fn()
const patchMock = vi.fn()
const deleteMock = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    list: (...args: unknown[]) => listMock(...args),
    upload: (...args: unknown[]) => uploadMock(...args),
    post: (...args: unknown[]) => postMock(...args),
    patch: (...args: unknown[]) => patchMock(...args),
    delete: (...args: unknown[]) => deleteMock(...args),
  },
}))

import { useSkillGroups } from '../use-skill-groups'
import {
  useCreateSkill,
  useDeleteSkill,
  useInstallRemoteSkills,
  useSkills,
  useUpdateSkill,
  useUploadSkill,
  useUploadSkillFolder,
} from '../use-skills'

function createHarness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return { queryClient, wrapper }
}

describe('Skill hooks', () => {
  beforeEach(() => {
    uploadMock.mockReset()
    uploadMock.mockResolvedValue({ data: { id: 'skl_uploaded' } })
    listMock.mockReset()
    listMock.mockResolvedValue({ data: [], meta: { page: 1, pageSize: 50, total: 0 } })
    postMock.mockReset()
    postMock.mockResolvedValue({ data: { id: 'skl_created' } })
    patchMock.mockReset()
    patchMock.mockResolvedValue({ data: { id: 'skl_updated' } })
    deleteMock.mockReset()
    deleteMock.mockResolvedValue({ data: { id: 'skl_deleted' } })
  })

  it('includes the selected visibility for a file upload', async () => {
    const { wrapper } = createHarness()
    const { result } = renderHook(() => useUploadSkill(), { wrapper })
    const file = new File(['content'], 'SKILL.md', { type: 'text/markdown' })

    await act(() => result.current.mutateAsync({ file, visibility: 'all-users' }))

    const [path, formData] = uploadMock.mock.calls[0] as [string, FormData]
    expect(path).toBe('/skills/upload')
    expect(formData.get('file')).toBe(file)
    expect(formData.get('visibility')).toBe('all-users')
  })

  it('includes private visibility for a folder upload', async () => {
    const { wrapper } = createHarness()
    const { result } = renderHook(() => useUploadSkillFolder(), { wrapper })
    const file = new File(['content'], 'SKILL.md', { type: 'text/markdown' })

    await act(() =>
      result.current.mutateAsync({
        files: [file],
        paths: ['demo/SKILL.md'],
        visibility: 'private',
      }),
    )

    const [path, formData] = uploadMock.mock.calls[0] as [string, FormData]
    expect(path).toBe('/skills/upload')
    expect(formData.getAll('files')).toEqual([file])
    expect(formData.getAll('paths')).toEqual(['demo/SKILL.md'])
    expect(formData.get('visibility')).toBe('private')
  })

  it.each([
    {
      name: 'Skills',
      queryKey: ['skills', 1, 50],
      path: '/skills?page=1&pageSize=50',
      useHook: useSkills,
    },
    {
      name: 'Skill Groups',
      queryKey: ['skill-groups', 1, 500],
      path: '/skill-groups?page=1&pageSize=500',
      useHook: useSkillGroups,
    },
  ])(
    'refreshes the $name access projection despite globally fresh cache settings',
    async ({ queryKey, path, useHook }) => {
      const { queryClient, wrapper } = createHarness()
      queryClient.setDefaultOptions({
        queries: { retry: false, gcTime: 0, staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false },
        mutations: { retry: false },
      })
      queryClient.setQueryData(queryKey, { data: [], meta: { page: 1, pageSize: 50, total: 0 } })

      const { unmount } = renderHook(() => useHook(), { wrapper })

      await waitFor(() => expect(listMock).toHaveBeenCalledWith(path))
      listMock.mockClear()

      act(() => focusManager.setFocused(false))
      act(() => focusManager.setFocused(true))

      await waitFor(() => expect(listMock).toHaveBeenCalledWith(path))
      unmount()
      act(() => focusManager.setFocused(undefined))
    },
  )

  it.each([
    {
      name: 'create',
      useHook: useCreateSkill,
      variables: { name: 'Created Skill', groupId: 'skg_1' },
    },
    {
      name: 'update',
      useHook: useUpdateSkill,
      variables: { id: 'skl_1', visibility: 'all-users' as const },
    },
    {
      name: 'delete',
      useHook: useDeleteSkill,
      variables: 'skl_1',
    },
    {
      name: 'remote install',
      useHook: useInstallRemoteSkills,
      variables: {
        url: 'https://github.com/example/repo',
        requestedRef: 'main',
        revision: 'a'.repeat(40),
        selections: [{ path: 'skill', digest: `sha256:${'b'.repeat(64)}` }],
        groupId: 'skg_1',
        visibility: 'private' as const,
      },
    },
  ])('invalidates Skill Group safety after $name', async ({ useHook, variables }) => {
    const { queryClient, wrapper } = createHarness()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useHook(), { wrapper })

    await act(async () => {
      await result.current.mutateAsync(variables as never)
    })

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['skill-groups'] })
  })
})
