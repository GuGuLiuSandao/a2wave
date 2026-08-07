import { expect, it, vi } from 'vitest'
import { asyncQuery } from '../../test/async-query.js'

interface CloneTestApp {
  request(path: string, init: RequestInit): Response | Promise<Response>
}

interface CloneTestContext {
  sampleAgent: Record<string, unknown>
  createApp(auth: { userId: string; role: 'user' }): Promise<CloneTestApp>
  makeSelectChain(result: unknown): unknown
  setSelectImplementation(implementation: () => unknown): void
  setInsertResult(value: unknown): void
}

/** Register the Skill-visibility clone cases beside the route suite without
 * letting the already broad agents.test.ts file exceed the repository limit. */
export function registerSkillVisibilityCloneTests({
  sampleAgent,
  createApp,
  makeSelectChain,
  setSelectImplementation,
  setInsertResult,
}: CloneTestContext): void {
  it('flattens bindable Skills from discarded foreign groups when an editor clones an Agent', async () => {
    const editorApp = await createApp({ userId: 'usr_bob', role: 'user' })
    const source = {
      ...sampleAgent,
      userId: 'usr_alice',
      skills: ['skl_direct_shared', 'skl_direct_alice_private', 'skl_duplicate'],
      skillGroupIds: ['skg_bob', 'skg_alice'],
      mcpServerIds: [],
    }
    let selectCall = 0
    setSelectImplementation(() => {
      selectCall++
      if (selectCall === 1) return makeSelectChain(source)
      if (selectCall === 2) return makeSelectChain({ role: 'editor' })
      if (selectCall === 3) {
        // Bob's group is retained; Alice's group is discarded and expanded.
        return {
          from: () => asyncQuery({ where: () => asyncQuery({ all: () => [{ id: 'skg_bob' }] }) }),
        }
      }
      return {
        from: () =>
          asyncQuery({
            where: () =>
              asyncQuery({
                all: () => [
                  {
                    id: 'skl_direct_shared',
                    groupId: null,
                    userId: 'usr_alice',
                    visibility: 'all-users',
                  },
                  {
                    id: 'skl_direct_alice_private',
                    groupId: null,
                    userId: 'usr_alice',
                    visibility: 'private',
                  },
                  {
                    // This Skill is already a direct ref and must not be duplicated
                    // when Alice's discarded group is flattened.
                    id: 'skl_duplicate',
                    groupId: 'skg_alice',
                    userId: 'usr_alice',
                    visibility: 'all-users',
                  },
                  {
                    id: 'skl_group_shared',
                    groupId: 'skg_alice',
                    userId: 'usr_alice',
                    visibility: 'all-users',
                  },
                  {
                    id: 'skl_group_bob_private',
                    groupId: 'skg_alice',
                    userId: 'usr_bob',
                    visibility: 'private',
                  },
                  {
                    id: 'skl_group_alice_private',
                    groupId: 'skg_alice',
                    userId: 'usr_alice',
                    visibility: 'private',
                  },
                  {
                    // Members of Bob's retained group must remain group-only.
                    id: 'skl_retained_group_member',
                    groupId: 'skg_bob',
                    userId: 'usr_bob',
                    visibility: 'private',
                  },
                ],
              }),
          }),
      }
    })

    let capturedValues: Record<string, unknown> = {}
    setInsertResult({
      values: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        capturedValues = values
        return asyncQuery({
          returning: vi.fn().mockReturnValue(
            asyncQuery({
              get: vi.fn().mockReturnValue({ ...values, id: 'agt_clone_skills' }),
            }),
          ),
        })
      }),
    })

    const response = await editorApp.request('/agents/agt_original/clone', { method: 'POST' })

    expect(response.status).toBe(201)
    expect(capturedValues.skillGroupIds).toEqual(['skg_bob'])
    expect(capturedValues.skills).toEqual([
      'skl_direct_shared',
      'skl_duplicate',
      'skl_group_shared',
      'skl_group_bob_private',
    ])
  })

  it('drops an owned group with inaccessible members and flattens only bindable Skills', async () => {
    const ownerApp = await createApp({ userId: 'usr_bob', role: 'user' })
    const source = {
      ...sampleAgent,
      userId: 'usr_bob',
      skills: [],
      skillGroupIds: ['skg_bob'],
      mcpServerIds: [],
    }
    let selectCall = 0
    setSelectImplementation(() => {
      selectCall++
      if (selectCall === 1) return makeSelectChain(source)
      if (selectCall === 2) {
        return {
          from: () => asyncQuery({ where: () => asyncQuery({ all: () => [{ id: 'skg_bob' }] }) }),
        }
      }
      return {
        from: () =>
          asyncQuery({
            where: () =>
              asyncQuery({
                all: () => [
                  {
                    id: 'skl_shared',
                    groupId: 'skg_bob',
                    userId: 'usr_alice',
                    visibility: 'all-users',
                  },
                  {
                    id: 'skl_bob_private',
                    groupId: 'skg_bob',
                    userId: 'usr_bob',
                    visibility: 'private',
                  },
                  {
                    id: 'skl_alice_private',
                    groupId: 'skg_bob',
                    userId: 'usr_alice',
                    visibility: 'private',
                  },
                ],
              }),
          }),
      }
    })

    let capturedValues: Record<string, unknown> = {}
    setInsertResult({
      values: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        capturedValues = values
        return asyncQuery({
          returning: vi.fn().mockReturnValue(
            asyncQuery({
              get: vi.fn().mockReturnValue({ ...values, id: 'agt_clone_unsafe_group' }),
            }),
          ),
        })
      }),
    })

    const response = await ownerApp.request('/agents/agt_original/clone', { method: 'POST' })

    expect(response.status).toBe(201)
    expect(capturedValues.skillGroupIds).toEqual([])
    expect(capturedValues.skills).toEqual(['skl_shared', 'skl_bob_private'])
  })
}
