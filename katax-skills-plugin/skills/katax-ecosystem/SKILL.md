---
name: katax-ecosystem
description: 'House style and cross-package guidance for Node.js APIs built with katax-core (validation), katax-service-manager (runtime/bootstrap) and katax-cli (scaffolding). Use when: creating or refactoring an endpoint/resource, deciding where types/SQL/business logic go, structuring validator/types/repository/controller/handler/routes, handling null vs undefined, bootstrapping, hardening for production (rate limiting, CORS, cookies, sessions), troubleshooting init order.'
argument-hint: 'What are you working on? (new resource/refactor/validation/bootstrap/hardening/troubleshooting)'
---

# Katax Ecosystem

Three TypeScript packages for Node.js APIs on self-hosted VPS infrastructure (PM2 + Ubuntu + nginx).

## Current versions (October 2026)

| Package | Version | Notes |
|---|---|---|
| `katax-core` | 1.6.6 | `toJsonSchema()` fixed (nullable/nullish/integer/strict/discriminated/recursive lazy) — needed for MCP/OpenAPI 3.1 |
| `katax-service-manager` | 0.6.1 | optional peers loaded lazily, `cron()` async, Redis RESP2 |
| `katax-cli` | 1.6.2 | generates validator/controller/handler/routes; types + repositories are completed by hand |

npm: [katax-core](https://www.npmjs.com/package/katax-core) · [katax-service-manager](https://www.npmjs.com/package/katax-service-manager) · [katax-cli](https://www.npmjs.com/package/katax-cli) — docs hub: https://www.katax.dev/

## The house style in 10 lines

Distilled from the real APIs (`api-habit-forge` and `api-my-routine` are the reference; `api-property-scout` is the older style to migrate away from):

1. One folder per resource: `<r>.validator.ts`, `<r>.types.ts`, `<r>.repository.ts`, `<r>.controller.ts`, `<r>.handler.ts`, `<r>.routes.ts` (+ `<r>.service.ts` / `<r>.calculator.ts` for external I/O or pure rules).
2. **SQL only in repositories.** Controllers call repository functions; they never import `db()`.
3. **No inline types.** Rows in `src/types/db.types.ts`; views/params/filters in `<r>.types.ts`; request inputs inferred in the validator with `kataxInfer`.
4. Repositories use `db()` from `shared/db.ts` (typed `ISqlDatabase`), explicit column lists, `::text` for dates, `withTransaction()` for multi-statement writes.
5. Controllers: `(userId, input) → ControllerResult<T>`, `throw notFoundError()` etc. for expected errors, `catch → toSafeErrorResult()` (never `error.message` to the client).
6. Handlers: one `sendResponse(req, res, validator, controller)` each; `req.user!.id` comes from `router.use(requireAuth)`.
7. Validators: `.describe()` on every field, `k.coerce` for query params, `.nullish()` + `validateNormalized` for nullable input, a `*_CLEARABLE` list for PATCH fields where `null` means "clear".
8. `undefined → null` only at the controller → repository boundary; UPDATE writes only keys `!== undefined`.
9. Ownership: load, compare `user_id`, answer 404 (not 403) for someone else's resource.
10. REST and MCP share validators and controllers (see `katax-mcp-server`).

## Where the detail lives

Load only the reference you need:

| Need | Reference |
|---|---|
| **New endpoint / refactor**: full resource example (validator, types, repository, controller, handler, routes), `db.ts`, `errors.utils.ts`, `null.utils.ts`, null-vs-undefined table, repository conventions, migration checklist | `references/api-architecture.md` |
| katax-core API: schemas, modifiers, coercion, async validation, `toJsonSchema()` | `references/katax-core.md` |
| Bootstrap, databases, Redis, logger/transports, WebSocket, cron, cache, registry/dashboard, shutdown | `references/katax-service-manager.md` |
| `katax init` / `add endpoint` / `generate crud|repository|docs` / deploy, and what to fix after generating | `references/katax-cli.md` |
| Rate limiting, CORS, Helmet, cookies, sessions, error hygiene, dashboard registry | `references/production-hardening.md` |
| Exposing the API as an MCP server (OAuth 2.1, tools from validators) | separate skill: `katax-mcp-server` |

## Common gotchas

- `await katax.init()` before `katax.db()`/`katax.ws()` (else `KataxNotInitializedError`). Use `katax.init({ loadEnv: true })` instead of `dotenv.config()`.
- `katax.db('main')` is typed `IDatabaseService` (optional `query`): go through `db()` in `shared/db.ts`.
- `.optional()` rejects `null`. Clients that send `null` for "not set" need `.nullish()`.
- Query params are strings: `k.coerce.number()`, never `k.number()`.
- `katax.cron()` is async; `katax.cronService` exists only after the first `await katax.cron()`.
- Express 4 doesn't catch rejected promises from async middleware: handlers go through `sendResponse` (which catches), or import an async-errors patch first in `app.ts`.
- Dates in `date` columns: select `col::text` and validate `YYYY-MM-DD` strings; JS `Date` shifts the day by timezone.
- Never `BEGIN` through `db().query()` (different pooled connections): use `withTransaction()`.
- PM2 cluster mode breaks Socket.IO (no sticky sessions) and splits in-memory rate limits: use 1 instance unless you've planned for it.

## New resource checklist

- [ ] Row type in `src/types/db.types.ts`
- [ ] `<r>.validator.ts`: schemas with `.describe()`, inferred input types, `validate*` via `validateNormalized`
- [ ] `<r>.types.ts`: view, `Create<R>Params`, `Update<R>Params`, filters
- [ ] `<r>.repository.ts`: column constant, typed queries, no `any`
- [ ] `<r>.controller.ts`: ownership check, `AppError` helpers, `toSafeErrorResult`
- [ ] `<r>.handler.ts` + `<r>.routes.ts` (`@route`/`@desc` JSDoc), mounted after `requireAuth`
- [ ] MCP tools (if the API has an MCP server) reusing the same validate*/controller
- [ ] `npx tsc --noEmit`
