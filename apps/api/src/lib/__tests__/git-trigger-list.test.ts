/**
 * `listOpenRequests` against real CLI failure shapes.
 *
 * These live apart from git-trigger-cli.test.ts because they need
 * `runStatusProbe` mocked. The cases matter more than the usual error-path test:
 * a poll that *silently* reports "zero open requests" is far worse than one that
 * throws, because the diff reads an empty listing as "every tracked request was
 * closed" — firing bogus Runs and deleting the fingerprints that would have
 * prevented them from re-firing as `opened` afterwards.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runStatusProbe = vi.fn()
vi.mock('../../engine/login-status-helper.js', () => ({
  runStatusProbe: (...args: unknown[]) => runStatusProbe(...args),
}))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { GitTriggerCliError, listOpenRequests } from '../git-trigger-cli.js'
import {
  GH_GRAPHQL_NOT_FOUND,
  GLAB_API_404,
  GLAB_API_UNAUTHENTICATED,
  ghGraphqlEnvelope,
} from './fixtures/git-trigger-cli-output.js'

function probeResult(overrides: Record<string, unknown> = {}) {
  return { exitCode: 0, stdout: '', stderr: '', timedOut: false, notFound: false, ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('listOpenRequests — forge error handling', () => {
  it('throws on a 404 that exits non-zero with a JSON body on stdout', async () => {
    // Captured from a real `glab api` call against a nonexistent project:
    //   exit=1, stdout={"message":"404 Project Not Found"}
    // The body parses cleanly, so without an exit-code check it flows on, fails
    // the array check, and degrades into "zero open merge requests".
    runStatusProbe.mockResolvedValue(probeResult(GLAB_API_404))

    await expect(listOpenRequests('glab', 'group/gone')).rejects.toBeInstanceOf(GitTriggerCliError)
  })

  it('classifies a non-zero exit whose stderr shows auth failure as unauthenticated', async () => {
    runStatusProbe.mockResolvedValue(probeResult(GLAB_API_UNAUTHENTICATED))

    await expect(listOpenRequests('glab', 'group/repo')).rejects.toMatchObject({
      kind: 'unauthenticated',
    })
  })

  it('throws on an error envelope that exits zero', async () => {
    // Belt-and-braces: some failures return 200 with an error body. Reporting
    // that as an empty listing has the same closed-storm consequence.
    runStatusProbe.mockResolvedValue(probeResult({ stdout: '{"message":"403 Forbidden"}' }))

    await expect(listOpenRequests('glab', 'group/repo')).rejects.toMatchObject({ kind: 'failed' })
  })

  it('throws on a GraphQL in-band error even though the call exits zero', async () => {
    // GraphQL reports NOT_FOUND with HTTP 200 and a `data.repository: null`
    // body, so a body alone is not success. Degrading it into an empty listing
    // would make the diff declare every tracked request closed.
    runStatusProbe.mockResolvedValue(probeResult({ stdout: JSON.stringify(GH_GRAPHQL_NOT_FOUND) }))

    await expect(listOpenRequests('gh', 'owner/gone')).rejects.toMatchObject({ kind: 'failed' })
  })

  it('passes a numeric repository name as a string, not an Int', async () => {
    // `gh -F` applies JSON type inference, so `-F name=2048` sends an Int and
    // GraphQL rejects it with "Could not coerce value 2048 to String".
    // `gabrielecirulli/2048` is a real repository, and the failure mode was
    // silent: first poll fails, no state row is written, the UI stays green.
    runStatusProbe.mockResolvedValue(
      probeResult({
        stdout: ghGraphqlEnvelope([]),
      }),
    )

    await listOpenRequests('gh', 'gabrielecirulli/2048')

    const args = runStatusProbe.mock.calls[0][1] as string[]
    // The string variables must use -f; only `first` may use -F.
    expect(args[args.indexOf('name=2048') - 1]).toBe('-f')
    expect(args[args.indexOf('owner=gabrielecirulli') - 1]).toBe('-f')
    expect(args[args.indexOf('first=100') - 1]).toBe('-F')
  })

  it('rejects an array whose elements are not merge requests', async () => {
    // A banner containing its own array (`note: retrying [1,2]`) parses as valid
    // JSON and passes an `Array.isArray` check, but normalises to entries with
    // no number — which the diff reads as every tracked request having closed.
    runStatusProbe.mockResolvedValue(probeResult({ stdout: 'note: retrying [1,2]' }))

    await expect(listOpenRequests('glab', 'group/repo')).rejects.toMatchObject({ kind: 'failed' })
  })

  it('rejects a GitHub project that is not owner/repo', async () => {
    await expect(listOpenRequests('gh', 'just-a-name')).rejects.toMatchObject({ kind: 'failed' })
    expect(runStatusProbe).not.toHaveBeenCalled()
  })

  it('throws rather than returning empty when the CLI is missing', async () => {
    runStatusProbe.mockResolvedValue(probeResult({ notFound: true }))

    await expect(listOpenRequests('gh', 'owner/repo')).rejects.toMatchObject({
      kind: 'not_installed',
    })
  })

  it('throws on timeout', async () => {
    runStatusProbe.mockResolvedValue(probeResult({ timedOut: true }))

    await expect(listOpenRequests('glab', 'group/repo')).rejects.toMatchObject({ kind: 'failed' })
  })
})

describe('listOpenRequests — listing completeness', () => {
  it('reports a short page as complete', async () => {
    runStatusProbe.mockResolvedValue(
      probeResult({ stdout: JSON.stringify([{ iid: 1, sha: 'a', title: 't' }]) }),
    )

    const result = await listOpenRequests('glab', 'group/repo')
    expect(result.requests).toHaveLength(1)
    expect(result.complete).toBe(true)
  })

  it('reports an empty page as complete', async () => {
    // A genuinely empty repository must still allow closed-detection, otherwise
    // closing the last open request would never be reported.
    runStatusProbe.mockResolvedValue(probeResult({ stdout: '[]' }))

    const result = await listOpenRequests('glab', 'group/repo')
    expect(result.complete).toBe(true)
  })

  it('reports a full page as possibly truncated', async () => {
    // 100 is the forges' page cap, so exactly 100 means "there may be more" —
    // and absence from a truncated page must not be read as closure.
    const full = Array.from({ length: 100 }, (_, i) => ({ iid: i + 1, sha: 'a', title: 't' }))
    runStatusProbe.mockResolvedValue(probeResult({ stdout: JSON.stringify(full) }))

    const result = await listOpenRequests('glab', 'group/repo')
    expect(result.requests).toHaveLength(100)
    expect(result.complete).toBe(false)
  })

  it('reads the GitHub GraphQL envelope', async () => {
    const nodes = [{ number: 7, headRefOid: 'abc', title: 't', headRefName: 'feat' }]
    runStatusProbe.mockResolvedValue(
      probeResult({
        stdout: ghGraphqlEnvelope(nodes),
      }),
    )

    const result = await listOpenRequests('gh', 'owner/repo')
    expect(result.requests).toEqual([
      expect.objectContaining({ number: 7, sha: 'abc', sourceBranch: 'feat' }),
    ])
    expect(result.complete).toBe(true)
  })
})
