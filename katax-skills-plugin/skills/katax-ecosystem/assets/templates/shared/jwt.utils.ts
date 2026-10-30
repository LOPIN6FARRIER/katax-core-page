import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';

/**
 * Access/refresh JWTs (HS256).
 *
 * - Secrets are read when used, never in a module-level constant: modules are
 *   imported before .env is loaded in some bootstraps, and a constant would
 *   freeze `undefined` (or a fallback) for the life of the process.
 * - No fallback secret: a missing or short secret throws. A default string in
 *   the code lets anyone who reads the repo forge tokens.
 * - `algorithms` is pinned on verify, and the `typ` claim stops a refresh
 *   token from being accepted as an access token (and vice versa).
 */
export interface JwtPayload {
  userId: string;
  email: string;
  role: string;
}

interface TypedPayload extends JwtPayload {
  typ: 'access' | 'refresh';
}

const ALGORITHM = 'HS256' as const;
const MIN_SECRET_LENGTH = 32;

function secret(name: 'JWT_SECRET' | 'JWT_REFRESH_SECRET'): string {
  const value = process.env[name]?.trim();
  if (!value || value.length < MIN_SECRET_LENGTH) {
    throw new Error(`${name} is missing or shorter than ${MIN_SECRET_LENGTH} characters`);
  }
  return value;
}

function expiry(name: 'JWT_EXPIRES_IN' | 'JWT_REFRESH_EXPIRES_IN', fallback: string): SignOptions['expiresIn'] {
  return (process.env[name] || fallback) as SignOptions['expiresIn'];
}

export function generateAccessToken(payload: JwtPayload): string {
  return jwt.sign({ ...payload, typ: 'access' }, secret('JWT_SECRET'), {
    algorithm: ALGORITHM,
    expiresIn: expiry('JWT_EXPIRES_IN', '15m')
  });
}

export function generateRefreshToken(payload: JwtPayload): string {
  return jwt.sign({ ...payload, typ: 'refresh' }, secret('JWT_REFRESH_SECRET'), {
    algorithm: ALGORITHM,
    expiresIn: expiry('JWT_REFRESH_EXPIRES_IN', '7d')
  });
}

function verify(token: string, key: string, typ: TypedPayload['typ']): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, key, { algorithms: [ALGORITHM] }) as Partial<TypedPayload>;
    if (decoded.typ !== typ || !decoded.userId) return null;
    return { userId: decoded.userId, email: decoded.email ?? '', role: decoded.role ?? 'user' };
  } catch {
    return null;
  }
}

export function verifyAccessToken(token: string): JwtPayload | null {
  return verify(token, secret('JWT_SECRET'), 'access');
}

export function verifyRefreshToken(token: string): JwtPayload | null {
  return verify(token, secret('JWT_REFRESH_SECRET'), 'refresh');
}
