---
name: katax-cli
description: 'katax-cli 1.7.1: scaffolds Express + TypeScript APIs (katax init) and complete resources (katax add endpoint / gen endpoint / gen crud: validator, types, repository, controller, handler, routes, row type, migration), runtime OpenAPI 3.1 docs, and PM2 deploys (katax deploy). Use when creating a katax project, generating a resource or sub-resource, deciding which flags to pass, knowing what the generator writes and what still has to be changed to meet the katax standard, or deploying with katax deploy.'
argument-hint: 'What katax-cli task? (init / add endpoint / deploy / info)'
---

# katax-cli: project and resource generator

**Version 1.7.1** · `npm i -g katax-cli` · Node >= 18 · run every command from the project root.

The generator writes code that already follows most of the katax standard (see the `katax-ecosystem` skill).
Run it first, then apply "Gaps against the standard" below; that is faster and more consistent than writing a
resource by hand.

## `katax init [name]`

```bash
katax init my-api                 # interactive; installs dependencies
katax init my-api --pm npm --no-install
```

Options: `-f/--force`, `--pm npm|pnpm`, `--ignore-scripts`, `--write-npmrc`, `--no-install`.
Prompts: description, database (PostgreSQL or none), Redis, auth (JWT or none), WebSocket, Katax registry,
lifecycle hooks, print the endpoint map at startup, port, git, package manager, DB credentials.

Always generated: katax-core + katax-service-manager (singleton), OpenAPI 3.1 at `/docs` and `/openapi.json`, and
the shared files:

```
src/index.ts              import 'dotenv/config' first, katax.init, databases, printStartupRoutes
src/app.ts                async-errors patch, trust proxy, helmet, CORS, /api limiter, mountApiDocs, 404, errorMiddleware
src/api/routes.ts         public routes -> router.use(requireAuth) -> private routers
src/shared/               api.utils (sendResponse, createResponse, toSafeErrorResult, validateComposed),
                          errors.utils (AppError + helpers, public error contract), null.utils (validateNormalized),
                          db.ts (db(), withTransaction), pagination.utils, validation.utils (dateSchema),
                          openapi.utils (docs(), mountApiDocs), route-map/startup-routes, sanitize.utils,
                          jwt.utils + password.utils (JWT projects), async-errors, stream.utils
src/middleware/           auth (requireAuth, requireRole), error, logger, api-key
src/types/                db.types.ts, api.types.ts
.env (real values) · .env.example (placeholders only) · ecosystem.config.cjs (fork, 1 instance) · migrations/
```

## `katax add endpoint <path>`

Aliases: `katax gen endpoint`, `katax gen crud`. In a terminal it asks for what you didn't pass (operations
checklist, fields). In scripts and agents always pass `--fields` and `--no-interactive`.

```bash
katax add endpoint habits --fields "name:string, reward:text?, starts_on:date?, active:boolean?" --no-interactive
katax add endpoint habits/:habitId/reminders --fields "remind_at:string, note:text?" --no-interactive
katax add endpoint admin/categories --id number --fields "name:string" --no-interactive
katax add endpoint news --public --methods list,get --fields "title:string, body:text" --no-interactive
katax add endpoint products --fields "price:number, status:enum(draft|active)" --dry-run
```

| Option | Default | Notes |
|---|---|---|
| `--methods <list>` | `list,get,create,update,delete` | `update` is PATCH |
| `--id <type>` | `uuid` | `uuid`, `number` (coerced from the URL), `string` |
| `--fields <spec>` | asks, or `name:string` | `name:type`; `?` = optional: `.nullish()`, nullable column, listed in `*_CLEARABLE` |
| `--table <name>` | snake_case of the resource | |
| `--singular <name>` | computed | fix a wrong singular (`--singular person`) |
| `--public` | private | mounted before `requireAuth`, no `userId`, no ownership check |
| `--no-repository` | | no table/repository; controllers answer 501 until implemented |
| `--no-interactive` | | never prompt |
| `-d, --dry-run` / `-f, --force` | | preview / overwrite existing files |

