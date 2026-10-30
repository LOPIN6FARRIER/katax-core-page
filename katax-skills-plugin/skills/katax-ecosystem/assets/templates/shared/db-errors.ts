/**
 * PostgreSQL error codes the controllers translate into business errors.
 * The database constraint is what guarantees uniqueness / referential
 * integrity under concurrency; these helpers only pick the HTTP answer.
 *
 *   } catch (error) {
 *     if (isUniqueViolation(error, 'portfolios_slug_key')) return toSafeErrorResult(conflictError('Slug already taken'));
 *     return toSafeErrorResult(error, { context: 'portfolios.create', userId });
 *   }
 */
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';

interface PgErrorLike {
  code?: string;
  constraint?: string;
}

function pgError(error: unknown): PgErrorLike | null {
  return typeof error === 'object' && error !== null ? (error as PgErrorLike) : null;
}

/** `constraint` narrows it to one index (an email clash and a slug clash need different messages). */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = pgError(error);
  return e?.code === UNIQUE_VIOLATION && (constraint === undefined || e.constraint === constraint);
}

export function isForeignKeyViolation(error: unknown): boolean {
  return pgError(error)?.code === FOREIGN_KEY_VIOLATION;
}

export function isCheckViolation(error: unknown): boolean {
  return pgError(error)?.code === CHECK_VIOLATION;
}
