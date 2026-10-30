# API architecture: layers and a complete resource

The structure every katax API follows. The example below is what `katax add endpoint habits --fields
"name:string, reward:text?, start_date:date?, active:boolean?"` generates (katax-cli 1.7.1), with the fixes the
standard adds on top (owner inside the write, `SqlExecutor` parameter, `CountRow`/`IdRow`). It compiles under
`strict` and was exercised over HTTP: another user's habit answers 404 on GET/PATCH/DELETE, `{"reward": null}`
clears the reward and leaves the name, `?page=1&limit=5` is coerced.

## Contents

1. Layers and what each one may do
2. File layout
3. null vs undefined
4. The complete resource (validator, types, repository, controller, handler, routes)
5. Sub-resources
6. Repository conventions

## 1. Layers

| Layer | Does | Never | Level |
| --- | --- | --- | --- |
| `routes` | mounts handlers, limiters and `docs()` metadata | logic | required |
| `handler` | one `sendResponse(req, res, validator, controller)` call | database, hand-built responses | required |
| `controller` | business rule, ownership, `AppError`, `toSafeErrorResult` | SQL, `db()`, `req`/`res` | required |
| `service` | external I/O (third-party APIs, other services, LLMs), orchestration shared by several controllers or workers, heavy reusable logic | SQL; `req`/`res` | allowed when it separates something that isn't the endpoint's own rule |
| `worker` / `job` | background work: thumbnails, cleanups, cron | SQL (calls a service or a repository) | allowed, see `workers-and-cron.md` |
| `*.calculator.ts` / `*.rules.ts` | pure functions with a `*.test.ts` | I/O | recommended for non-trivial rules |
| `repository` | all the SQL | business rules, `notFoundError` | required |

Why the split matters: controllers that only see typed inputs and return `ControllerResult` are the same code
the MCP tools call (`katax-mcp-server`), they can be unit-tested with the repository mocked, and a rule like
"SQL only in repositories" is something the audit script can enforce mechanically.

Centralised repositories in `src/repositories/` are acceptable only for tables that belong to no resource
(sessions, roles, outbox). A single `db/queries.ts` holding every query is the old style to migrate away from.

## 2. File layout

```
src/
├── index.ts                     # import 'dotenv/config' first; katax.init; databases; listen
├── app.ts                       # async-errors, trust proxy, helmet, CORS, limiters, docs, routes, 404, errorMiddleware
├── api/
│   ├── routes.ts                # public routes -> router.use(requireAuth) -> private routers
│   ├── health/health.handler.ts
│   └── habits/
│       ├── habits.validator.ts  # schemas + inferred input types + validate* functions
│       ├── habits.types.ts      # views, list results, repository params, filters
│       ├── habits.repository.ts # the only place with SQL
│       ├── habits.controller.ts # business logic -> ControllerResult
│       ├── habits.handler.ts    # sendResponse(req, res, validator, controller)
│       ├── habits.routes.ts     # Router + docs()
│       └── reminders/           # sub-resource: habits/:habitId/reminders
├── services/ · workers/ · jobs/ # only when needed
├── types/db.types.ts            # row types (CountRow, IdRow, <Table>Row)
├── shared/                      # api.utils, errors.utils, null.utils, db.ts, pagination, validation, openapi ...
├── config/                      # cors.config, cookie.config
└── middleware/                  # auth (requireAuth, requireRole), error, logger, rate-limit, no-store
```

## 3. null vs undefined

`undefined` (key missing) and `null` (explicit empty) are different. katax-core keeps them apart: `.optional()`
rejects `null`.

| Situation | Schema | What reaches the controller |
| --- | --- | --- |
| Required field | `k.string()` | always a value |
| Optional field a client may send as `null` (MCP clients, forms) | `.nullish()` + `validateNormalized` | `T \| undefined` (nulls dropped) |
| PATCH field that can be cleared | `.nullish()` + listed in `<RESOURCE>_CLEARABLE` | `undefined` = keep, `null` = clear, value = set |
| Query param | `k.coerce.number()` / `k.coerce.boolean()` (+ `.optional()`) | coerced value or `undefined` |
| Server default | no schema default; `input.x ?? default` in the controller | |
| Row / response nullable column | `T \| null` (never `?:`) | |