Field types: `string`, `text`, `int`, `number`, `boolean`, `date` (`YYYY-MM-DD` string), `datetime`, `email`,
`uuid`, `enum(a|b)`.

Writes `src/api/<path>/<r>.{validator,types,repository,controller,handler,routes}.ts`, adds `<Singular>Row` to
`types/db.types.ts`, mounts the router in `api/routes.ts` (after `requireAuth` unless `--public`) and writes
`migrations/NNNN_create_<table>.sql`. Sub-resources use `Router({ mergeParams: true })`, validate the parent id
and check the parent belongs to the user. Missing shared files are created; existing ones are never overwritten.
Naming comes from the last segment: `habits` -> `listHabits`, `getHabit`, `HabitRow`, `habitsRouter`.

## Gaps against the standard (1.7.1)

The generated code compiles and is close to the standard, but `katax-ecosystem/scripts/katax-audit.mjs` flags
these on a fresh project. Fix them right after generating; each fix is one of the plugin's templates
(`katax-ecosystem/assets/templates/`) or a two-line change:

1. **Writes without the owner.** `updateX` / `deleteX` run `WHERE id = $1` after the controller checked
   ownership in a separate query. Add the owner to the write (`WHERE id = $1 AND user_id = $2`) and pass
   `userId` from the controller, so a delete-then-update race can't touch another user's row.
2. **Inline query generics.** `query<Array<{ count: string }>>` and `query<Array<{ id: string }>>`: use `CountRow`
   / `IdRow` (template `types/db.types.ts`).
3. **No executor parameter.** Add `executor: SqlExecutor = db()` as the last parameter of each repository
   function (template `shared/db.ts`), so controllers can run several of them in one `withTransaction`.
4. **`jwt.verify` without `algorithms`** and no minimum secret length in `shared/jwt.utils.ts`: replace it with
   the template `shared/jwt.utils.ts` (same exports).
5. **In-memory `/api` limiter** in `app.ts`: use `apiLimiter` from the template
   `middleware/rate-limit.middleware.ts` + `shared/rate-limit.store.ts`, and register the `ratelimit` Redis
   connection (optional: without Redis it falls back to memory).
6. **Auth routes are not generated** (login/register/refresh/logout): build them with the sessions pattern in
   `katax-ecosystem/references/auth-and-sessions.md` and the template `config/cookie.config.ts`.
7. Review the generated `.describe()` texts and validation rules (lengths, enums) for the real domain.

Then `npx tsc --noEmit` and run the migration.

## `katax deploy` (on the VPS, with PM2)

```bash
katax deploy init                 # clone, use the repo's ecosystem.config.cjs, offer .env from .env.example, install, build, pm2 start + save
cd ~/apps/my-api
katax deploy update [-y] [--hard] # fast-forward pull, install, build, pm2 reload --update-env
katax deploy rollback -c 2 -y     # back 2 commits, rebuild, reload
katax deploy logs -f              # pm2 logs
katax deploy status               # pm2 list
```

- Uses the lockfile's package manager (pnpm/yarn/npm), devDependencies included (TypeScript builds the app).
- `.env` is created with permissions 600; `*SECRET*` keys left as `change-me` get random values.
- New or changed files in `migrations/` are listed, never applied automatically.
- `update` refuses to merge a diverged server (use `--hard`); a failed build keeps the previous one serving.
- App name: `--app-name`, then `.katax-deploy.json`, then the PM2 app running from this folder.

## `katax info`

Aliases `status`, `ls`: project structure, dependencies and routes.

## Removed in 1.7.0

`katax generate repository`, `katax generate docs`, `katax fix docs|all|list`, the `/hello` example,
MySQL/MongoDB in `init`, the "manual" and "instance" katax modes and the static `openapi.json`. If an older guide
or project mentions them, use `add endpoint` (it generates the repository) and the runtime docs instead.
Older projects: `add endpoint` creates missing shared files, but an old `shared/api.utils.ts` must be updated by
hand (it warns when `toSafeErrorResult` / `validateComposed` are missing).
