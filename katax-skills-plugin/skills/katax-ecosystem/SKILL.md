---
name: katax-ecosystem
description: 'The katax standard for Node.js/TypeScript APIs built with katax-core, katax-service-manager and katax-cli: layers (validator/types/repository/controller/handler/routes, services and workers), null vs undefined, SQL only in repositories, transactions and race conditions, error contract, auth and refresh-token sessions, security (secrets, JWT, uploads, CORS), Redis-backed rate limiting, bootstrap, cron jobs, plus copy-ready templates and an audit script. Use whenever writing, reviewing, refactoring, auditing or hardening any katax API code, deciding where code or types belong, or fixing an issue in one, even if the user only names a resource or a bug.'
argument-hint: 'What are you working on? (new resource / refactor / audit / auth / concurrency / security / rate limit / bootstrap / jobs)'
---

# The katax standard

How every katax API is written. It was built by reading twelve real katax APIs and keeping, for each topic, the
best implementation any of them had; everything you need is in this skill (rules here, code in `references/`,
files to copy in `assets/templates/`, the checker in `scripts/katax-audit.mjs`).

Versions this applies to: katax-core 1.6.7, katax-service-manager 0.6.1, katax-cli 1.7.1. Package details live in
the sibling skills `katax-core`, `katax-service-manager`, `katax-cli` and `katax-mcp-server`.

## Levels

- **Required**: always. The audit script or the review reports it as an error.
- **Allowed when**: a valid variant, only in the cases given.
- **Prohibited**: never in new code; migrate it when you touch old code.

When something isn't covered, ask what the rule nearest to it protects (ownership, atomicity, not leaking
internals, one place per concern) and apply that.

## The rules in one page

**Structure** (`references/api-architecture.md`)
- Required: one folder per resource with `validator`, `types`, `repository`, `controller`, `handler`, `routes`;
  sub-resources nest (`api/habits/reminders/`). Start from `katax add endpoint` and fix its known gaps (`katax-cli`
  skill).
- Required: SQL only in repositories, also from services and workers. Controllers take `(userId, input)`, return
  `ControllerResult`, never touch `req`/`res` or `db()`. Handlers are one `sendResponse` call.
- Allowed when: a `*.service.ts` separates something that is not the endpoint's own rule (external API, LLM,
  another service, orchestration shared by several controllers or workers, heavy reusable logic); workers and jobs
  for background work (`references/workers-and-cron.md`); pure `*.rules.ts` / `*.calculator.ts` with tests.
- Required: no inline types. Rows in `types/db.types.ts`, views/params/filters in `<r>.types.ts`, inputs inferred
  with `kataxInfer`.

**Validation and null** (`katax-core` skill, `references/api-architecture.md` §3)
- Required: `.describe()` on every field; `k.coerce` for query params; `.nullish()` + `validateNormalized` for
  optional input; a per-resource `<RESOURCE>_CLEARABLE` list for PATCH fields where `null` clears; `user_id` never
  in a request schema; katax-core `^1.6.7` (up to 1.6.6 an `asyncRefine` chained before `.transform()`/`.refine()`
  never runs).
- Prohibited: authorization that exists only inside a validator. Membership and role checks may run there for an
  early, clean 422/403, but the write is still scoped (owner / parent in the `WHERE`) and negative tests prove it.
- Shared schemas (`idParamsSchema`, page/limit with `limit` 1..100, `dateSchema`, slug, hostname) live in
  `shared/`, and normalisation (trim, lowercase email) runs in `k.preprocess`.

**Repositories and transactions** (`references/api-architecture.md` §6)
- Required: every repository function takes `executor: SqlExecutor = db()` last, so several run in one
  `withTransaction`; column constants, `::text` dates, `COUNT(*)::text`; dynamic `SET` from a column whitelist;
  `Row | null` for lookups; row types for every query (`CountRow`, `IdRow`); constraint errors translated by code.
- Prohibited: `BEGIN` through the pool, `SELECT *`, `any`, `query<{...}>`.