- `.nullish()` needs katax-core >= 1.6.6 (older versions list it as required in `toJsonSchema()`).
- `undefined -> null` happens only at the controller -> repository boundary (`reward: input.reward ?? null`).
- An UPDATE writes only keys that are `!== undefined`; never spread a validated object into SQL params.
- The clearable list is per resource, so each one decides which of its fields `null` may erase.

## 4. The complete resource

### `types/db.types.ts` (excerpt)

```ts
/**
 * Row types mirroring the SQL schema exactly (table + column names).
 * Every db().query<T>() in every repository uses one of these (or a
 * Pick/composite of them) - never `any` or an inline object type.
 * Nullable columns are `T | null`, never optional (`?`).
 * `date` columns are selected with ::text, so they are strings (YYYY-MM-DD).
 */

/** Table `habits` (habit). */
export interface HabitRow {
  id: string;
  user_id: string;
  name: string;
  reward: string | null;
  /** YYYY-MM-DD (selected with ::text) */
  start_date: string | null;
  active: boolean | null;
  created_at: Date;
  updated_at: Date;
}

/** Table `reminders` (reminder). */
export interface ReminderRow {
  id: string;
  user_id: string;
  habit_id: string;
  time: string;
  note: string | null;
  created_at: Date;
  updated_at: Date;
}
/**
 * Row types mirroring the SQL schema 1:1 (table and column names).
 * Every db().query<T>() uses one of these (or a Pick/composite of one):
 * never `any`, never an inline `{ ... }` generic.
 * Nullable columns are `T | null` (never `?:`); dates selected with ::text are strings.
 */

/** `SELECT COUNT(*)::text AS count ...` (pg returns bigint as string). */
export interface CountRow {
  count: string;
}

/** `... RETURNING id` */
export interface IdRow {
  id: string;
}

// export interface HabitRow { id: string; user_id: string; name: string; reward: string | null; start_date: string | null; created_at: Date; updated_at: Date; }
```

(`HabitRow` is written by the generator; `CountRow` / `IdRow` come from the plugin template.)

### `habits.validator.ts`

```ts
import { k, kataxInfer } from 'katax-core';
import type { ValidationResult } from '../../shared/api.utils.js';
import { validateNormalized } from '../../shared/null.utils.js';
import type { NullsToUndefined } from '../../shared/null.utils.js';
import { dateSchema } from '../../shared/validation.utils.js';
import { limitField, pageField } from '../../shared/pagination.utils.js';

/** Fields where `null` means "clear it" on update (any other null means "not provided"). */
export const HABIT_CLEARABLE = ['reward', 'start_date', 'active'] as const;
type HabitClearable = (typeof HABIT_CLEARABLE)[number];

// ==================== SCHEMAS ====================

export const habitIdParamSchema = k.object({
  id: k.string().uuid('Invalid habit id').describe('Habit id.')
});

export const listHabitsQuerySchema = k.object({
  page: pageField,
  limit: limitField
});

export const createHabitSchema = k.object({
  name: k.string().minLength(1).maxLength(255).describe('Name.'),
  reward: k.string().nullish().describe('Reward. Optional.'),
  start_date: dateSchema.nullish().describe('Start date. Optional.'),
  active: k.boolean().nullish().describe('Active. Optional.')
});

export const updateHabitSchema = k.object({
  name: k.string().minLength(1).maxLength(255).nullish().describe('New name.'),
  reward: k.string().nullish().describe('New reward, or null to remove it.'),
  start_date: dateSchema.nullish().describe('New start date, or null to remove it.'),
  active: k.boolean().nullish().describe('New active, or null to remove it.')
});

// ==================== INPUT TYPES (inferred, never hand-written) ====================

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

/** What the API returns for a habit. Add computed fields here and fill them in the controller's toView(). */
export type HabitView = HabitRow;

export interface HabitsListResult {
  habits: HabitView[];
  pagination: PaginationMeta;
}

export interface HabitListFilter {
  userId: string;
  limit: number;
  offset: number;
}

/** Repository input for INSERT: every column explicit, `null` instead of `undefined`. */
export interface CreateHabitParams {
  userId: string;
  name: string;
  reward: string | null;
  startDate: string | null;
  active: boolean | null;
}

/**
 * Repository input for UPDATE: `undefined` = leave the column as is,
 * `null` = set NULL (only optional columns accept it).
 */
export interface UpdateHabitParams {
  name?: string;
  reward?: string | null;
  startDate?: string | null;
  active?: boolean | null;
}
```

