import { api } from '@/lib/api'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

export const PROVIDER_CLIS_KEY = ['provider-clis'] as const

export type CliInstallStatus = 'idle' | 'installing' | 'uninstalling' | 'error'

/**
 * Where the installed build sits relative to the pinned version.
 *
 * The lock pins an exact version, which is a different question from the
 * `minVersion` floor the engine gates on. Without a direction, a build newer
 * than the pin rendered as outdated and the offered "update" downgraded it.
 */
export type CliLockDrift = 'match' | 'below' | 'above' | 'unknown'

export interface ProviderCliState {
  /** Lock entry identity, e.g. 'claude-code'. */
  kind: string
  /** Binary resolved through PATH, e.g. 'claude'. */
  binary: string
  /** Version pinned by the lock — what an install will produce. */
  lockedVersion: string
  installType: 'npm' | 'archive'
  installed: boolean
  installedVersion: string | null
  /** Null when nothing is installed, so "unknown" never renders as a mismatch. */
  matchesLock: boolean | null
  /** Direction of any mismatch. Null when nothing is installed. */
  lockDrift: CliLockDrift | null
  /**
   * Minimum version the engine gates on. Null when the entry declares no floor —
   * including the lock's non-Provider tools, which have no preset to read one from.
   */
  minVersion: string | null
  /**
   * Whether the installed build clears `minVersion`. Three-state on purpose:
   * `true` met, `false` unmet, `null` undecidable (not installed, no floor, or an
   * unparsable version). Without it the UI cannot tell a build that is merely
   * older than the pin from one that is genuinely too old to run.
   */
  meetsMinimum: boolean | null
  status: CliInstallStatus
  lastError: string | null
  lastOutput: string | null
}

/**
 * Install state of every managed Agent CLI.
 *
 * Polls only while a job is in flight: install runs in the background (the POST
 * returns 202) so the outcome arrives by re-reading, and a fixed interval would
 * keep spawning version probes forever once everything settled. Uninstall is
 * currently synchronous from the caller's perspective, but another session can
 * observe a row mid-`uninstalling` (e.g. the request-boundary claim in
 * cli-installer.ts), so it is polled for the same reason.
 *
 * Pass `enabled: false` on surfaces a non-admin can reach. The endpoint is
 * admin-only, and the shared query client retries twice, so an unguarded call
 * from a normal user's page would fire three 403s per visit for data that will
 * never arrive.
 */
export function useProviderClis(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: PROVIDER_CLIS_KEY,
    queryFn: () => api.get<ProviderCliState[]>('/provider-clis'),
    enabled: options?.enabled ?? true,
    refetchInterval: (query) =>
      query.state.data?.data?.some(
        (cli) => cli.status === 'installing' || cli.status === 'uninstalling',
      )
        ? 3000
        : false,
  })
}

export function useInstallProviderCli() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (kind: string) => api.post(`/provider-clis/${kind}/install`, {}),
    // Refetch immediately so the row flips to "installing" and polling starts,
    // rather than waiting for the next interval to notice.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PROVIDER_CLIS_KEY }),
  })
}

export function useUninstallProviderCli() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (kind: string) => api.post(`/provider-clis/${kind}/uninstall`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PROVIDER_CLIS_KEY }),
  })
}
