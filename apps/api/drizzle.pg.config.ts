import { defineConfig } from 'drizzle-kit'

/**
 * PostgreSQL migration lineage, kept separate from the SQLite one.
 *
 * The two dialects cannot share a `drizzle/` folder: the generated DDL differs
 * (jsonb vs text, timestamptz vs integer), and the existing SQLite lineage
 * carries ~97 migrations of history that a fresh PostgreSQL database must never
 * replay. A PostgreSQL deployment starts from the current schema as migration 0.
 *
 * Generate with `pnpm db:generate:pg:migration` after regenerating schema.pg.ts.
 */
export default defineConfig({
  schema: './src/db/schema.pg.ts',
  out: './drizzle-pg',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/a2wave',
  },
})
