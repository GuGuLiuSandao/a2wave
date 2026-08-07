/**
 * Regenerate `src/db/schema.pg.ts` from `src/db/schema.ts`.
 *
 * Run via `pnpm db:generate:pg` after any schema change. The schema-parity test
 * re-runs the same render in memory and fails if the checked-in file differs, so
 * a schema edit that forgets to regenerate is caught in review rather than at
 * runtime on the PostgreSQL backend.
 *
 * The translation itself lives in `src/db/schema-transform.ts` — inside `src/`
 * so tests can import it without crossing tsconfig's `rootDir`.
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { PG_SCHEMA_PATH, renderPgSchema } from '../src/db/schema-transform.js'

writeFileSync(PG_SCHEMA_PATH, renderPgSchema())
console.log(`Generated ${path.relative(process.cwd(), PG_SCHEMA_PATH)}`)
