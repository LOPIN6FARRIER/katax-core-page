---
name: katax-cli
description: 'katax-cli: scaffolds Express + TypeScript APIs (katax init), endpoints/CRUD/repositories (katax add endpoint, katax generate crud/repository/docs), OpenAPI docs and PM2 deploys. Use when: creating a katax project, generating a resource, knowing exactly what the generator writes and what must be completed by hand (types, repositories, null handling), deploying with katax deploy.'
argument-hint: 'What katax-cli task? (init/add endpoint/generate crud|repository|docs/deploy/fix/info)'
---

# katax-cli — Project & Endpoint Generator

**Version: 1.6.2** | `npm install -g katax-cli` | Node >= 18

All generators are **interactive** (inquirer prompts) and must run from the project root. Generated projects pin `katax-core ^1.6.5` (a fresh install resolves 1.6.6, which has the `toJsonSchema()` fixes; bump the range to `^1.6.6` in existing projects) and `katax-service-manager ^0.6.0`.

The generator gives you a starting point, not the house style. After every `init`/`add endpoint`/`generate crud`, apply "After generating" below so the result matches `katax-ecosystem` → `references/api-architecture.md`.

## Commands

| Command | Aliases | Notes |
|---|---|---|
| `katax init [name]` | | `-f/--force`, `--pm npm\|pnpm` (default pnpm), `--ignore-scripts`, `--write-npmrc` (these set prompt defaults). Installs dependencies. Name: letters, numbers, `-`, `_` |
| `katax add endpoint <name>` | | Prompts: methods, per-route rate limiter, body fields. `-m`/`-p` are accepted but **ignored**. Nested names work: `admin/users` → `/api/admin/users` |
| `katax generate crud <name>` | `g crud` | list/get/create/update(PUT/PATCH)/delete. Prompts include an optional rate limiter (installs `express-rate-limit`). `--no-auth` = default "no" for the auth prompt. Auth uses `authenticateToken` from `shared/jwt.utils.ts` (JWT projects only) |
| `katax generate repository <name>` | `g repository` | `src/api/<name>/<name>.repository.ts` (class over `katax.db(name)`): `findAll`, `findById`, `exists`, `create`, `update`, `delete` for PostgreSQL/MySQL/MongoDB |
| `katax generate docs` | `g docs` | `src/openapi.json` (OpenAPI **3.0**, schemas read from validators by static analysis) + Swagger UI at `/docs`, `/api-docs`. `-f -o -p -u` |
| `katax info` | `status`, `ls` | Versions, available updates, routes |
| `katax deploy init/update/rollback/logs/status` | | PM2 on Ubuntu (see below) |
| `katax fix docs/all/list` | | `fix docs` makes `build` copy `openapi.json` to `dist/` (needed for `/docs` in production); `docs`/`all` accept `--skip-install` |

`gen` and `g` are aliases of the `generate` group (`katax g crud users`). Global: `--no-color`, `--verbose`, `-v/--version`.

## What `katax init` creates

```
src/
├── index.ts              # katax.init() + databases/redis/socket (or dotenv + app.listen without katax-service-manager)
├── app.ts                # helmet, cors, cookie-parser, /api rate limit (200 / 15 min), 1mb body limit
├── api/routes.ts         # mounts /health and the /hello example
├── api/health/health.handler.ts
├── api/hello/            # example resource: validator, controller, handler, routes
├── config/               # cors.config.ts (ALLOWED_ORIGINS), env.validator.ts, swagger.config.ts,
│                         #   katax.instance.ts (only if you pick the "instance" katax mode)
├── database/connection.ts  # only without katax-service-manager (raw pg/mysql2/mongodb client)
├── middleware/           # error, logger, api-key
├── shared/               # api.utils.ts (sendResponse/createResponse), logger.utils.ts, stream.utils.ts,
│                         #   jwt.utils.ts + auth.utils.ts (JWT projects)
└── openapi.json          # if Swagger
ecosystem.config.cjs  .env  .env.example  .gitattributes  .gitignore  tsconfig.json  (.npmrc with --write-npmrc)
```

Known generator issues (as of 1.6.2) — fix them right after `init`:

