import { katax } from 'katax-service-manager';
import type { PoolClient } from 'pg';
import { db } from './db.js';

/**
 * Runs a cron/background job only if no other process is running it.
 *
 * With more than one PM2 instance (or an old process still draining during a
 * reload) every instance fires the same katax.cron schedule. A session-level
 * advisory lock on a dedicated client makes the others skip that run instead
 * of doing the work twice. The lock is released when the job ends or the
 * connection drops.
 *
 *   await katax.cron({ name: 'trash-purge', schedule: '0 * * * *',
 *     task: () => runExclusive('trash-purge', () => trashService.purgeExpired()) });
 */
export async function runExclusive<T>(jobName: string, job: () => Promise<T>): Promise<T | null> {
  const client = (await db().getClient()) as PoolClient;
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [`job:${jobName}`]
    );
    if (!rows[0]?.locked) {
      katax.logger.info({ message: `[job] ${jobName} already running elsewhere, skipped` });
      return null;
    }
    const started = Date.now();
    try {
      const result = await job();
      katax.logger.info({ message: `[job] ${jobName} finished`, durationMs: Date.now() - started });
      return result;
    } catch (error) {
      // A failing job is logged, never allowed to crash the process.
      katax.logger.error({ err: error, message: `[job] ${jobName} failed` });
      return null;
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`job:${jobName}`]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}
