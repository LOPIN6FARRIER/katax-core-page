# API Architecture — house style for katax-based APIs

The structure every katax API converged on (`api-habit-forge` and `api-my-routine` are the reference implementations; `api-second-brain` follows it with class-based repositories; `api-property-scout` is the older style to **migrate away from**). Use this for every new endpoint and when refactoring old ones.

## The rules

1. **One folder per resource** under `src/api/<resource>/` (nested resources nest: `api/user/reminders/`).
2. **No SQL outside `*.repository.ts`.** Controllers never import `db()` or write SQL strings.
3. **No inline types.** Every interface/type lives in a types file:
   - `src/types/db.types.ts` — table row types, mirroring the SQL schema 1:1.
   - `src/api/<resource>/<resource>.types.ts` — views (what the API returns), repository params, filters, results, constants tied to those types.
   - `src/types/api.types.ts` — cross-resource helpers (`WithId<T>`).
   - Request input types are **inferred** in the validator (`export type X = kataxInfer<typeof xSchema>`) — never hand-written twice.
   - Not allowed: `data: { name: string; ... }` parameters, `type Foo = ...` inside handlers/controllers, `Array<{...}>` generics on `db().query<...>()`.
4. **No `any`** in repositories: every `db().query<T>()` uses a row type or a `Pick`/composite of one.
5. **Controllers** take `(userId, validatedInput)`, return `ControllerResult<T>`, never touch `req`/`res`, throw `AppError` helpers for expected failures, and end with `catch (error) { return toSafeErrorResult(error, { context, ... }) }`.
6. **Handlers** are one `sendResponse(req, res, validator, controller)` call each.
7. **Auth once**: `router.use(requireAuth)` in `api/routes.ts` sets `req.user`; controllers never parse tokens.
8. **Errors never leak**: raw DB/driver messages are logged and replaced with a generic message (`toSafeErrorResult`, `errorMiddleware`).
9. **Pure logic in its own file**: `*.service.ts` (external I/O or business rules), `*.calculator.ts` / `*.rules.ts` (pure functions, unit-tested with `*.test.ts`).

## File layout

```
src/
├── index.ts                     # bootstrap (katax.init, databases, socket, dashboard)
├── app.ts                       # express app, middleware, limiters, CORS
├── api/
│   ├── routes.ts                # public routes, then router.use(requireAuth), then private routes
│   ├── health/health.handler.ts
│   └── habits/
│       ├── habits.validator.ts  # katax-core schemas + inferred input types + validate* fns
│       ├── habits.types.ts      # views, repository params, filters
│       ├── habits.repository.ts # the only place with SQL
│       ├── habits.controller.ts # business logic -> ControllerResult
│       ├── habits.handler.ts    # sendResponse(req, res, validator, controller)
│       ├── habits.routes.ts     # express Router + @route/@desc docs
│       └── habits.service.ts    # optional: external API / pure rules
├── types/
│   ├── db.types.ts              # row types
│   └── api.types.ts             # WithId<T> and other shared helpers
├── shared/
│   ├── api.utils.ts             # ControllerResult, createResponse, sendResponse, toSafeErrorResult
│   ├── db.ts                    # db() + withTransaction()
│   ├── errors.utils.ts          # AppError + notFoundError/conflictError/...
│   ├── null.utils.ts            # NullsToUndefined + validateNormalized
│   ├── validation.utils.ts      # validateWithId
│   └── pagination.utils.ts      # pageQuerySchema, buildPaginationMeta
├── middleware/                  # auth, error, logger, api-key
└── mcp/                         # optional, see the katax-mcp-server skill
```

`katax-cli` generates validator/controller/handler/routes (+ repository on demand) but **not** `*.types.ts`, `db.ts`, `errors.utils.ts`, `null.utils.ts` or `validation.utils.ts`: add them by hand following this file (see "After generating" in the `katax-cli` skill).

## null vs undefined — the decision table

`undefined` (key missing) and `null` (explicit "empty") are different things. katax-core keeps them apart: `.optional()` rejects `null`.

