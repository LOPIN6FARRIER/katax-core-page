import { db, type SqlExecutor } from '../shared/db.js';
import type { AdvisoryLockRow, AppliedMigrationRow, CountRow } from '../types/db.types.js';

/**
 * SQL used by the migration runner (shared/migrations.ts).
 *
 * The advisory-lock functions must receive an executor bound to ONE dedicated
 * connection: session-level advisory locks belong to the connection that took
 * them. The runner passes its one dedicated connection to every function here.
 */

export async function tryAdvisoryLock(lockName: string, executor: SqlExecutor = db()): Promise<boolean> {
  const rows = await executor.query<AdvisoryLockRow[]>(
    'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
    [lockName]
  );
  return rows[0]?.locked === true;
}

export async function advisoryUnlock(lockName: string, executor: SqlExecutor = db()): Promise<void> {
  await executor.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]);
}

/** Creates the bookkeeping table when it doesn't exist (and adds columns newer runners use). */
export async function ensureMigrationsTable(executor: SqlExecutor = db()): Promise<void> {
  await executor.query(
    `CREATE TABLE IF NOT EXISTS public.schema_migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`
  );
  await executor.query('ALTER TABLE public.schema_migrations ADD COLUMN IF NOT EXISTS checksum text');
}

export async function listApplied(executor: SqlExecutor = db()): Promise<AppliedMigrationRow[]> {
  return executor.query<AppliedMigrationRow[]>('SELECT name, checksum FROM public.schema_migrations');
}

/** Tables in `public` other than the bookkeeping table: 0 means an empty database. */
export async function countUserTables(executor: SqlExecutor = db()): Promise<number> {
  const rows = await executor.query<CountRow[]>(
    `SELECT COUNT(*)::text AS count
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name <> 'schema_migrations'`
  );
  return Number(rows[0]?.count ?? 0);
}

/** Records a migration as applied without running it (baseline); an existing name is left alone. */
export async function recordMigration(name: string, checksum: string, executor: SqlExecutor = db()): Promise<void> {
  await executor.query(
    'INSERT INTO public.schema_migrations (name, checksum) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
    [name, checksum]
  );
}

/** Executes the text of one migration file (it may hold several statements). */
export async function executeMigrationSql(sql: string, executor: SqlExecutor = db()): Promise<void> {
  await executor.query(sql);
}

/** Records a migration just executed. A duplicate name fails, rolling the migration back. */
export async function insertMigration(name: string, checksum: string, executor: SqlExecutor = db()): Promise<void> {
  await executor.query('INSERT INTO public.schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
}

/** Fills the checksum of rows recorded by an older runner that didn't store one. */
export async function backfillChecksum(name: string, checksum: string, executor: SqlExecutor = db()): Promise<void> {
  await executor.query(
    'UPDATE public.schema_migrations SET checksum = $2 WHERE name = $1 AND checksum IS NULL',
    [name, checksum]
  );
}
