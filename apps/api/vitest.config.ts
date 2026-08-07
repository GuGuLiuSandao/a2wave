import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    // Run test files one at a time. In parallel this suite fails a handful of
    // assertions per run — a *different* handful each time (measured 8, then 4,
    // then 0; and 0/2/0 on an unmodified main, so it predates the test gate).
    // Every one of them passes when its file runs alone, so the cause is shared
    // state across files, not any single test. Serial trades ~34s for ~123s and
    // gets a deterministic gate; a gate that is red at random teaches people to
    // re-run until green, which is worse than having no gate at all.
    // Remove this once the cross-file state is isolated.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      // `src/db/migrations/**` is defensive: generated migrations live in
      // apps/api/drizzle/ today, but should any land under src/ they must not
      // enter the coverage denominator and push the ratchet below threshold.
      exclude: ['src/**/__tests__/**', 'src/db/migrations/**', 'src/test/**'],
      // Ratchet against regression: set just under measured coverage, never
      // lowered to make a red run green. Measured 2026-08: 86.28 lines /
      // 81.28 functions / 78.23 branches / 85.07 statements.
      thresholds: {
        lines: 82,
        functions: 77,
        branches: 74,
        statements: 81,
      },
    },
  },
})