| Situation | Schema | What reaches the controller |
|---|---|---|
| Required field | `k.string()` | always a value |
| Optional field on create (REST only, client omits it) | `.optional()` | `T \| undefined` |
| Optional field a client may send as `null` (MCP clients, forms) | `.nullish()` + `validateNormalized` | `T \| undefined` (nulls dropped) |
| PATCH field that can be **cleared** | `.nullish()` + listed in `keep` (`HABIT_CLEARABLE`) | `undefined` = don't touch, `null` = clear, value = set |
| Query param | `k.coerce.number()/boolean().optional()` | coerced value or `undefined` (query strings are never `null`) |
| Server default | no schema default; apply with `??` in the controller | — |
| Response / DB row nullable column | type `T \| null` (never `?:`) | — |

Rules of thumb:
- Prefer `.nullish()` over `.nullable().optional()` (same thing, one call). Requires katax-core ≥ 1.6.6 for correct `toJsonSchema()`/MCP output (on ≤ 1.6.5 `.nullish()` fields came out as `required`).
- Convert `undefined -> null` **only** at the controller -> repository boundary (`input.reward ?? null`).
- An UPDATE repository writes only keys that are `!== undefined`; never spread a validated object straight into SQL params (missing keys would become NULL).

```ts
// shared/null.utils.ts
import type { Schema } from 'katax-core';
import { validateSchema } from './api.utils.js';
import type { ValidationResult } from './api.utils.js';

/**
 * `null` handling for request input.
 *
 * Clients (MCP clients like Claude especially) often send `null` for an
 * optional field they don't want to set. Validators accept it with
 * `.nullish()`, and this module turns those nulls into `undefined`
 * ("not provided") before the data reaches a controller.
 *
 * The keys passed as `keep` are the exceptions: there `null` is a real value
 * ("remove the reward", "no due date") and must reach the repository as NULL.
 */
export type NullsToUndefined<T, Keep extends string = never> = T extends readonly (infer U)[]
  ? NullsToUndefined<U, Keep>[]
  : T extends Date
    ? T
    : T extends object
      ? { [K in keyof T]: K extends Keep ? T[K] : NullsToUndefined<T[K], Keep> }
      : T extends null
        ? undefined
        : T;

export function dropNulls<T, Keep extends string = never>(
  value: T,
  keep: ReadonlySet<string> = new Set()
): NullsToUndefined<T, Keep> {
  if (Array.isArray(value)) {
    return value.map((item) => dropNulls(item, keep)) as NullsToUndefined<T, Keep>;
  }
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === null && !keep.has(key)) continue;
      out[key] = dropNulls(item, keep);
    }
    return out as NullsToUndefined<T, Keep>;
  }
  return value as NullsToUndefined<T, Keep>;
}

/** validateSchema + null normalisation. Use it in every validate* helper. */
export async function validateNormalized<T, Keep extends string = never>(
  schema: Schema<T>,
  data: unknown,
  keep: readonly Keep[] = []
): Promise<ValidationResult<NullsToUndefined<T, Keep>>> {
  const result = await validateSchema(schema, data);
  if (!result.isValid || result.data === undefined) {
    return { isValid: false, errors: result.errors };
  }
  return { isValid: true, data: dropNulls<T, Keep>(result.data, new Set<string>(keep)) };
}
```

## A complete resource

Verified to compile with `strict` + `noUncheckedIndexedAccess` (katax-core 1.6.x, katax-service-manager 0.6.1, Express 4).

### `types/db.types.ts`

```ts
/**
 * Row types mirroring the SQL schema exactly (table + column names).
 * Every db().query<T>() in every repository uses one of these (or a
 * Pick/composite of them) - never `any` or an inline object type.
 * Nullable columns are `T | null`, never optional (`?`).
 */
export interface HabitRow {
  id: string;
  user_id: string;
  name: string;
  tiny_action: string | null;
  reward: string | null;
  push_enabled: boolean;
  active: boolean;
  /** YYYY-MM-DD, selected with ::text so pg doesn't shift it to the server timezone. */
  start_date: string;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}
```

### `habits.validator.ts`

