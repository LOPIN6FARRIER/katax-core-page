import { katax } from 'katax-service-manager';
import type { IRedisDatabase } from 'katax-service-manager';
import { MemoryStore } from 'express-rate-limit';
import type { IncrementResponse, Options, Store } from 'express-rate-limit';

/**
 * express-rate-limit store backed by Redis, with an in-process fallback.
 *
 * Why Redis: counters survive `pm2 reload` (every deploy) and are shared by
 * every instance. Why its own connection (`ratelimit`): the log/dashboard
 * connection runs blocking stream reads and XADDs; every request would wait
 * behind them. Register it in index.ts:
 *
 *   await katax.database({ name: RATE_LIMIT_REDIS_NAME, type: 'redis', required: false,
 *     connection: { host: katax.env('REDIS_HOST', 'localhost'), port: katax.env('REDIS_PORT', 6379),
 *                   password: katax.env('REDIS_PASSWORD'), db: katax.env('REDIS_RATELIMIT_DB', 6) } });
 *
 * If Redis is not configured, not connected, or slower than 250 ms, the
 * limiter counts in memory instead of failing or hanging the request, and
 * says so in the log at most once a minute.
 *
 * It touches Redis only on the first request (not at construction), so the
 * limiters can be created at import time, before katax.init() has run.
 */
export const RATE_LIMIT_REDIS_NAME = 'ratelimit';
const REDIS_TIMEOUT_MS = 250;

// INCR and set the window on the first hit, atomically (never INCR then EXPIRE in two calls).
const INCREMENT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if hits == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { hits, ttl }
`;

let rawClient: { isReady?: boolean } | null | undefined;
let rawClientLoading = false;
let lastFallbackWarn = 0;

function warnFallback(err: unknown): void {
  const now = Date.now();
  if (now - lastFallbackWarn < 60_000) return;
  lastFallbackWarn = now;
  try {
    katax.logger.warn({ err, message: 'Rate limit: Redis unavailable, using in-memory counters' });
  } catch {
    // logger not ready yet
  }
}

function rateLimitRedis(): IRedisDatabase | null {
  let redis: IRedisDatabase;
  try {
    redis = katax.db(RATE_LIMIT_REDIS_NAME) as unknown as IRedisDatabase;
  } catch {
    return null; // not configured, or failed to connect at startup
  }
  // Resolve the node-redis client once to read `isReady`: while it reconnects,
  // commands would wait in the offline queue until the timeout on every request.
  if (rawClient === undefined && !rawClientLoading) {
    rawClientLoading = true;
    redis
      .getClient()
      .then((client) => (rawClient = client as { isReady?: boolean }))
      .catch(() => (rawClient = null))
      .finally(() => (rawClientLoading = false));
  }
  if (rawClient && rawClient.isReady === false) {
    warnFallback(new Error('Redis client not connected'));
    return null;
  }
  return redis;
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('rate-limit redis timeout')), REDIS_TIMEOUT_MS);
    })
  ]).finally(() => clearTimeout(timer));
}

export class RedisFallbackStore implements Store {
  readonly prefix: string;
  private windowMs = 60_000;
  private readonly memory = new MemoryStore();

  /** `name` must be unique per limiter: it namespaces the keys (`rl:<name>:<key>`). */
  constructor(name: string) {
    this.prefix = `rl:${name}:`;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
    this.memory.init(options);
  }

  async increment(key: string): Promise<IncrementResponse> {
    const redis = rateLimitRedis();
    if (redis) {
      try {
        // node-redis sendCommand only accepts strings.
        const reply = (await withTimeout(
          redis.redis('EVAL', INCREMENT_SCRIPT, '1', this.prefix + key, String(this.windowMs))
        )) as [number, number];
        return { totalHits: Number(reply[0]), resetTime: new Date(Date.now() + Number(reply[1])) };
      } catch (err) {
        warnFallback(err);
      }
    }
    return this.memory.increment(key);
  }

  async decrement(key: string): Promise<void> {
    const redis = rateLimitRedis();
    if (redis) {
      try {
        await withTimeout(redis.redis('DECR', this.prefix + key));
        return;
      } catch (err) {
        warnFallback(err);
      }
    }
    await this.memory.decrement(key);
  }

  async resetKey(key: string): Promise<void> {
    const redis = rateLimitRedis();
    if (redis) await withTimeout(redis.redis('DEL', this.prefix + key)).catch(() => undefined);
    await this.memory.resetKey(key);
  }
}
