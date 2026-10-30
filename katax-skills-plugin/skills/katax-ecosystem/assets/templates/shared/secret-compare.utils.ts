import crypto from 'crypto';

/**
 * Constant-time comparison for secrets (API keys, socket tokens, webhook
 * secrets, OAuth client secrets). `===` returns early on the first
 * different character, which leaks how much of the secret was right.
 * Both sides are hashed first so inputs of different length compare in
 * constant time too. An empty expected value never matches.
 */
export function safeTokenEquals(given: string | undefined | null, expected: string): boolean {
  if (!expected || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