```ts
import { k, kataxInfer } from 'katax-core';
import type { ValidationResult } from '../../shared/api.utils.js';
import { validateNormalized } from '../../shared/null.utils.js';
import type { NullsToUndefined } from '../../shared/null.utils.js';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** Reusable field schema: describe() once, reuse everywhere (REST, OpenAPI and MCP share it). */
export const dateSchema = k.string().regex(DATE_REGEX, 'Date must be YYYY-MM-DD').describe('Calendar date as YYYY-MM-DD.');

/** Fields where `null` means "clear it" in an update (all other nulls mean "not provided"). */
export const HABIT_CLEARABLE = ['tiny_action', 'reward'] as const;
type HabitClearable = (typeof HABIT_CLEARABLE)[number];

// ==================== SCHEMAS ====================

export const habitIdParamSchema = k.object({
  id: k.string().uuid('Invalid habit id').describe('Habit UUID.')
});

export const listHabitsQuerySchema = k.object({
  // Query strings are always strings: coerce numbers/booleans.
  active: k.coerce.boolean().optional().describe('true (default) = active habits, false = archived.'),
  page: k.coerce.number().integer().min(1).optional().describe('1-based page number.')
});

export const createHabitSchema = k.object({
  name: k.string().minLength(1, 'Name is required').maxLength(120).describe('Habit name.'),
  tiny_action: k.string().minLength(1).nullish().describe('Smallest version of the habit. Optional.'),
  reward: k.string().nullish().describe('Reward shown on completion. Optional.'),
  push_enabled: k.boolean().nullish().describe('Send reminders. Defaults to false.'),
  start_date: dateSchema.nullish().describe('First day of the habit. Defaults to today.')
});

export const updateHabitSchema = k.object({
  name: k.string().minLength(1).maxLength(120).nullish().describe('New name.'),
  tiny_action: k.string().minLength(1).nullish().describe('New tiny action, or null to remove it.'),
  reward: k.string().nullish().describe('New reward, or null to remove it.'),
  push_enabled: k.boolean().nullish().describe('Enable or disable reminders.')
});

// ==================== INFERRED INPUT TYPES ====================
// Input types come from the schemas (single source of truth), never hand-written.

export type HabitIdParam = kataxInfer<typeof habitIdParamSchema>;
export type ListHabitsQuery = kataxInfer<typeof listHabitsQuerySchema>;
export type CreateHabitInput = NullsToUndefined<kataxInfer<typeof createHabitSchema>>;
export type UpdateHabitInput = NullsToUndefined<kataxInfer<typeof updateHabitSchema>, HabitClearable>;

// ==================== VALIDATORS ====================

export async function validateHabitIdParam(data: unknown): Promise<ValidationResult<HabitIdParam>> {
  return validateNormalized(habitIdParamSchema, data);
}

export async function validateListHabitsQuery(data: unknown): Promise<ValidationResult<ListHabitsQuery>> {
  return validateNormalized(listHabitsQuerySchema, data);
}

export async function validateCreateHabit(data: unknown): Promise<ValidationResult<CreateHabitInput>> {
  return validateNormalized(createHabitSchema, data);
}

export async function validateUpdateHabit(data: unknown): Promise<ValidationResult<UpdateHabitInput>> {
  return validateNormalized(updateHabitSchema, data, HABIT_CLEARABLE);
}
```

### `habits.types.ts`

```ts
import type { HabitRow } from '../../types/db.types.js';
import type { PaginationMeta } from '../../shared/pagination.utils.js';

/** What the API returns for a habit (row + computed fields). */
export interface HabitView extends HabitRow {
  is_new: boolean;
}

export interface HabitListResult {
  habits: HabitView[];
  pagination: PaginationMeta;
}

/** Repository input for INSERT: every column explicit, `null` instead of `undefined`. */
export interface CreateHabitParams {
  userId: string;
  name: string;
  tinyAction: string | null;
  reward: string | null;
  pushEnabled: boolean;
  startDate: string;
}

/**
 * Repository input for UPDATE: `undefined` = leave the column as is,
 * `null` = set NULL (only for clearable columns).
 */
export interface UpdateHabitParams {
  name?: string;
  tinyAction?: string | null;
  reward?: string | null;
  pushEnabled?: boolean;
}

export interface HabitListFilter {
  userId: string;
  active: boolean;
  limit: number;
  offset: number;
}
```

### `habits.repository.ts`

