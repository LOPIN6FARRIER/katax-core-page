import type { CookieOptions } from 'express';

/**
 * Refresh-token cookie, in one place so set and clear always use the same
 * options (a clear with different options leaves the cookie in the browser).
 *
 * - httpOnly always; secure in production.
 * - path '/api/auth': the refresh token only travels to the auth routes,
 *   not with every API request.
 * - sameSite: 'lax' when the front end and the API share a registrable
 *   domain (app.example.com + api.example.com); 'none' (+ secure) only when
 *   they live on different domains. Set COOKIE_SAME_SITE accordingly.
 */
export const REFRESH_COOKIE_NAME = 'refresh_token';

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDurationToMs(duration: string, fallbackMs = 7 * UNIT_MS.d!): number {
  const match = /^(\d+)([smhd])$/.exec(duration.trim());
  return match ? Number(match[1]) * UNIT_MS[match[2]!]! : fallbackMs;
}

function sameSite(): CookieOptions['sameSite'] {
  const value = process.env.COOKIE_SAME_SITE;
  if (value === 'none' || value === 'strict' || value === 'lax') return value;
  return 'lax';
}

export function getRefreshCookieOptions(): CookieOptions {
  const isProd = process.env.NODE_ENV === 'production';
  const site = sameSite();
  return {
    httpOnly: true,
    secure: isProd || site === 'none',
    sameSite: site,
    path: '/api/auth',
    maxAge: parseDurationToMs(process.env.JWT_REFRESH_EXPIRES_IN || '7d')
  };
}

export function getClearedRefreshCookieOptions(): CookieOptions {
  return { ...getRefreshCookieOptions(), maxAge: 0 };
}
