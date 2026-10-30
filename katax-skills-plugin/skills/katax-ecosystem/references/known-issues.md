# Known issues catalog

Problems found in real katax APIs, written so they can be recognised in any project. When an audit finds a new kind
of problem, add it here (and to `scripts/katax-audit.mjs` if a pattern can detect it), so it is checked everywhere
from then on.

"Rule" is the audit script rule that detects it; "manual" means it needs a human or agent review. "Seen in" is
history only: it says where the issue was first found, it is not something to go and read.

## Data and transactions

| ID | Issue | How it shows | Rule | Fix | Seen in |
| --- | --- | --- | --- | --- | --- |
| D1 | `BEGIN`/`COMMIT` sent through the pool | `this.db.query('BEGIN')` in a repository; statements may run on different connections, so nothing is atomic | `begin-on-pool` | `withTransaction()` (`api-architecture.md`) | second-brain (workspace, share, users) |
| D2 | Write by id only after a separate ownership check | `UPDATE ... WHERE id = $1` after `findById` + compare | `write-without-owner` | owner in the `WHERE` (`concurrency.md` §7) | katax-cli 1.7.1 output, most APIs |
| D3 | Ownership checked in a validator | `asyncRefine` querying the owner, then a write without `user_id` | `ownership-in-validator` | controller + owner in the write | my-routine |
| D4 | SQL in services, workers, validators, shared helpers | `db.query(...)` outside `*.repository.ts` | `sql-outside-repository` | move to a repository | files-api (services, file-access), second-brain (validators, websocket service) |
| D5 | Every query in one `db/queries.ts` | a single large data file | manual | one repository per resource | property-scout |
| D6 | `SELECT *`, `any`, inline generics | `query<any>`, `query<Array<{ count: string }>>` | `select-star`, `any-in-repository`, `inline-query-generic` | column constants, `CountRow`/`IdRow`/row types | most APIs, katax-cli 1.7.1 output |

## Concurrency

| ID | Issue | How it shows | Rule | Fix | Seen in |
| --- | --- | --- | --- | --- | --- |
| C1 | Refresh token usable twice | find session -> `revokeSession(id)` unconditional -> issue tokens | `unconditional-revoke` + manual | `claimSessionByHash` (`concurrency.md` §1) | habit-forge |
| C2 | Invite / limited resource over-used | `if (use_count >= max_uses)` in code, then a separate increment | `limit-checked-in-js` | condition in the `UPDATE` (`concurrency.md` §2) | second-brain |
| C3 | OAuth / email code redeemable twice | Redis `GET` then `DEL` | `single-use-get-then-del` | `GETDEL` or stateless signed codes | my-routine, second-brain, blog |
| C4 | Session limit exceeded by parallel logins | count active, revoke oldest, insert, no lock | `limit-checked-in-js` + manual | `lockKey(tx, 'sessions:' + userId)` | my-routine, second-brain, finances |
| C5 | Cron job runs once per instance | `katax.cron` without a lock | `cron-without-lock` | `runExclusive()` (`workers-and-cron.md`) | every API with cron |
| C6 | `INCR` then `EXPIRE` | two Redis calls for a counter | `incr-then-expire` | Lua script (rate-limit store template) | none so far |

## Security

| ID | Issue | How it shows | Rule | Fix | Seen in |
| --- | --- | --- | --- | --- | --- |
| S1 | Default JWT secret in code | `process.env.JWT_SECRET \|\| 'your-super-secret-...'` | `fallback-secret` | JWT template (`security.md` §2) | flags (live), habit-forge (dead file) |
| S2 | `jwt.verify` without `algorithms` | | `jwt-verify-algorithms` | `{ algorithms: ['HS256'] }` | katax-cli 1.7.1 output, most APIs |
| S3 | Driver errors returned to the client | `error.message` in `createResponse.error(...)`, 500 bodies | `error-message-leak` | `toSafeErrorResult` (`errors.md`) | my-routine, second-brain, emily (api.utils), files-api |
| S4 | Status decided by message text | `err.message.includes('not empty')` | `error-message-matching` | throw typed `AppError` | files-api |
| S5 | Secrets compared with `===` | API keys, socket tokens | `timing-unsafe-compare` | `safeTokenEquals` | older APIs |
| S6 | bcrypt cost 10 | | `weak-bcrypt-cost` | cost 12 (`hashPassword` default) | files-api |
| S7 | Real secrets in `.env.example` | committed DB password / JWT secrets | `real-secret-in-example` | placeholders; rotate the leaked values | projects created with katax-cli <= 1.6 |
| S8 | Controllers parsing tokens | `getBearerPayload(req.headers.authorization)` in controllers | `req-res-in-controller` | `router.use(requireAuth)` | time-to-drama |

## Bootstrap and runtime

| ID | Issue | How it shows | Rule | Fix | Seen in |
| --- | --- | --- | --- | --- | --- |
| B1 | `LOG_LEVEL` (and other env) ignored | `katax.env('LOG_LEVEL')` evaluated before `loadEnv` loads `.env` | `dotenv-first` | `import 'dotenv/config'` first (`production-hardening.md` §1) | habit-forge |
| B2 | Rate limits reset on every deploy and split per instance | `rateLimit({...})` without a store | `memory-rate-limit` | Redis store with fallback (§2) | every API except files-api and flags |
| B3 | `RedisStore` built at import time | `KataxNotInitializedError` on every request | manual | lazy construction, or the template store | flags (fixed) |
| B4 | Rate-limit checks queued behind log streams | limiter on the same Redis connection as the `XREADGROUP` bridge | manual | separate `ratelimit` connection (§3) | flags, files-api (fixed) |
| B5 | Static `openapi.json` | `src/openapi.json` | `static-openapi` | runtime docs (`docs()` + `mountApiDocs`) | dashboard, finances, emily |
| B6 | MCP sessions in memory | `Map` of transports in `mcp-session.store.ts` | manual | stateless transport (`katax-mcp-server`) | my-routine, blog |
| B7 | Hand-written MCP tool schemas / tools calling the API over HTTP | large `tool-definitions.ts` | manual | tools from validators + controllers | time-to-drama |
| B8 | katax-core < 1.6.6 with `.nullish()` | MCP clients see optional fields as required | `katax-core-version` | `^1.6.6` | most APIs (`^1.6.5`, `^1.5.4`) |

## Structure

| ID | Issue | How it shows | Rule | Fix | Seen in |
| --- | --- | --- | --- | --- | --- |
| T1 | No `*.types.ts`; views declared in controllers, params in repositories | `interface XView` in a controller | `inline-types` | `<r>.types.ts` | habit-forge (5 of 6 resources) |
| T2 | Fields without `.describe()` | | `missing-describe` | describe every field | second-brain |
| T3 | `k.number()` in a query schema | every request with `?page=1` fails | `query-param-coerce` | `k.coerce.number()` | my-routine (reminders) |