```ts
import { db } from '../../shared/db.js';
import type { HabitRow } from '../../types/db.types.js';
import type { CreateHabitParams, HabitListFilter, UpdateHabitParams } from './habits.types.js';

/** Explicit column list (never SELECT *): dates as text so pg doesn't shift them by timezone. */
const HABIT_COLUMNS = `id, user_id, name, tiny_action, reward, push_enabled, active,
  start_date::text AS start_date, created_at, updated_at, archived_at`;

export async function listHabits(filter: HabitListFilter): Promise<HabitRow[]> {
  return db().query<HabitRow[]>(
    `SELECT ${HABIT_COLUMNS} FROM habits
     WHERE user_id = $1 AND active = $2
     ORDER BY created_at DESC
     LIMIT $3 OFFSET $4`,
    [filter.userId, filter.active, filter.limit, filter.offset]
  );
}

export async function countHabits(userId: string, active: boolean): Promise<number> {
  const rows = await db().query<Array<{ count: string }>>(
    'SELECT COUNT(*)::text AS count FROM habits WHERE user_id = $1 AND active = $2',
    [userId, active]
  );
  return Number(rows[0]?.count ?? 0);
}

export async function findHabitById(id: string): Promise<HabitRow | null> {
  const rows = await db().query<HabitRow[]>(`SELECT ${HABIT_COLUMNS} FROM habits WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function insertHabit(params: CreateHabitParams): Promise<HabitRow> {
  const rows = await db().query<HabitRow[]>(
    `INSERT INTO habits (user_id, name, tiny_action, reward, push_enabled, start_date)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${HABIT_COLUMNS}`,
    [params.userId, params.name, params.tinyAction, params.reward, params.pushEnabled, params.startDate]
  );
  return rows[0]!;
}

/** Only the keys that are not `undefined` are written (a missing key never becomes NULL). */
export async function updateHabit(id: string, params: UpdateHabitParams): Promise<HabitRow> {
  const columns: Record<string, unknown> = {
    name: params.name,
    tiny_action: params.tinyAction,
    reward: params.reward,
    push_enabled: params.pushEnabled
  };
  const entries = Object.entries(columns).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return (await findHabitById(id))!;

  const sets = entries.map(([column], i) => `${column} = $${i + 2}`).join(', ');
  const rows = await db().query<HabitRow[]>(
    `UPDATE habits SET ${sets}, updated_at = now() WHERE id = $1 RETURNING ${HABIT_COLUMNS}`,
    [id, ...entries.map(([, value]) => value)]
  );
  return rows[0]!;
}

export async function archiveHabit(id: string): Promise<HabitRow> {
  const rows = await db().query<HabitRow[]>(
    `UPDATE habits SET active = false, archived_at = now(), updated_at = now()
     WHERE id = $1 RETURNING ${HABIT_COLUMNS}`,
    [id]
  );
  return rows[0]!;
}
```

### `habits.controller.ts`

```ts
import { ControllerResult, createResponse, toSafeErrorResult } from '../../shared/api.utils.js';
import { notFoundError } from '../../shared/errors.utils.js';
import { buildPaginationMeta, DEFAULT_PAGE_SIZE, resolvePage } from '../../shared/pagination.utils.js';
import * as habitsRepository from './habits.repository.js';
import type { CreateHabitInput, ListHabitsQuery, UpdateHabitInput } from './habits.validator.js';
import type { HabitListResult, HabitView } from './habits.types.js';
import type { HabitRow } from '../../types/db.types.js';

const NEW_HABIT_DAYS = 7;

/** Loads a habit and checks ownership; a foreign habit is reported as not found (no existence leak). */
async function requireOwnedHabit(habitId: string, userId: string): Promise<HabitRow> {
  const habit = await habitsRepository.findHabitById(habitId);
  if (!habit || habit.user_id !== userId) throw notFoundError('Habit');
  return habit;
}

