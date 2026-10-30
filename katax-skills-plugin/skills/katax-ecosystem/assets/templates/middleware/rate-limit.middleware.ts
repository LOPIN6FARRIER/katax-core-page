import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';
import { RedisFallbackStore } from '../shared/rate-limit.store.js';
import { verifyAccessToken } from '../shared/jwt.utils.js';

/**
 * Rate limit tiers. Mount `apiLimiter` on /api; put the stricter ones on
 * their routes (login/register/password reset, refresh, uploads).
 *
 * Keys: a signed-in user counts against their own bucket (`u:<id>`), so many
 * users behind one NAT don't share a per-IP cap; anyone else counts per IP,
 * normalised with ipKeyGenerator (an IPv6 client could otherwise rotate
 * addresses inside its own /56). API-key traffic should key by the key id.
 *
 * These limiters run before requireAuth, so the access token is verified
 * here (a cheap HMAC check, no database) and the result is cached on req.
 */
const RL_USER = Symbol('rateLimitUser');
type WithRlUser = Request & { [RL_USER]?: string | null };

function rateLimitUserId(req: Request): string | null {
  const r = req as WithRlUser;
  if (r[RL_USER] !== undefined) return r[RL_USER] ?? null;
  const header = req.headers.authorization;
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  let userId: string | null = null;
  if (token) {
    try {
      userId = verifyAccessToken(token)?.userId ?? null;
    } catch {
      userId = null; // misconfigured secret: count per IP instead of failing the request
    }
  }
  r[RL_USER] = userId;
  return userId;
}

function userOrIpKey(req: Request): string {
  const userId = rateLimitUserId(req);
  return userId ? `u:${userId}` : `ip:${ipKeyGenerator(req.ip ?? '')}`;
}

function perCaller(userLimit: number, ipLimit: number) {
  return (req: Request) => (rateLimitUserId(req) ? userLimit : ipLimit);
}

function body(message: string) {
  return { success: false, message, error: 'RATE_LIMIT_EXCEEDED' };
}

const common = { standardHeaders: true, legacyHeaders: false } as const;

/** Everything under /api: 1000 per user or 100 per IP every 15 minutes. */
export const apiLimiter = rateLimit({
  ...common,
  store: new RedisFallbackStore('api'),
  windowMs: 15 * 60 * 1000,
  limit: perCaller(1000, 100),
  keyGenerator: userOrIpKey,
  message: body('Too many requests, please try again later.')
});

/** Login, register, password reset, email codes: brute-force protection, per IP. */
export const authLimiter = rateLimit({
  ...common,
  store: new RedisFallbackStore('auth'),
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: body('Too many attempts, please try again later.')
});

/**
 * /auth/refresh has its own, looser bucket: it only works with a valid
 * httpOnly cookie and the front end calls it on every page load, so the
 * login limit would lock real users out.
 */
export const refreshLimiter = rateLimit({
  ...common,
  store: new RedisFallbackStore('refresh'),
  windowMs: 15 * 60 * 1000,
  limit: 60,
  message: body('Too many session refreshes, please try again later.')
});