- **JWT projects don't compile**: `init` installs `bcryptjs ^2.4.3` without `@types/bcryptjs` (its comment assumes bundled types, which only 3.x ships) → `npm i bcryptjs@^3`.
- **`validation: none` breaks** the hello endpoint (imports a validator and `api.utils.ts` that aren't generated). Always choose katax-core.
- **`.env.example` contains the real `.env`** (DB password, generated JWT secrets) and gets committed by the initial git commit. Replace values with placeholders.
- `build` is `tsc` only: run `katax fix docs` if you use Swagger in production.
- `shared/api.utils.ts`'s `sendResponse` puts `error.message` in 500 responses, and generated controllers do the same in their `catch` (`createResponse.error(..., error.message, 500)`): replace both with `toSafeErrorResult` (see the architecture reference).

## What `add endpoint` / `generate crud` create

```
src/api/<name>/<name>.validator.ts   # k.object schemas + validate* functions
src/api/<name>/<name>.controller.ts  # SAMPLE DATA + TODO comments (no database code)
src/api/<name>/<name>.handler.ts     # sendResponse(req, res, () => validateX(req.body), (data) => controller(data))
src/api/<name>/<name>.routes.ts      # Router + @route/@desc JSDoc (used by generate docs)
```

and registers the router in `src/api/routes.ts` + regenerates `src/openapi.json`.

## After generating — bring it to house style

The generator doesn't create types files, repositories wired to controllers, or null handling. For each generated resource:

1. **Validator**
   - Query schemas: change `k.number()`/`k.boolean()` to `k.coerce.number()`/`k.coerce.boolean()` (the CRUD list query's `page`/`limit` are generated as `k.number()` and reject every real request).
   - Optional fields clients may send as `null` → `.nullish()`; PATCH-clearable fields → list them in a `*_CLEARABLE` array and validate with `validateNormalized(schema, data, CLEARABLE)`.
   - Add `.describe()` to every field.
   - Export inferred types (`export type CreateXInput = NullsToUndefined<kataxInfer<typeof createXSchema>>`).
2. **Create `<name>.types.ts`**: view types (what the controller returns), repository params (`CreateXParams` with `| null`, `UpdateXParams` with optional keys), filters. Move any inline `{ ... }` type here.
3. **Add row types** to `src/types/db.types.ts` mirroring the table.
4. **Repository**: `katax generate repository <name>` gives a class with generic SQL; adapt it (explicit column list, `::text` dates, row types, only-defined-keys UPDATE) or write the function-style repository from the architecture reference. It's the **only** file with SQL.
5. **Controller**: replace the sample data with repository calls; signature `(userId, input)`; ownership check; `throw notFoundError(...)`; `catch → toSafeErrorResult`.
6. **Handler**: pass `req.user!.id` (from `requireAuth`) to the controller; combine `:id` + body with `validateWithId`.
7. **Routes**: mount private routers after `router.use(requireAuth)` in `api/routes.ts` instead of per-route `authenticateToken`.
8. Typecheck (`npx tsc --noEmit`).

## Deploy (PM2 on Ubuntu)

```bash
katax deploy init                 # prompts: app name, repo URL, branch, install path, instances, memory, env vars
katax deploy update [-b main] [--hard] [-a app]   # fetch + pull (or reset --hard), npm install, build, pm2 restart
katax deploy rollback [-c 1] [-a app]              # git reset --hard HEAD~N, rebuild, restart
katax deploy logs [-l 100] [-f] [-a app]
katax deploy status
```

- Run `update`/`rollback`/`logs` inside the deployed folder; the app name is stored in `.katax-deploy.json`.
- `deploy init` writes `.katax-deploy.json` before cloning, so the clone fails on 1.6.2 — clone manually, `npm install && npm run build`, then `pm2 start ecosystem.config.cjs` until it's fixed.
- Default is cluster mode with `max` instances. With Socket.IO (needs sticky sessions), in-memory rate limiting, or a stateful MCP session map, use **1 instance**.
- Env vars entered in `deploy init` are written into `ecosystem.config.cjs` in the deployed folder; `git pull` then sees it as modified. Prefer a `.env` on the server (`katax.init({ loadEnv: true })`).

## Dependency chain

```
katax init ─┬─ katax-core (validators)
            ├─ katax-service-manager (bootstrap: logger, databases, redis, socket)
            └─ Express + TypeScript (ESM, moduleResolution bundler, imports end in .js)

katax add endpoint / generate crud → validator, controller, handler, routes → routes.ts → openapi.json
katax generate repository          → <name>.repository.ts over katax.db()
katax deploy                       → git + npm + PM2
```