### `habits.repository.ts`

```ts
import { db } from '../../shared/db.js';
import type { SqlExecutor } from '../../shared/db.js';
import type { CountRow, HabitRow, IdRow } from '../../types/db.types.js';
import type { CreateHabitParams, HabitListFilter, UpdateHabitParams } from './habits.types.js';

/** Explicit column list (never SELECT *); dates as text so pg doesn't shift them by timezone. */
const HABIT_COLUMNS = `id, user_id, name, reward, start_date::text AS start_date, active, created_at, updated_at`;

/** Columns an UPDATE may touch: dynamic SET clauses are built only from this list, never from request keys. */
const UPDATABLE: Record<keyof UpdateHabitParams, string> = {
  name: 'name',
  reward: 'reward',
  startDate: 'start_date',
  active: 'active'
};

export async function listHabits(filter: HabitListFilter, executor: SqlExecutor = db()): Promise<HabitRow[]> {
  return executor.query<HabitRow[]>(
    `SELECT ${HABIT_COLUMNS} FROM habits
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [filter.userId, filter.limit, filter.offset]
  );
}

export async function countHabits(userId: string, executor: SqlExecutor = db()): Promise<number> {
  const rows = await executor.query<CountRow[]>('SELECT COUNT(*)::text AS count FROM habits WHERE user_id = $1', [userId]);
  return Number(rows[0]?.count ?? 0);
}

