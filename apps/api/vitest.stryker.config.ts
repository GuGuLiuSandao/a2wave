/**
 * Vitest config tailored for Stryker mutation testing.
 *
 * Differences vs vitest.config.ts:
 * - pool: 'forks' — worker_threads pool does not support process.chdir(),
 *   which a couple of our integration-style tests need (uploads,
 *   jwks-publisher). Forks pool is slightly slower but supports chdir.
 * - No coverage block — Stryker has its own per-mutant coverage analysis.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    pool: 'forks',
  },
})
