# Auditing a katax API

Two layers: the script finds what a pattern can find, the review covers what needs judgement. Run both when asked
to review, audit, migrate or harden an API, and after generating code.

## The script

`scripts/katax-audit.mjs` in this skill (Node >= 18, no dependencies). It only acts on projects whose
`package.json` depends on `katax-core` or `katax-service-manager`.

```bash
node <skill-dir>/scripts/katax-audit.mjs .                 # whole project: errors + warnings, grouped
node <skill-dir>/scripts/katax-audit.mjs src/api/habits/habits.repository.ts
node <skill-dir>/scripts/katax-audit.mjs . --errors-only
node <skill-dir>/scripts/katax-audit.mjs . --json          # for tooling
```

Exit code 1 when there are errors. The same script runs as the plugin's hooks:

- **PostToolUse** (after Write/Edit of a `.ts` file): errors block, so Claude fixes them before moving on;
  warnings are added to the context.
- **Stop** (before finishing): errors in changed `.ts` files (git diff + untracked) and `npx tsc --noEmit`. It runs
  once per stop; if Claude still stops, it was told what is wrong.

### Rules

| Rule | Level | What |
| --- | --- | --- |
| `sql-outside-repository` | error | SQL in controllers, handlers, services, workers, validators, shared helpers |
| `begin-on-pool` | error | `BEGIN` through `db().query` / `this.db.query` |
| `fallback-secret` | error | `SECRET \|\| 'value'` / `?? 'value'` |
| `jwt-verify-algorithms` | error | `jwt.verify` without `algorithms` |
| `error-message-leak` | error | `error.message` in a response |
| `cors-open-with-credentials` | error | `origin: true`/`'*'` with `credentials: true` |
| `db-in-controller` | error | `db()`, `katax.db()` or the db accessor imported in a controller/handler |
| `req-res-in-controller` | error | `req.*` / `res.*` in a controller (MCP OAuth controllers excluded) |
| `query-param-coerce` | error | `k.number()` / `k.boolean()` in a query schema |
| `single-use-get-then-del` | error | Redis `GET` + `DEL` of a code/token without `GETDEL` |
| `incr-then-expire` | error | `INCR` and `EXPIRE` as separate commands |
| `real-secret-in-example` | error | `.env.example` value that looks real |
| `unconditional-revoke` | warn | `SET revoked_at = now()` without `revoked_at IS NULL` |
| `write-without-owner` | warn | `UPDATE`/`DELETE ... WHERE id = $n` on a table with `user_id` |
| `limit-checked-in-js` | warn | `count >= max` in code before a separate write, no lock |
| `ownership-in-validator` | warn | `asyncRefine` that checks the owner |
| `cron-without-lock` | warn | `katax.cron` without `runExclusive` |
| `user-id-in-schema` | warn | `user_id`/`userId` accepted in a request schema |
| `inline-types` | warn | `interface`/`type` declared in controllers/handlers |
| `inline-query-generic` | warn | `query<{...}>` / `query<Array<{...}>>` |
| `any-in-repository`, `select-star` | warn | |
| `secret-at-module-scope`, `timing-unsafe-compare`, `weak-bcrypt-cost` | warn | |
| `error-message-matching` | warn | status decided by comparing `error.message` |
| `memory-rate-limit` | warn | `rateLimit({...})` without `store` |
| `missing-describe` | warn | validator fields without `.describe()` |
| `dotenv-first`, `katax-core-version`, `static-openapi`, `express-session` | warn | project-level |

### Exceptions

A deliberate, acceptable exception is marked where it happens, with the reason, so the next reader (and the
next audit) knows it was decided:

```ts
// katax-audit-ignore sql-outside-repository: migration runner, executes files from migrations/
await client.query(sql);
```

`// katax-audit-ignore-file <rule>: <reason>` silences one rule for a whole file. Never use an ignore to get past a
real violation; fix it.

## The review (what the script can't see)

Go resource by resource and record each finding with file, line, the catalog ID from `known-issues.md` (or a new
one) and the fix.

- [ ] Every private route is mounted after `requireAuth`; every controller scopes by `userId`; another user's
      resource answers 404.
- [ ] Every multi-statement write is in one `withTransaction`, and the transaction covers all of them.
- [ ] Every one-time value, limit and counter follows `concurrency.md`.
- [ ] Sessions: hashed opaque refresh tokens, atomic rotation, per-user limit under `lockKey`, cookie on
      `/api/auth`, `sameSite` right for the deployment (`auth-and-sessions.md`).
- [ ] Rate limits: Redis store, tiers and keys from `production-hardening.md` §2, own Redis connection.
- [ ] Uploads: size limits, magic-byte type, generated names, `nosniff` + `Content-Disposition` (`security.md` §6).
- [ ] Sockets authenticated; refuse all when the token is not configured.
- [ ] MCP (if present): stateless transport, tools from validators + controllers, identity from the token
      (`katax-mcp-server`).
- [ ] Dependencies: `katax-core ^1.6.6`, `katax-service-manager ^0.6.1`, `bcryptjs ^3`.

## Report

```
## Audit: <api name> (<date>)
Script: <n> errors, <n> warnings (by rule: ...)

### Fix now (errors and races)
| ID | File:line | Issue | Fix |

### Fix next (warnings that matter)
| ... |

### Accepted exceptions
| File:line | Rule | Reason |
```

When fixing, change one resource at a time, keep the API contract (paths, response shapes) unless asked
otherwise, run `npx tsc --noEmit` and the tests after each, and re-run the script until it reports 0 errors.