/** Owner-scoped lookup: someone else's habit simply isn't found. */
export async function findHabit(id: string, userId: string, executor: SqlExecutor = db()): Promise<HabitRow | null> {
  const rows = await executor.query<HabitRow[]>(
    `SELECT ${HABIT_COLUMNS} FROM habits WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return rows[0] ?? null;
}

export async function insertHabit(params: CreateHabitParams, executor: SqlExecutor = db()): Promise<HabitRow> {
  const rows = await executor.query<HabitRow[]>(
    `INSERT INTO habits (user_id, name, reward, start_date, active)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${HABIT_COLUMNS}`,
    [params.userId, params.name, params.reward, params.startDate, params.active]
  );
  return rows[0]!;
}

/**
 * Writes only the keys that are not `undefined` (a missing key never becomes NULL).
 * The owner is part of the WHERE: the row changes only if it still belongs to the user.
 */
export async function updateHabit(
  id: string,
  userId: string,
  params: UpdateHabitParams,
  executor: SqlExecutor = db()
): Promise<HabitRow | null> {
  const entries = (Object.keys(UPDATABLE) as Array<keyof UpdateHabitParams>)
    .filter((key) => params[key] !== undefined)
    .map((key) => [UPDATABLE[key], params[key]] as const);
  if (entries.length === 0) return findHabit(id, userId, executor);

  const sets = entries.map(([column], i) => `${column} = $${i + 3}`).join(', ');
  const rows = await executor.query<HabitRow[]>(
    `UPDATE habits SET ${sets}, updated_at = now()
     WHERE id = $1 AND user_id = $2
     RETURNING ${HABIT_COLUMNS}`,
    [id, userId, ...entries.map(([, value]) => value)]
  );
  return rows[0] ?? null;
}

export async function deleteHabit(id: string, userId: string, executor: SqlExecutor = db()): Promise<boolean> {
  const rows = await executor.query<IdRow[]>('DELETE FROM habits WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId]);
  return rows.length > 0;
}
```

### `habits.controller.ts`

```ts
import { createResponse, toSafeErrorResult } from '../../shared/api.utils.js';
import type { ControllerResult } from '../../shared/api.utils.js';
import { notFoundError } from '../../shared/errors.utils.js';
import { buildPaginationMeta, resolvePage } from '../../shared/pagination.utils.js';
import * as habitsRepository from './habits.repository.js';
import type {
  HabitIdParam,
  ListHabitsQuery,
  CreateHabitInput,
  UpdateHabitInput
} from './habits.validator.js';
import type { HabitView, HabitsListResult } from './habits.types.js';
import type { HabitRow } from '../../types/db.types.js';

/** Someone else's habit is reported as not found (404, no existence leak). */
async function requireHabit(userId: string, params: HabitIdParam): Promise<HabitRow> {
  const row = await habitsRepository.findHabit(params.id, userId);
  if (!row) throw notFoundError('Habit');
  return row;
}

function toView(row: HabitRow): HabitView {
  return row;
}

export async function listHabits(
  userId: string,
  query: ListHabitsQuery
): Promise<ControllerResult<HabitsListResult>> {
  try {
    const { page, limit, offset } = resolvePage(query.page, query.limit);
    const filter = { userId };
    const [rows, total] = await Promise.all([
      habitsRepository.listHabits({ ...filter, limit, offset }),
      habitsRepository.countHabits(userId)
    ]);
    const pagination = buildPaginationMeta(page, limit, total);
    return createResponse.success('Habits retrieved', { habits: rows.map(toView), pagination }, 200, pagination);
  } catch (error) {
    return toSafeErrorResult(error, { context: 'habits.list', userId });
  }
}

export async function getHabit(userId: string, params: HabitIdParam): Promise<ControllerResult<HabitView>> {
  try {
    return createResponse.success('Habit retrieved', toView(await requireHabit(userId, params)));
  } catch (error) {
    return toSafeErrorResult(error, { context: 'habits.get', userId, id: params.id });
  }
}

export async function createHabit(
  userId: string,
  input: CreateHabitInput
): Promise<ControllerResult<HabitView>> {
  try {
    // Defaults and undefined -> null happen here, at the controller -> repository boundary.
    const row = await habitsRepository.insertHabit({
      userId,
      name: input.name,
      reward: input.reward ?? null,
      startDate: input.start_date ?? null,
      active: input.active ?? null
    });
    return createResponse.success('Habit created', toView(row), 201);
  } catch (error) {
    return toSafeErrorResult(error, { context: 'habits.create', userId });
  }
}

export async function updateHabit(
  userId: string,
  params: HabitIdParam,
  input: UpdateHabitInput
): Promise<ControllerResult<HabitView>> {
  try {
    // The owner is checked inside the UPDATE itself: no row back = not found (or not theirs).
    const row = await habitsRepository.updateHabit(params.id, userId, {
      // undefined = keep the current value; null = clear it (optional fields only)
      name: input.name,
      reward: input.reward,
      startDate: input.start_date,
      active: input.active
    });
    if (!row) throw notFoundError('Habit');
    return createResponse.success('Habit updated', toView(row));
  } catch (error) {
    return toSafeErrorResult(error, { context: 'habits.update', userId, id: params.id });
  }
}

export async function deleteHabit(
  userId: string,
  params: HabitIdParam
): Promise<ControllerResult<{ id: string }>> {
  try {
    if (!(await habitsRepository.deleteHabit(params.id, userId))) throw notFoundError('Habit');
    return createResponse.success('Habit deleted', { id: params.id });
  } catch (error) {
    return toSafeErrorResult(error, { context: 'habits.delete', userId, id: params.id });
  }
}
```

### `habits.handler.ts`

```ts
import type { Request, Response } from 'express';
import { sendResponse, validateComposed } from '../../shared/api.utils.js';
import {
  validateHabitIdParam,
  validateListHabitsQuery,
  validateCreateHabit,
  validateUpdateHabit
} from './habits.validator.js';
import { listHabits, getHabit, createHabit, updateHabit, deleteHabit } from './habits.controller.js';

// Handlers only wire validator -> controller. req.user is set by requireAuth (mounted in api/routes.ts).

export async function listHabitsHandler(req: Request, res: Response): Promise<void> {
  await sendResponse(req, res, () => validateListHabitsQuery(req.query), (query) => listHabits(req.user!.id, query));
}

export async function getHabitHandler(req: Request, res: Response): Promise<void> {
  await sendResponse(req, res, () => validateHabitIdParam(req.params), (params) => getHabit(req.user!.id, params));
}

export async function createHabitHandler(req: Request, res: Response): Promise<void> {
  await sendResponse(req, res, () => validateCreateHabit(req.body), (input) => createHabit(req.user!.id, input));
}

export async function updateHabitHandler(req: Request, res: Response): Promise<void> {
  await sendResponse(
    req,
    res,
    () =>
      validateComposed(
        () => validateHabitIdParam(req.params),
        () => validateUpdateHabit(req.body),
        (params, input) => ({ params, input })
      ),
    (data) => updateHabit(req.user!.id, data.params, data.input)
  );
}

export async function deleteHabitHandler(req: Request, res: Response): Promise<void> {
  await sendResponse(req, res, () => validateHabitIdParam(req.params), (params) => deleteHabit(req.user!.id, params));
}
```

### `habits.routes.ts`

```ts
import { Router } from 'express';
import { docs } from '../../shared/openapi.utils.js';
import {
  habitIdParamSchema,
  listHabitsQuerySchema,
  createHabitSchema,
  updateHabitSchema
} from './habits.validator.js';
import {
  listHabitsHandler,
  getHabitHandler,
  createHabitHandler,
  updateHabitHandler,
  deleteHabitHandler
} from './habits.handler.js';

const router = Router();

/** GET /api/habits */
router.get('/', docs({ summary: 'List habits', query: listHabitsQuerySchema }), listHabitsHandler);

/** POST /api/habits */
router.post('/', docs({ summary: 'Create a habit', body: createHabitSchema }), createHabitHandler);

/** GET /api/habits/:id */
router.get('/:id', docs({ summary: 'Get a habit', params: habitIdParamSchema }), getHabitHandler);

/** PATCH /api/habits/:id */
router.patch('/:id', docs({ summary: 'Update a habit', description: 'Only the fields sent change; null clears optional fields.', params: habitIdParamSchema, body: updateHabitSchema }), updateHabitHandler);

/** DELETE /api/habits/:id */
router.delete('/:id', docs({ summary: 'Delete a habit', params: habitIdParamSchema }), deleteHabitHandler);

export default router;
```

### `api/routes.ts`

```ts
import { Router } from 'express';
import { healthCheckHandler } from './health/health.handler.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import habitsRouter from './habits/habits.routes.js';
import habitsRemindersRouter from './habits/reminders/reminders.routes.js';

const router = Router();

// Public
router.get('/health', healthCheckHandler);

// Everything below requires a valid access token (req.user = { id, email, role })
router.use(requireAuth);
router.use('/habits', habitsRouter);
router.use('/habits/:habitId/reminders', habitsRemindersRouter);

export default router;
```

## 5. Sub-resources

`katax add endpoint habits/:habitId/reminders` nests the folder (`api/habits/reminders/`), uses
`Router({ mergeParams: true })`, validates `habitId` and checks that the parent habit belongs to the user before
touching a reminder. The owner check for the child goes through the parent: `WHERE r.id = $1 AND r.habit_id = $2`
plus the parent's `user_id`. Keep the parent's id type (uuid/number) from its row type.

## 6. Repository conventions

- Exported functions imported as `import * as habitsRepository from './habits.repository.js'`. Class repositories
  work too; one style per project.
- Every function takes `executor: SqlExecutor = db()` last, so a controller or service can do
  `withTransaction(async (tx) => { await a.insert(x, tx); await b.update(y, tx); })`.
- Column list constant, never `SELECT *`. Dates `col::text`, times `to_char(col, 'HH24:MI')`, counts
  `COUNT(*)::text` then `Number()`.
- Parameterised queries only. Dynamic `SET`/`WHERE` come from a whitelist of column names (`UPDATABLE` above),
  never from request keys.
- Single lookups return `Row | null`; `notFoundError` is thrown in the controller.
- Ownership lives in the write itself: `WHERE id = $1 AND user_id = $2`. A separate "load, compare, then write"
  leaves a window between the two queries (see `concurrency.md`).
- Constraint violations (23505 unique, 23503 FK) are translated with `isUniqueViolation()` /
  `isForeignKeyViolation()` (template `shared/db-errors.ts`), never by matching `error.message`.
- Optional: mappers from row to response (`toView`) when the API exposes camelCase or ISO dates; optimistic
  concurrency with a `revision` column when several clients edit the same document.
