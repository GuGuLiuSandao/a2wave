import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/__tests__/**', 'src/test/**', 'src/main.tsx', 'src/vite-env.d.ts'],
      // Ratchet, not an aspiration: each number sits just under the measured
      // coverage, so a drop fails the run instead of going unnoticed. Raise them
      // as tests land — never lower them to make a red run go green.
      //
      // Thresholds are a coverage-mode check, so they apply to
      // `pnpm test:coverage` — the local pre-push run — and not to the plain
      // `vitest run` that CI executes.
      // Ratchet against regression: set just under measured coverage, never
      // lowered to make a red run green. Measured 2026-08: 52.30 lines /
      // 39.58 functions / 47.15 branches / 50.90 statements.
      thresholds: {
        lines: 48,
        functions: 35,
        branches: 43,
        statements: 46,
      },
    },
  },
})
