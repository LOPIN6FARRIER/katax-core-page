# Concurrency and race conditions

Two requests for the same user or the same row can run at the same time: a double click, a retried request, two
tabs, a mobile app refreshing while the web app does too, two PM2 instances firing the same cron. The bug pattern
is always the same: **read, decide in JavaScript, then write in a separate query**. Between the read and the write
another request does the same read and makes the same decision.

The fix is one of three, in this order of preference:

1. **Put the condition inside the write** (`UPDATE ... WHERE <condition> RETURNING`): the database evaluates it
   atomically, and "no row back" means someone else got there first.
2. **Let a constraint decide** (`UNIQUE`, `CHECK`, FK) and translate the error code.
3. **Take a lock inside the transaction** (`SELECT ... FOR UPDATE` on the row, or `lockKey()` for "check, then
   insert" over several rows).

All the code below runs against the templates in `assets/templates/` (`shared/db.ts`, `shared/job-lock.utils.ts`).
Each pattern was tested against PostgreSQL with concurrent calls; the "without lock" version of the session limit
created 10 sessions for a limit of 3, the locked one kept 3.

## Contents

1. One-time values (refresh tokens, OAuth codes, invites, password-reset tokens)
2. Limits with a counter (`max_uses`, seats)
3. Counters
4. Check, then insert, per user (quota, max active sessions)
5. Editing the same row from two places
6. Uniqueness
7. Ownership in the write
8. Cron and background jobs with more than one instance
9. Rate limiting
10. Checklist for the audit

## 1. One-time values

Claim the value and use it in the same statement. Only continue if a row came back.

```ts
// sessions.repository.ts: refresh-token rotation, step 1
export async function claimSessionByHash(hash: string, executor: SqlExecutor = db()): Promise<SessionRow | null> {
  const rows = await executor.query<SessionRow[]>(
    `UPDATE user_sessions
        SET revoked_at = now(), revoked_reason = 'rotated'
      WHERE refresh_token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
      RETURNING ${SESSION_COLUMNS}`,
    [hash]
  );
  return rows[0] ?? null;
}

// auth.controller.ts
const tokens = await withTransaction(async (tx) => {
  const old = await sessionsRepository.claimSessionByHash(sha256(refreshToken), tx);
  if (!old) throw unauthorizedError('Invalid or expired refresh token'); // already used, revoked or expired
  return issueSession(old.user_id, device, tx);                            // new row in the same transaction
});
```

The broken version (found in a real API): `findActiveSessionByHash()` -> `revokeSession(id)` with
`UPDATE ... WHERE id = $1` -> issue tokens. Two refreshes with the same token both pass the find and both get a new
pair, so a stolen refresh token keeps working after the legitimate client used it.

Redis one-time codes (OAuth authorization codes, email codes): `GETDEL` returns the value and removes it in one
command.

```ts
const raw = (await redis.redis('GETDEL', `mcp:code:${code}`)) as string | null;
if (!raw) return oauthError(res, 'invalid_grant', 'Code already used or expired');
```

`GET` followed by `DEL` lets two token requests redeem the same code. For MCP OAuth prefer the stateless signed
codes in `katax-mcp-server` → `references/oauth.md`; `GETDEL` is the fix for older Redis-based stores.

## 2. Limits with a counter

```ts
// invites.repository.ts
export async function consumeInvite(code: string, executor: SqlExecutor = db()): Promise<InviteRow | null> {
  const rows = await executor.query<InviteRow[]>(
    `UPDATE workspace_invite
        SET use_count = use_count + 1
      WHERE invite_code = $1 AND is_active
        AND (expires_at IS NULL OR expires_at > now())
        AND (max_uses IS NULL OR use_count < max_uses)
      RETURNING ${INVITE_COLUMNS}`,
    [code]
  );
  return rows[0] ?? null; // null: unknown, expired or used up
}
```

Run it in the same transaction as the membership insert, so a failed insert gives the use back. The broken version
checks `invite.use_count >= invite.max_uses` in the controller and increments in a second query: N concurrent joins
all pass the check.

## 3. Counters

Always `SET col = col + 1` (or `+ $1`) in SQL. Never read the value, add in JavaScript and write it back: two
requests read 5 and both write 6.

## 4. Check, then insert, per user

When the decision depends on several rows (how many active sessions, how much storage used), there is no single
row to lock. Serialise per key with a transaction-scoped advisory lock:

```ts
import { withTransaction, lockKey } from '../../shared/db.js';

export async function issueSession(userId: string, device: DeviceInfo, tx: SqlExecutor) {
  await lockKey(tx, `sessions:${userId}`);               // released at COMMIT/ROLLBACK
  const active = await sessionsRepository.countActive(userId, tx);
  if (active >= MAX_ACTIVE_SESSIONS) await sessionsRepository.revokeOldest(userId, active - MAX_ACTIVE_SESSIONS + 1, tx);
  return sessionsRepository.insertSession(userId, device, tx);
}
```

Same for quotas: `lockKey(tx, 'quota:' + userId)`, sum the usage, insert the file row.

## 5. Editing the same row from two places

Pessimistic, when the write depends on the current state (schedule versions, balances):

```ts
await withTransaction(async (tx) => {
  const rows = await tx.query<HabitRow[]>(`SELECT ${HABIT_COLUMNS} FROM habits WHERE id = $1 AND user_id = $2 FOR UPDATE`, [id, userId]);
  if (!rows[0]) throw notFoundError('Habit');
  // ... compute from rows[0], write, all under the row lock
});
```

Optimistic, when several clients edit a document and the last one must not silently overwrite the others:

```ts
const rows = await executor.query<PortfolioRow[]>(
  `UPDATE portfolios SET title = $3, revision = revision + 1, updated_at = now()
    WHERE id = $1 AND owner_id = $2 AND revision = $4
    RETURNING ${PORTFOLIO_COLUMNS}`,
  [id, userId, input.title, input.revision]
);
if (!rows[0]) throw conflictError('This document changed since you opened it'); // 409, the client reloads
```

## 6. Uniqueness

A `UNIQUE` index is the only guarantee. An `asyncRefine` that asks "does this email exist?" gives a nicer message
for the common case, but two registrations can both pass it. Keep the check if you like the message, and always
catch the constraint:

```ts
} catch (error) {
  if (isUniqueViolation(error, 'users_email_key')) return toSafeErrorResult(conflictError('Email already registered'));
  return toSafeErrorResult(error, { context: 'auth.register' });
}
```

## 7. Ownership in the write

```sql
UPDATE habits SET ... WHERE id = $1 AND user_id = $2 RETURNING ...
DELETE FROM habits WHERE id = $1 AND user_id = $2 RETURNING id
```

No row back = not found (or not theirs) = 404. Checking the owner in a validator (`asyncRefine`) or in a separate
`find` and then writing `WHERE id = $1` leaves a window, and makes the write unsafe if someone later calls the
repository function from another path.

## 8. Cron and background jobs

Every PM2 instance runs the same `katax.cron` schedule, and during `pm2 reload` the old and new process overlap.
Wrap every job:

```ts
import { runExclusive } from '../shared/job-lock.utils.js';

await katax.cron({
  name: 'trash-purge',
  schedule: '0 * * * *',
  task: () => runExclusive('trash-purge', () => trashService.purgeExpired())
});
```

`runExclusive` takes `pg_try_advisory_lock` on a dedicated connection: the second instance logs "already running
elsewhere" and skips that run. It also logs duration and errors, so a failing job never crashes the process.
Jobs should still be idempotent (a run interrupted halfway is retried next time).

## 9. Rate limiting

Increment and expiry in one Lua script (`assets/templates/shared/rate-limit.store.ts`). `INCR` then `EXPIRE` as two
commands leaves keys without a TTL if the process dies in between, and those clients stay blocked forever.

## 10. Checklist for the audit

- [ ] Every one-time value (refresh token, OAuth code, invite, reset token, passkey challenge) is claimed with a
      conditional `UPDATE ... RETURNING` or `GETDEL`.
- [ ] Every limit (`max_uses`, seats, max sessions, quota) is in the `WHERE` of the write or under `lockKey`.
- [ ] Every counter is `col = col + 1` in SQL.
- [ ] Every `UPDATE`/`DELETE` on a user-owned table has the owner in its `WHERE`.
- [ ] Every uniqueness rule has a `UNIQUE` constraint and the controller maps 23505 to 409.
- [ ] Every multi-statement write runs in one `withTransaction`; nothing sends `BEGIN` through the pool.
- [ ] Every cron job runs inside `runExclusive`.