**Concurrency** (`references/concurrency.md`)
- Required: no "read, decide in JS, write" in separate queries. One-time values are claimed with
  `UPDATE ... WHERE <still valid> RETURNING` or `GETDEL`; limits go in the write's `WHERE` or under
  `lockKey(tx, key)`; counters are `col = col + 1`; uniqueness is a `UNIQUE` constraint; ownership is in the write
  (`AND user_id = $n`); child resources are looked up and written under the parent in the URL
  (`AND workspace_id = $n`), never by their own id alone; cron jobs run in `runExclusive`.

**Errors** (`references/errors.md`)
- Required: `AppError` helpers for expected failures, `toSafeErrorResult(error, { context })` in every catch,
  422 with `[{ field, message }]`, 404 for someone else's resource.
- Prohibited: `error.message` (or any driver text) in a response; deciding the status by matching message text.

**Auth and sessions** (`references/auth-and-sessions.md`)
- Required: `router.use(requireAuth)` once in `api/routes.ts` (per-router auth only when one prefix mixes JWT and
  API keys); opaque refresh tokens stored as SHA-256, rotated atomically, max sessions per user under a lock;
  refresh cookie httpOnly, `path: '/api/auth'`, right `sameSite`; `no-store` on auth responses.
- Prohibited: `express-session`, sessions in Redis, refresh tokens in clear text.

**Security** (`references/security.md`)
- Required: no default secrets; secrets read lazily, >= 32 chars; `jwt.verify` with `algorithms`, and `aud` + `typ`
  signed and verified per issuer (app, MCP) so tokens never cross even with equal secrets; `safeTokenEquals` for
  secrets; API keys stored hashed; bcrypt cost >= 12; sockets authenticated; CORS allow-list with credentials,
  open origins only without credentials.
- Required (uploads): multer `defParamCharset: "utf8"`; magic bytes checked first, against a per-route allow-list,
  never falling back to the client's type; large files streamed with a size cap and a concurrency limit, not
  buffered; generated names, `nosniff`; external copies removed when a later step fails.
- Required: MCP tools apply exactly the rules of the REST endpoint they mirror.

**Production** (`references/production-hardening.md`)
- Required: `import 'dotenv/config'` as the first line of `index.ts`; env validated at boot; rate limits in Redis
  with fallback (template store), tiers by user / IP / API key; one Redis connection per use (logs, rate limit,
  cache); `trust proxy`, `helmet()`, 1 MB body; runtime OpenAPI; PM2 fork with 1 instance unless planned.

**Tests**
- How to choose, write and prune tests: skill `test-strategy` (investigate the project's runner first, ask how
  far to go, value filters, one rule at one level). Use the project's runner; Vitest is the default for new katax
  projects, and one runner per repository (API and worker included).
