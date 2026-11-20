import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { PoolClient } from 'pg';
import { katax } from 'katax-service-manager';
import { db, type SqlExecutor } from './db.js';
import {
  advisoryUnlock,
  backfillChecksum,
  countUserTables,
  ensureMigrationsTable,
  executeMigrationSql,
  insertMigration,
  listApplied,
  recordMigration,
  tryAdvisoryLock
} from '../repositories/migrations.repository.js';

/**
 * SQL migration runner.
 *
 * Applies the files in `migrations/` (`NNN_name.sql`) that haven't run yet, in
 * numeric order, each in its own transaction together with its row in
 * `schema_migrations` (created if it doesn't exist). A session-level Postgres
 * advisory lock makes concurrent processes (several PM2 instances, the old
 * process during a reload, a deploy script) take turns: the second waits, then
 * finds everything applied.
 *
 * Everything runs on ONE dedicated connection (the advisory lock is per
 * connection; each migration is BEGIN/COMMIT on it). Where it comes from:
 *
 * - DB_MIGRATIONS_USER set, or katax's `main` database not registered yet: its
 *   own `pg.Client` (DB_HOST/DB_PORT/DB_NAME, user DB_MIGRATIONS_USER ||
 *   DB_USER, password DB_MIGRATIONS_PASSWORD || DB_PASSWORD), closed at the
 *   end. This is what makes it usable from katax's `afterInit` hook, which
 *   runs at the end of katax.init(), before katax.database() exists, and lets
 *   migrations use the table owner while the app user only gets DML.
 * - Otherwise: a client borrowed from katax's `main` pool (call it right after
 *   katax.database({ name: 'main' }) and before the HTTP server starts).
 *
 * Existing database whose first migrations were applied by hand: set
 * MIGRATIONS_BASELINE_THROUGH=<file name>. On the first run (empty
 * `schema_migrations`) the files up to and including it are recorded as
 * applied without running; it refuses an empty database instead of guessing.
 *
 * Env: DB_HOST/DB_PORT/DB_NAME + DB_MIGRATIONS_USER/DB_MIGRATIONS_PASSWORD (own connection),
 * MIGRATIONS_DIR (default <project>/migrations), MIGRATIONS_BASELINE_THROUGH,
 * MIGRATIONS_LOCK_TIMEOUT_MS (default 120000). RUN_MIGRATIONS_ON_START is read by
 * the caller (see references/migrations.md).
 */

const MIGRATION_FILE_RE = /^(\d{3,})_[A-Za-z0-9_.-]+\.sql$/;
const LOCK_NAME = 'schema_migrations';
const LOCK_POLL_MS = 1_000;

// `migrations/` sits at the project root, next to `src/` and `dist/` (this file
// is src/shared/ or dist/shared/), so the same path works under tsx and compiled.
const DEFAULT_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

export interface MigrationReport {
  /** Recorded as applied without running (baseline of a hand-migrated database). */
  baselined: string[];
  /** Executed and recorded by this run. */
  applied: string[];
  /** Already recorded before this run. */
  alreadyApplied: number;
  /** Applied files whose content changed since they ran (edit a new migration instead). */
  changed: string[];
}

// ---------------------------------------------------------------- pure helpers

function numberOf(name: string): number {
  const match = MIGRATION_FILE_RE.exec(name);
  return match ? parseInt(match[1], 10) : Number.NaN;
}

/** Migration files only, ordered by number, then name. */
export function listMigrationNames(entries: string[]): string[] {
  return entries
    .filter((entry) => MIGRATION_FILE_RE.test(entry))
    .sort((a, b) => numberOf(a) - numberOf(b) || a.localeCompare(b));
}

/** Files numbered up to and including `through`. */
export function selectBaseline(names: string[], through: string): string[] {
  const limit = numberOf(through);
  if (Number.isNaN(limit)) throw new Error(`MIGRATIONS_BASELINE_THROUGH is not a migration file name: ${through}`);
  return names.filter((name) => numberOf(name) <= limit);
}

/** Files not recorded yet, in order. */
export function selectPending(names: string[], applied: Set<string>): string[] {
  return names.filter((name) => !applied.has(name));
}

/** Content as executed: without a BOM (Windows editors add one and Postgres rejects it), LF endings. */
export function normalizeSql(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

// ---------------------------------------------------------------- runner

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface MigrationConnection {
  exec: SqlExecutor;
  close(): Promise<void>;
}

function executorOf(client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }): SqlExecutor {
  return { query: async <R>(sql: string, params?: unknown[]) => (await client.query(sql, params)).rows as R };
}

function kataxMainAvailable(): boolean {
  try {
    db();
    return true;
  } catch {
    return false;
  }
}

