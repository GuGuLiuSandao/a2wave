/**
 * Actionable messages for the common ways a PostgreSQL connection fails at boot.
 *
 * Deliberately **never interpolates the connection string**: unlike a SQLite file
 * path, a `postgres://` URL routinely embeds the password, and this text is
 * printed to stdout and scraped into container logs. Callers get told to check
 * DATABASE_URL, not shown its contents.
 */
function describePostgresStartupError(code: string | undefined): string | null {
  switch (code) {
    case 'ECONNREFUSED':
      return 'The PostgreSQL server refused the connection — it is not accepting connections at the host/port in DATABASE_URL. Check that the server is running and reachable from this process.'
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'Could not resolve the PostgreSQL host in DATABASE_URL. Check the hostname (and, in Docker, that the database service is on the same network).'
    case 'ETIMEDOUT':
      return 'Timed out connecting to the PostgreSQL server in DATABASE_URL. A firewall or security group is the usual cause.'
    case '28P01':
    case '28000':
      return 'PostgreSQL rejected the credentials in DATABASE_URL (authentication failed). Check the username and password.'
    case '3D000':
      return 'The database named in DATABASE_URL does not exist. Create it first (`createdb <name>`, or `CREATE DATABASE <name>;`) — a2wave creates tables, but never the database itself.'
    case '42501':
      return 'The PostgreSQL role in DATABASE_URL lacks permission on this database. It needs CREATE on the schema to run migrations.'
    case '53300':
      return "The PostgreSQL server is at its connection limit (too many clients). Raise max_connections, or lower this deployment's pool size."
    default:
      return null
  }
}

/**
 * Translate the common low-level failures of opening the database into one
 * actionable message each. Returns null for anything unrecognized so the
 * original error propagates untouched.
 *
 * `target` is the SQLite file path or, on PostgreSQL, the connection string —
 * which is why only the SQLite branch interpolates it (see above).
 */
export function describeDbStartupError(err: unknown, dbPath: string): string | null {
  if (!(err instanceof Error)) return null
  const code = (err as NodeJS.ErrnoException).code

  const postgres = describePostgresStartupError(code)
  if (postgres) return postgres

  // better-sqlite3's native addon was never built — pnpm skipped its install
  // script (user-level only-built-dependencies rc, or --ignore-scripts).
  if (err.message.includes('Could not locate the bindings file')) {
    return (
      'better-sqlite3 native addon is missing (its install script was skipped). ' +
      'Run `pnpm install` from the repo root — the project .npmrc allowlists the build. ' +
      'If it persists, check `pnpm config get only-built-dependencies` for a user-level override.'
    )
  }

  if (code === 'SQLITE_CANTOPEN') {
    return `Cannot open the SQLite database at ${dbPath}. Make sure the directory exists and is writable by this process.`
  }

  if (code === 'SQLITE_NOTADB') {
    return `The file at ${dbPath} is not a valid SQLite database (corrupt or wrong file). Restore it from a backup, or delete it to start fresh (dev only — this erases all data).`
  }

  if (code === 'EACCES' || code === 'EPERM') {
    return `Permission denied creating or opening the database at ${dbPath}. Check the ownership/permissions of the data directory.`
  }

  return null
}