function toView(habit: HabitRow): HabitView {
  const ageMs = Date.now() - habit.created_at.getTime();
  return { ...habit, is_new: ageMs < NEW_HABIT_DAYS * 24 * 60 * 60 * 1000 };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function listHabits(userId: string, query: ListHabitsQuery): Promise<ControllerResult<HabitListResult>> {
  try {
    const active = query.active ?? true;
    const page = resolvePage(query.page);
    const [rows, total] = await Promise.all([
      habitsRepository.listHabits({ userId, active, limit: DEFAULT_PAGE_SIZE, offset: (page - 1) * DEFAULT_PAGE_SIZE }),
      habitsRepository.countHabits(userId, active)
    ]);
    const pagination = buildPaginationMeta(page, DEFAULT_PAGE_SIZE, total);
    return createResponse.success('Habits retrieved', { habits: rows.map(toView), pagination }, 200, pagination);
  } catch (error) {
    return toSafeErrorResult(error, { context: 'habits.list', userId });
  }
}

export async function getHabit(userId: string, habitId: string): Promise<ControllerResult<HabitView>> {
  try {
    return createResponse.success('Habit retrieved', toView(await requireOwnedHabit(habitId, userId)));
  } catch (error) {
    return toSafeErrorResult(error, { context: 'habits.get', userId, habitId });
  }
}

export async function createHabit(userId: string, input: CreateHabitInput): Promise<ControllerResult<HabitView>> {
  try {
    // Defaults and undefined -> null happen here, at the controller -> repository boundary.
    const habit = await habitsRepository.insertHabit({
      userId,
      name: input.name,
      tinyAction: input.tiny_action ?? null,
      reward: input.reward ?? null,
      pushEnabled: input.push_enabled ?? false,
      startDate: input.start_date ?? today()
    });
    return createResponse.success('Habit created', toView(habit), 201);
  } catch (error) {
    return toSafeErrorResult(error, { context: 'habits.create', userId });
  }
}

export async function updateHabit(
  userId: string,
  habitId: string,
  input: UpdateHabitInput
): Promise<ControllerResult<HabitView>> {
  try {
    await requireOwnedHabit(habitId, userId);
    const habit = await habitsRepository.updateHabit(habitId, {
      name: input.name,
      tinyAction: input.tiny_action, // undefined = keep, null = clear
      reward: input.reward,
      pushEnabled: input.push_enabled
    });
    return createResponse.success('Habit updated', toView(habit));
  } catch (error) {
    return toSafeErrorResult(error, { context: 'habits.update', userId, habitId });
  }
}

export async function archiveHabit(userId: string, habitId: string): Promise<ControllerResult<HabitView>> {
  try {
    await requireOwnedHabit(habitId, userId);
    return createResponse.success('Habit archived', toView(await habitsRepository.archiveHabit(habitId)));
  } catch (error) {
    return toSafeErrorResult(error, { context: 'habits.archive', userId, habitId });
  }
}
```

### `habits.handler.ts`

```ts
import { Request, Response } from 'express';
import { sendResponse } from '../../shared/api.utils.js';
import { validateWithId } from '../../shared/validation.utils.js';
import {
  validateCreateHabit,
  validateHabitIdParam,
  validateListHabitsQuery,
  validateUpdateHabit
} from './habits.validator.js';
import { archiveHabit, createHabit, getHabit, listHabits, updateHabit } from './habits.controller.js';

// Handlers only wire validator -> controller. req.user is set by requireAuth (mounted in api/routes.ts).

export async function listHabitsHandler(req: Request, res: Response): Promise<void> {
  await sendResponse(req, res, () => validateListHabitsQuery(req.query), (query) => listHabits(req.user!.id, query));
}

export async function getHabitHandler(req: Request, res: Response): Promise<void> {
  await sendResponse(req, res, () => validateHabitIdParam(req.params), (p) => getHabit(req.user!.id, p.id));
}

export async function createHabitHandler(req: Request, res: Response): Promise<void> {
  await sendResponse(req, res, () => validateCreateHabit(req.body), (input) => createHabit(req.user!.id, input));
}

export async function updateHabitHandler(req: Request, res: Response): Promise<void> {
  await sendResponse(
    req,
    res,
    () => validateWithId(() => validateHabitIdParam(req.params), () => validateUpdateHabit(req.body)),
    (data) => updateHabit(req.user!.id, data.id, data)
  );
}

export async function archiveHabitHandler(req: Request, res: Response): Promise<void> {
  await sendResponse(req, res, () => validateHabitIdParam(req.params), (p) => archiveHabit(req.user!.id, p.id));
}
```

### `habits.routes.ts`

```ts
import { Router } from 'express';
import {
  archiveHabitHandler,
  createHabitHandler,
  getHabitHandler,
  listHabitsHandler,
  updateHabitHandler
} from './habits.handler.js';

const router = Router();

/**
 * @route GET /api/habits?active=true&page=1
 * @desc List the user's habits (paginated)
 */
router.get('/', listHabitsHandler);

/**
 * @route POST /api/habits
 * @desc Create a habit
 */
router.post('/', createHabitHandler);

/**
 * @route GET /api/habits/:id
 * @desc Get one habit
 */
router.get('/:id', getHabitHandler);

/**
 * @route PATCH /api/habits/:id
 * @desc Update a habit (only the fields sent change; null clears clearable fields)
 */
router.patch('/:id', updateHabitHandler);

/**
 * @route POST /api/habits/:id/archive
 * @desc Archive a habit
 */
router.post('/:id/archive', archiveHabitHandler);

export default router;
```

### `api/routes.ts`

```ts
import { Router } from 'express';
import { healthCheckHandler } from './health/health.handler.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import authRouter from './auth/auth.routes.js';
import habitsRouter from './habits/habits.routes.js';

const router = Router();

// Public
router.get('/health', healthCheckHandler);
router.use('/auth', authRouter);

// Everything below requires a valid access token (sets req.user = { id })
router.use(requireAuth);
router.use('/habits', habitsRouter);

export default router;
```

## Shared building blocks

### `shared/db.ts` — typed access + transactions

```ts
import { katax } from 'katax-service-manager';
import type { ISqlDatabase } from 'katax-service-manager';
import type { PoolClient } from 'pg';

/**
 * Typed accessor for the 'main' PostgreSQL connection. Every repository
 * calls this instead of touching `katax.db()` directly, so the return type
 * (`ISqlDatabase`, with a generic `query<T>()`) is consistent everywhere.
 *
 * `katax.db(name)` is publicly typed as the broader `IDatabaseService`
 * (whose `query` is optional, to also cover Mongo/Redis connections); the
 * 'main' connection is always configured as PostgreSQL in src/index.ts, so
 * narrowing to `ISqlDatabase` here is safe.
 */
export function db(): ISqlDatabase {
  return katax.db('main') as unknown as ISqlDatabase;
}

/** Query surface handed to the callback of `withTransaction` (returns rows, like `db().query`). */
export interface Tx {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T>;
}

/**
 * Runs `fn` inside a single transaction on a dedicated pooled client.
 * Commits on success, rolls back (and rethrows) on any error, and always
 * releases the client.
 */
export async function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = (await db().getClient()) as PoolClient;
  try {
    await client.query('BEGIN');
    const tx: Tx = {
      query: async <R>(sql: string, params?: unknown[]) => (await client.query(sql, params)).rows as R
    };
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
```

Repositories call `db()` (never `katax.db('main')` directly) and use `withTransaction()` for multi-statement writes. `katax-service-manager` has no transaction API: this helper (dedicated pooled client + BEGIN/COMMIT/ROLLBACK + release) is the pattern. Don't `BEGIN` through `db().query()`: each call can run on a different pooled connection.

### `shared/errors.utils.ts` — expected errors

```ts
/**
 * Application error handling.
 *
 * `AppError` represents an EXPECTED, "operational" error (bad input, missing
 * ownership, duplicate resource, etc.) whose `message` is safe to send to the
 * client as-is, in English. Anything that is NOT an `AppError` (a raw
 * Postgres error, a bug, an unexpected exception) must NEVER reach the
 * client verbatim - it gets logged in full server-side and replaced with
 * `GENERIC_ERROR_MESSAGE` before it leaves the process.
 */

export const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again later.';

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode = 400, code = 'BAD_REQUEST') {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export function unauthorizedError(message = 'Invalid credentials'): AppError {
  return new AppError(message, 401, 'UNAUTHORIZED');
}

export function forbiddenError(message = 'You do not have access to this resource'): AppError {
  return new AppError(message, 403, 'FORBIDDEN');
}

export function notFoundError(resource = 'Resource'): AppError {
  return new AppError(`${resource} not found`, 404, 'NOT_FOUND');
}

export function conflictError(message: string): AppError {
  return new AppError(message, 409, 'CONFLICT');
}

export function validationError(message: string): AppError {
  return new AppError(message, 400, 'VALIDATION_ERROR');
}
```

### `toSafeErrorResult` (in `shared/api.utils.ts`)

```ts
export function toSafeErrorResult(error: unknown, logContext: Record<string, unknown> = {}): ControllerResult {
  if (isAppError(error)) {
    return createResponse.error(error.message, error.code, error.statusCode);
  }
  katax.logger.error({ err: error, ...logContext, message: 'Unhandled error' });
  return createResponse.error(GENERIC_ERROR_MESSAGE, 'INTERNAL_ERROR', 500);
}
```

Use it in every controller `catch` and inside `sendResponse`'s own `catch`. Never `error instanceof Error ? error.message : ...` into a response: that is how Postgres messages ("duplicate key value violates unique constraint ...") reach clients.

### `shared/validation.utils.ts` + `types/api.types.ts`

```ts
// types/api.types.ts
/** Body/query data plus the `:id` taken from the URL (handlers merge both after validating each). */
export type WithId<T> = T & { id: string };

// shared/validation.utils.ts
import type { ValidationResult } from './api.utils.js';
import type { WithId } from '../types/api.types.js';

/**
 * Validates the `:id` param and the body separately (each with its own
 * schema) and merges them, so one sendResponse() call gets both.
 */
export async function validateWithId<T>(
  validateId: () => Promise<ValidationResult<{ id: string }>>,
  validateBody: () => Promise<ValidationResult<T>>
): Promise<ValidationResult<WithId<T>>> {
  const idResult = await validateId();
  if (!idResult.isValid || !idResult.data) return { isValid: false, errors: idResult.errors };
  const bodyResult = await validateBody();
  if (!bodyResult.isValid || !bodyResult.data) return { isValid: false, errors: bodyResult.errors };
  return { isValid: true, data: { ...bodyResult.data, id: idResult.data.id } };
}
```

### `shared/pagination.utils.ts`

```ts
import { k, kataxInfer } from 'katax-core';
import { validateSchema } from './api.utils.js';
import type { ValidationResult } from './api.utils.js';

export const DEFAULT_PAGE_SIZE = 20;

/**
 * Reused by every list endpoint's query validator so `page` stays
 * consistent (coerced from the query string) instead of being redeclared
 * per resource.
 */
export const pageQuerySchema = k.object({
  page: k.coerce.number().optional().describe('1-based page number, defaults to 1')
});
export type PageQuery = kataxInfer<typeof pageQuerySchema>;

export async function validatePageQuery(data: unknown): Promise<ValidationResult<PageQuery>> {
  return validateSchema(pageQuerySchema, data);
}

export interface PaginationMeta {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  totalCount: number;
  hasMorePages: boolean;
}

export function resolvePage(page: number | undefined): number {
  return page && page > 0 ? Math.floor(page) : 1;
}

export function buildPaginationMeta(page: number, pageSize: number, totalCount: number): PaginationMeta {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  return {
    currentPage: page,
    totalPages,
    totalItems: totalCount,
    totalCount,
    hasMorePages: page < totalPages
  };
}
```

### `middleware/auth.middleware.ts`

```ts
import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../shared/crypto.utils.js';

export interface AuthenticatedUser {
  id: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

/**
 * Reads `Authorization: Bearer <access_token>`, verifies signature/expiry,
 * and attaches `req.user = { id: sub }`. All routes for identities, habits,
 * reminders, logs and reminder-logs require this middleware.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

  if (!token) {
    res.status(401).json({
      success: false,
      message: 'Authentication required',
      error: 'UNAUTHORIZED'
    });
    return;
  }

  const payload = verifyAccessToken(token);

  if (!payload) {
    res.status(401).json({
      success: false,
      message: 'Invalid or expired token',
      error: 'UNAUTHORIZED'
    });
    return;
  }

  req.user = { id: payload.sub };
  next();
}
```

## Repository conventions

- Exported **functions** (`export async function findHabitById`) imported as `import * as habitsRepository from './habits.repository.js'`. Class repositories (`api-second-brain`) work too; don't mix both styles in one project.
- Column list constant (`HABIT_COLUMNS`), never `SELECT *` in new code.
- Dates/times as text: `col::text`, `to_char(col, 'HH24:MI')`. pg turns `date` into a JS `Date` at server-timezone midnight and shifts the day.
- `COUNT(*)::text` then `Number(...)` (pg returns bigint as string).
- Parameterized queries only (`$1`, `$2`); dynamic SET/WHERE built from a whitelist of column names, never from user keys.
- Return `Row | null` for single lookups (`rows[0] ?? null`); throw `notFoundError` in the controller, not the repository.
- Ownership: load then compare `user_id` in the controller (`requireOwnedHabit`), and answer **404** for someone else's resource (don't leak existence).

## Migrating an older API (property-scout style)

Signs of the old style: a big `db/queries.ts`, SQL template strings inside `*.controller.ts`, `katax.db('main')` calls scattered in controllers, inline `data: {...}` parameter types, controllers verifying the JWT themselves, `error.message` returned to clients.

Order of work per resource: (1) create `<resource>.types.ts` and move every inline type there; (2) move each query into `<resource>.repository.ts` with a row type; (3) make the controller call the repository and `toSafeErrorResult`; (4) add `requireAuth` in `routes.ts` and remove token parsing from controllers; (5) typecheck.