/** Own pg.Client when a migration user is configured or katax has no `main` yet; else a pooled client. */
async function openConnection(): Promise<MigrationConnection> {
  const env = process.env;
  if (env.DB_MIGRATIONS_USER || !kataxMainAvailable()) {
    const host = env.DB_HOST;
    const database = env.DB_NAME;
    const user = env.DB_MIGRATIONS_USER || env.DB_USER;
    if (!host || !database || !user) {
      throw new Error('Migrations: DB_HOST, DB_NAME and DB_MIGRATIONS_USER or DB_USER are required');
    }
    const client = new pg.Client({
      host,
      port: Number(env.DB_PORT) || 5432,
      database,
      user,
      password: env.DB_MIGRATIONS_USER ? env.DB_MIGRATIONS_PASSWORD : env.DB_PASSWORD
    });
    await client.connect();
    return { exec: executorOf(client), close: () => client.end() };
  }
  const client = (await db().getClient()) as PoolClient;
  return {
    exec: executorOf(client),
    close: async () => {
      client.release();
    }
  };
}

async function inTransaction(conn: SqlExecutor, fn: () => Promise<void>): Promise<void> {
  await conn.query('BEGIN');
  try {
    await fn();
    await conn.query('COMMIT');
  } catch (error) {
    await conn.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function acquireLock(lockConn: SqlExecutor, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let logged = false;
  for (;;) {
    if (await tryAdvisoryLock(LOCK_NAME, lockConn)) return;
    if (!logged) {
      katax.logger.info({ message: 'Migrations: another process is migrating, waiting' });
      logged = true;
    }
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for the migration lock`);
    await sleep(LOCK_POLL_MS);
  }
}

async function readMigration(dir: string, name: string): Promise<{ sql: string; checksum: string }> {
  const sql = normalizeSql(await readFile(path.join(dir, name), 'utf8'));
  return { sql, checksum: checksumOf(sql) };
}

async function baseline(conn: SqlExecutor, dir: string, names: string[], through: string): Promise<string[]> {
  if ((await countUserTables(conn)) === 0) {
    throw new Error(
      `MIGRATIONS_BASELINE_THROUGH=${through} but the database is empty: create the schema the old way first, ` +
        'or unset the variable to run every migration from the start.'
    );
  }
  const toRecord = selectBaseline(names, through);
  const files = await Promise.all(toRecord.map(async (name) => ({ name, ...(await readMigration(dir, name)) })));
  await inTransaction(conn, async () => {
    for (const file of files) await recordMigration(file.name, file.checksum, conn);
  });
  return toRecord;
}

async function applyOne(conn: SqlExecutor, name: string, sql: string, checksum: string): Promise<void> {
  try {
    await inTransaction(conn, async () => {
      if (sql.trim().length > 0) await executeMigrationSql(sql, conn);
      await insertMigration(name, checksum, conn);
    });
  } catch (error) {
    katax.logger.error({ err: error, message: 'Migration failed and was rolled back', migration: name });
    throw new Error(`Migration ${name} failed (rolled back)`, { cause: error });
  }
}

export async function runMigrations(dir: string = process.env.MIGRATIONS_DIR || DEFAULT_DIR): Promise<MigrationReport> {
  const names = listMigrationNames(await readdir(dir));
  const baselineThrough = process.env.MIGRATIONS_BASELINE_THROUGH?.trim() || null;
  const lockTimeoutMs = Number(process.env.MIGRATIONS_LOCK_TIMEOUT_MS) || 120_000;
  const report: MigrationReport = { baselined: [], applied: [], alreadyApplied: 0, changed: [] };

  const connection = await openConnection();
  const conn = connection.exec;
  try {
    await acquireLock(conn, lockTimeoutMs);
    try {
      await ensureMigrationsTable(conn);
      let applied = await listApplied(conn);

      if (applied.length === 0 && baselineThrough) {
        report.baselined = await baseline(conn, dir, names, baselineThrough);
        katax.logger.info({
          message: 'Migrations: existing database, hand-applied migrations recorded without running',
          through: baselineThrough,
          count: report.baselined.length
        });
        applied = await listApplied(conn);
      }

      report.alreadyApplied = applied.length;
      const recorded = new Map(applied.map((row) => [row.name, row.checksum]));

      // Applied files must not change: a new migration is the only way to alter the schema.
      for (const [name, stored] of recorded) {
        if (!names.includes(name)) continue;
        const { checksum } = await readMigration(dir, name);
        if (stored === null) await backfillChecksum(name, checksum, conn);
        else if (stored !== checksum) report.changed.push(name);
      }
      if (report.changed.length > 0) {
        katax.logger.warn({
          message: 'Migrations: applied files were edited; their changes did NOT run. Write a new migration instead.',
          files: report.changed
        });
      }

      for (const name of selectPending(names, new Set(recorded.keys()))) {
        const { sql, checksum } = await readMigration(dir, name);
        await applyOne(conn, name, sql, checksum);
        report.applied.push(name);
        katax.logger.info({ message: 'Migration applied', migration: name });
      }

      if (report.applied.length === 0) katax.logger.info({ message: 'Migrations: database is up to date' });
      return report;
    } finally {
      await advisoryUnlock(LOCK_NAME, conn).catch(() => undefined);
    }
  } finally {
    await connection.close().catch(() => undefined);
  }
}
