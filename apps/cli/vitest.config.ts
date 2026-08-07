import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/test/**'],
      // Ratchet against regression: set just under measured coverage, never
      // lowered to make a red run green. Measured 2026-08: 84.32 lines /
      // 86.26 functions / 76.83 branches / 82.02 statements.
      thresholds: {
        lines: 80,
        functions: 82,
        branches: 72,
        statements: 78,
      },
    },
  },
})