- Required: unit tests for every `*.rules.ts` / `*.calculator.ts`; endpoint tests for ownership and error paths of
  new controllers, against a real PostgreSQL built by the migrations when available (mocked repository only when
  it isn't, and say so). `npx tsc --noEmit` and the test command before calling anything done.
- Required: a negative authorization test for every endpoint that checks membership or roles (outsider and
  read-only caller get 403/404). A permission check nothing tests can vanish without anyone noticing.
- Required when PostgreSQL is available (local or a throwaway container): run new or changed queries and the
  migrations once against it. Mocked repositories don't catch a misspelled column. If no database is available,
  say so in the report.

**Repository hygiene**
- Required: `eslint.config.js` and a `lint` script; keep each file's line endings (`.gitattributes`, or the
  file's current ones).
- Required: with pnpm, `minimumReleaseAgeExclude: ['katax-*']` in `pnpm-workspace.yaml` (pnpm >= 11 refuses
  versions under 24 h old, which blocks katax fixes locally and on the deploy runner). Dependency changes edit the
  lockfile minimally (a different pnpm major rewrites it) and are verified with `pnpm install --frozen-lockfile`.
**Migrations** (`references/migrations.md`)
- Required: ask the user before adding `migrations/` or the runner to any repository, every time: in a public
  repository the folder exposes the whole schema (§0). Unattended: don't add it, put the SQL in the report.
- Required: schema changes only as numbered files in `migrations/`, applied at startup by the template runner
  (`shared/migrations.ts`): it creates `schema_migrations` if missing, takes an advisory lock, runs each file in
  its own transaction, records a checksum. Call it from katax's `afterInit` hook with a migration user that owns
  the tables (`DB_MIGRATIONS_USER`, own `pg.Client`; recommended) or right after `katax.database({ name: 'main' })`
  (pool), and let a failure stop the process (`migrations.md` §3).
- Required: files after the baseline are idempotent (`IF NOT EXISTS` / `IF EXISTS` / `DO $$` guards); an applied
  file is never edited; one service owns each schema's migrations.
- Allowed when: a database created before the runner: `MIGRATIONS_BASELINE_THROUGH` records the hand-applied files
  without running them.

**Contracts**
- Required: one JSON naming convention per API (pick snake_case or camelCase and keep it), one pagination shape
  (`{ items, next_cursor }` or the project's existing one) and one realtime event shape, documented in the
  project's README or OpenAPI. When building against a contract someone gave you, list every deviation in the
  report: the front end is often built in parallel.

## Templates

`assets/templates/` holds files to copy into `src/` (list and what each replaces in `assets/templates/README.md`):
`shared/db.ts` (SqlExecutor, lockKey), `shared/db-errors.ts`, `shared/jwt.utils.ts`, `shared/secret-compare.utils.ts`,
`shared/rate-limit.store.ts` + `middleware/rate-limit.middleware.ts`, `shared/job-lock.utils.ts`,
`config/cookie.config.ts`, `middleware/no-store.middleware.ts`, `types/db.types.ts` (CountRow/IdRow and the
migration rows), `shared/migrations.ts` + `repositories/migrations.repository.ts` (migration runner),
`registry/dashboard-registry.ts`. Copy them; don't retype them from memory.

## Checking

Run `node <this skill's base directory>/scripts/katax-audit.mjs .` from the project root (rules, exceptions and the manual checklist in
`references/audit.md`). With the plugin's hooks enabled, the same checks run after every `.ts` write and before
finishing. Issues already seen in real APIs, with how to recognise and fix them, are in
`references/known-issues.md`; add new ones there.

## Where the detail lives

| Need | Read |
| --- | --- |
| Layers, layout, null table, a complete compiled resource, repository conventions | `references/api-architecture.md` |
| Races: one-time tokens, limits, counters, locks, cron | `references/concurrency.md` |
| Error contract and controller error handling | `references/errors.md` |
| Login/refresh/logout, sessions table, cookies, native clients | `references/auth-and-sessions.md` |
| Secrets, JWT, API keys, passwords, uploads, sockets, CORS | `references/security.md` |
| Bootstrap, rate limiting, Redis connections, CORS, Helmet, dashboard, PM2 | `references/production-hardening.md` |
| Workers and cron | `references/workers-and-cron.md` |
| Migrations: files, idempotent SQL, runner at startup, baseline, testing | `references/migrations.md` |
| Defining a new API or feature before building (idea, scope, features, architecture → spec) | skill `scope-interview` |
| Which tests to write (any project, any framework) | skill `test-strategy` |
| Security audit with verified findings, endpoint inventory | skill `katax-security-audit` |
| Running the audit, rules, exceptions, review checklist, report format | `references/audit.md` |
| Problems found in real APIs | `references/known-issues.md` |
| Schemas, modifiers, `toJsonSchema()` | skill `katax-core` |
| `katax.init`, databases, logger, sockets, cron API | skill `katax-service-manager` |
| Generator commands, flags and what to fix after generating | skill `katax-cli` |
| MCP server + OAuth 2.1 | skill `katax-mcp-server` |
