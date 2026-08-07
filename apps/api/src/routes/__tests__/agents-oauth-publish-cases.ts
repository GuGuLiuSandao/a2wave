import { expect, it } from 'vitest'

interface PublishTestApp {
  request(path: string, init: RequestInit): Response | Promise<Response>
}

interface OauthPublishTestContext {
  /** A getter, not the value: the suite rebuilds `app` in its own `beforeEach`, so capturing
   *  it at registration time would pin every case to a stale, pre-`clearAllMocks` instance. */
  getApp(): PublishTestApp
  SAMPLE_AGENT: Record<string, unknown>
  mockDb: {
    select: { mockReturnValue(v: unknown): void }
    update: { mockReturnValue(v: unknown): void } & unknown
  }
  makeSelectChain(result: unknown): unknown
  captureUpdate(agent: unknown): () => Record<string, unknown>
}

/**
 * OAuth access-scope cases for `POST /agents/:id/publish`, registered beside the route suite so
 * `agents.test.ts` stays under the repository's file-length limit. Same pattern as
 * `agents-skill-visibility-clone-cases.ts`.
 *
 * The context is passed in rather than re-mocked here: these cases exercise the real publish
 * route, and duplicating that suite's mock scaffolding would let the two drift apart.
 */
export function registerOauthPublishTests(ctx: OauthPublishTestContext): void {
  const { SAMPLE_AGENT, mockDb, makeSelectChain, captureUpdate } = ctx
  const app = { request: (path: string, init: RequestInit) => ctx.getApp().request(path, init) }

  // Replaces three "OAuth publish requires Feishu credentials" cases. The OAuth channel now
  // authorizes against its own allowlist, so Feishu credentials are no longer a publish
  // precondition for it at all.
  it('persists the allowlist when publishing in specified_users mode', async () => {
    const draftAgent = { ...SAMPLE_AGENT, publishStatus: 'draft' as const, feishuConfig: null }
    mockDb.select.mockReturnValue(makeSelectChain(draftAgent))
    const getSet = captureUpdate(draftAgent)

    const res = await app.request('/agents/agt_original/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authType: 'api_key',
        ipWhitelist: [],
        description: '',
        channels: ['api', 'oauth'],
        oauthAccessMode: 'specified_users',
        oauthAllowedEmails: ['Alice@Example.com', 'bob@example.com'],
      }),
    })

    expect(res.status).toBe(200)
    expect(getSet().oauthAccessMode).toBe('specified_users')
    // Normalized to lowercase by the schema: the gate compares against the IdP's claim, so a
    // list typed in mixed case must not lock out the very person it names.
    expect(getSet().oauthAllowedEmails).toEqual(['alice@example.com', 'bob@example.com'])
  })

  /**
   * Leaving a stale list behind would silently re-restrict the Agent the moment someone
   * switched the mode back to specified_users, long after the addresses stopped being reviewed.
   */
  it('clears the allowlist when the mode is all_idaas_users', async () => {
    const existingAgent = {
      ...SAMPLE_AGENT,
      publishStatus: 'published' as const,
      oauthAccessMode: 'specified_users' as const,
      oauthAllowedEmails: ['old@example.com'],
    }
    mockDb.select.mockReturnValue(makeSelectChain(existingAgent))
    const getSet = captureUpdate(existingAgent)

    const res = await app.request('/agents/agt_original/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authType: 'api_key',
        ipWhitelist: [],
        description: '',
        channels: ['api', 'oauth'],
        oauthAccessMode: 'all_idaas_users',
      }),
    })

    expect(res.status).toBe(200)
    expect(getSet().oauthAllowedEmails).toBeNull()
  })

  it('keeps the stored allowlist when the publish body omits it', async () => {
    const existingAgent = {
      ...SAMPLE_AGENT,
      publishStatus: 'published' as const,
      oauthAccessMode: 'specified_users' as const,
      oauthAllowedEmails: ['keep@example.com'],
    }
    mockDb.select.mockReturnValue(makeSelectChain(existingAgent))
    const getSet = captureUpdate(existingAgent)

    const res = await app.request('/agents/agt_original/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authType: 'api_key',
        ipWhitelist: [],
        description: '',
        channels: ['api', 'oauth'],
      }),
    })

    expect(res.status).toBe(200)
    expect(getSet().oauthAllowedEmails).toBeUndefined()
  })

  /**
   * Server-side counterpart to the frontend readiness gate. Publishing `specified_users` with
   * nothing on the list yields a live channel that 403s every caller — and the frontend is not
   * the only way in: CLI/API clients and the Agents migration 0100 landed on an empty list
   * reach this route directly.
   */
  it('rejects publishing specified_users with an empty allowlist', async () => {
    const draftAgent = {
      ...SAMPLE_AGENT,
      publishStatus: 'draft' as const,
      oauthAllowedEmails: null,
    }
    mockDb.select.mockReturnValue(makeSelectChain(draftAgent))

    for (const body of [
      { oauthAccessMode: 'specified_users', oauthAllowedEmails: [] },
      // Omitted list + nothing stored: the migrated-Agent case.
      { oauthAccessMode: 'specified_users' },
    ]) {
      const res = await app.request('/agents/agt_original/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authType: 'api_key',
          ipWhitelist: [],
          description: '',
          channels: ['api', 'oauth'],
          ...body,
        }),
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { code?: string }).code).toBe('OAUTH_ALLOWED_EMAILS_REQUIRED')
      expect(mockDb.update).not.toHaveBeenCalled()
    }
  })

  // The guard is about the oauth *channel*. An Agent that merely carries the mode without
  // publishing the channel has nothing to misconfigure, so it must still publish.
  it('allows an empty allowlist when the oauth channel is not published', async () => {
    const draftAgent = { ...SAMPLE_AGENT, publishStatus: 'draft' as const }
    mockDb.select.mockReturnValue(makeSelectChain(draftAgent))
    captureUpdate(draftAgent)

    const res = await app.request('/agents/agt_original/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authType: 'api_key',
        ipWhitelist: [],
        description: '',
        channels: ['api'],
        oauthAccessMode: 'specified_users',
        oauthAllowedEmails: [],
      }),
    })

    expect(res.status).toBe(200)
  })

  // Reads return `oauthAllowedEmails: null` for an all_idaas_users Agent; a client that edits
  // one field of that object and POSTs it back must not get a 400 for echoing our own payload.
  it('accepts an explicit null allowlist from a round-tripped read', async () => {
    const existingAgent = {
      ...SAMPLE_AGENT,
      publishStatus: 'published' as const,
      oauthAccessMode: 'all_idaas_users' as const,
      oauthAllowedEmails: null,
    }
    mockDb.select.mockReturnValue(makeSelectChain(existingAgent))
    const getSet = captureUpdate(existingAgent)

    const res = await app.request('/agents/agt_original/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authType: 'api_key',
        ipWhitelist: [],
        description: '',
        channels: ['api', 'oauth'],
        oauthAccessMode: 'all_idaas_users',
        oauthAllowedEmails: null,
      }),
    })

    expect(res.status).toBe(200)
    expect(getSet().oauthAllowedEmails).toBeNull()
  })
}
