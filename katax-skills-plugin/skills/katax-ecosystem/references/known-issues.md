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
| D7 | Query on a column that doesn't exist reaches production | 500 on every call of one endpoint (`column w.user_id does not exist`); mocked-repository tests pass | manual | run every new or changed query once against a real PostgreSQL with the real migrations (throwaway container) before calling it done | second-brain (promote thought) |
| D8 | Legacy trigger writing on every update | a table grows by thousands of rows a day; feature logic built on that table (throttles, "last version") misbehaves | manual | list triggers (`SELECT tgname, tgrelid::regclass FROM pg_trigger WHERE NOT tgisinternal`) when auditing; drop or replace in an idempotent migration, converting the rows worth keeping | second-brain (versioning trigger, 22k rows) |
| D10 | Schema changed by hand or by non-idempotent files | servers drift; a re-run fails on `already exists`; a runner in katax's `afterInit` that expects `katax.db('main')` finds nothing (it runs before `katax.database()`) | `migration-not-idempotent` + manual | migration runner template (own connection in `afterInit`, or after the DB connects), guarded SQL, baseline for old databases (`migrations.md`) | second-brain (001-023 by hand) |
| D9 | External resource orphaned or deleted too early | file stored in another service, then the DB insert fails (orphan); or a row deleted while the external delete fails | manual | compensate: if the DB write fails after the external write, delete the external one; deletes are soft (`deleted_at`) and a worker job removes the external resource after a retention, then the row (`workers-and-cron.md`) | second-brain (files) |

## Concurrency

| ID | Issue | How it shows | Rule | Fix | Seen in |
| --- | --- | --- | --- | --- | --- |
| C1 | Refresh token usable twice | find session -> `revokeSession(id)` unconditional -> issue tokens | `unconditional-revoke` + manual | `claimSessionByHash` (`concurrency.md` §1) | habit-forge |
| C2 | Invite / limited resource over-used | `if (use_count >= max_uses)` in code, then a separate increment | `limit-checked-in-js` | condition in the `UPDATE` (`concurrency.md` §2) | second-brain |
| C3 | OAuth / email code redeemable twice | Redis `GET` then `DEL` | `single-use-get-then-del` | `GETDEL` or stateless signed codes | my-routine, second-brain, blog |
| C4 | Session limit exceeded by parallel logins | count active, revoke oldest, insert, no lock | `limit-checked-in-js` + manual | `lockKey(tx, 'sessions:' + userId)` | my-routine, second-brain, finances |
| C5 | Cron job runs once per instance | `katax.cron` without a lock | `cron-without-lock` | `runExclusive()` (`workers-and-cron.md`) | every API with cron |
| C6 | `INCR` then `EXPIRE` | two Redis calls for a counter | `incr-then-expire` | Lua script (rate-limit store template) | none so far |
| C7 | Overlapping saves of the same document from one client | autosave sends PUT n+1 before PUT n answers; with optimistic concurrency (`expectedVersion`) one of them gets 409 | manual (client) | the client serializes writes per document and sends the version from the previous answer; the API keeps answering 409 on a stale version | second-brain (notes) |

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
| S9 | Child looked up by its own id, not under the parent in the URL | `DELETE /workspaces/:wsId/invites/:inviteId` checks the caller owns the invite's workspace, not `:wsId`; an owner of A acts on B's rows by putting B's id under A | manual | scope every lookup and write by the URL parent (`WHERE id = $1 AND workspace_id = $2`); same 404 for "doesn't exist" and "not yours" | second-brain (share, invite revoke) |
| S10 | Tokens of two systems interchangeable | app and MCP (or any two token issuers) share a secret or only check the signature, so one's token is accepted by the other | manual | an `aud` claim per issuer plus `typ`, both verified with `algorithms` (`security.md` §2); warn at boot when two secrets are equal | second-brain (app vs MCP) |
| S11 | Upload filenames mangled | `Ãrbol.png` stored instead of `Árbol.png` | `multer-param-charset` | multer `defParamCharset: "utf8"` (`security.md` §6) | second-brain (all upload routes) |
| S12 | Upload type taken from the client | stores `file.mimetype` (or falls back to it when verification is missing); one route accepts anything (covers, voice) | manual | magic bytes before anything else, an allow-list per route, never fall back to the client's type (`security.md` §6) | second-brain (legacy upload proxy, voice) |
| S13 | MCP tool weaker than its REST endpoint | tool skips a permission check or accepts fields the REST route doesn't (`is_public`, free metadata) | manual | tools call the same validators and controllers as REST; review both when adding either (`katax-mcp-server`) | second-brain (file_upload) |
| S14 | Authorization lives only in validators and silently disappears | a library bug or refactor makes the validator skip a check; every request still succeeds, no test fails | manual | negative tests per endpoint (non-member / read-only caller gets 403/404); keep ownership in the write (D3) | second-brain (katax-core 1.6.6, see B9) |

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
| B8 | katax-core < 1.6.6 with `.nullish()` | MCP clients see optional fields as required | `katax-core-version` | `^1.6.7` | most APIs (`^1.6.5`, `^1.5.4`) |
| B9 | katax-core <= 1.6.6: `asyncRefine` before `.transform()`/`.refine()` never runs | async checks (membership, existence, permissions) chained before a transform are skipped; non-members can write | `katax-core-version` | `^1.6.7`; add negative tests (S14); after upgrading, expect some rejections to change status (a skipped check now fails with 422) | second-brain and every API with `asyncRefine` + `transform` |
| B10 | Large uploads held whole in RAM | `multer.memoryStorage()` with a 100+ MB limit; a few concurrent uploads exhaust memory | `upload-in-memory` | stream to the destination after the magic-byte check, size cap while streaming, concurrency guard per process and per user (`security.md` §6) | second-brain (300 MB proxy) |
| B11 | Process dies when Redis drops | node-redis client without an `'error'` listener (katax-service-manager 0.6.1) | manual | attach an `'error'` listener to every Redis connection at bootstrap (`katax-service-manager` skill, known issues) | files-api (fixed) |
| B12 | Fresh katax release refused by pnpm | `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` locally and on the deploy runner (pnpm >= 11 waits 24 h by default) | `pnpm-release-age-katax` | `minimumReleaseAgeExclude: ['katax-*']` in `pnpm-workspace.yaml`; verify with `pnpm install --frozen-lockfile` | files-api, second-brain |

## Structure

| ID | Issue | How it shows | Rule | Fix | Seen in |
| --- | --- | --- | --- | --- | --- |
| T1 | No `*.types.ts`; views declared in controllers, params in repositories | `interface XView` in a controller | `inline-types` | `<r>.types.ts` | habit-forge (5 of 6 resources) |
| T2 | Fields without `.describe()` | | `missing-describe` | describe every field | second-brain |
| T3 | `k.number()` in a query schema | every request with `?page=1` fails | `query-param-coerce` | `k.coerce.number()` | my-routine (reminders) |
| T4 | No ESLint config, mixed test runners | `npm run lint` impossible; one API on Vitest, its worker on `node:test` | `missing-eslint-config` + manual | `eslint.config.js` in every project; one runner per repository (Vitest by default) | second-brain API and worker |
| T5 | Dead code that looks load-bearing | env validation or JWT helpers never called, so readers assume a check that doesn't happen | manual | delete it, or call it from bootstrap; the audit reports it | second-brain worker |
