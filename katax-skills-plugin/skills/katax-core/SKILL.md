---
name: katax-core
description: 'Schema validation library for TypeScript (katax-core): k.object/k.string/..., optional vs nullable vs nullish, coercion for query params, async refinements, kataxInfer types, toJsonSchema() for OpenAPI 3.1 / MCP. Use when: writing or reviewing request validators, deciding how to model null/optional fields, inferring input types, exposing schemas as JSON Schema, debugging validation errors.'
argument-hint: 'What are you validating? (body/query/params/patch/env/file/async/json-schema)'
---

# katax-core — Schema Validation

Zod-style validation for TypeScript. Only runtime dependency: `date-fns`.

**Version: 1.6.6** (`npm install katax-core`). 1.6.6 fixed `toJsonSchema()` for `nullable`/`nullish`/`integer`/`strict`/discriminated unions/recursive `lazy` — see "JSON Schema" below. Use `^1.6.6` in projects that expose schemas to OpenAPI or MCP.

House style for where validators live and how they connect to controllers/repositories: `katax-ecosystem` skill → `references/api-architecture.md`.

## The validator file pattern

Every resource has one `<resource>.validator.ts` with three blocks: schemas, inferred types, `validate*` functions. Input types are **inferred, never hand-written**.

```ts
import { k, kataxInfer } from 'katax-core';
import type { ValidationResult } from '../../shared/api.utils.js';
import { validateNormalized } from '../../shared/null.utils.js';
import type { NullsToUndefined } from '../../shared/null.utils.js';

export const dateSchema = k.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').describe('Calendar date as YYYY-MM-DD.');

/** Fields where null means "clear it" on update. */
export const HABIT_CLEARABLE = ['tiny_action', 'reward'] as const;

// ==================== SCHEMAS ====================
export const habitIdParamSchema = k.object({
  id: k.string().uuid('Invalid habit id').describe('Habit UUID.')
});

export const listHabitsQuerySchema = k.object({
  active: k.coerce.boolean().optional().describe('true (default) = active, false = archived.'),
  page: k.coerce.number().integer().min(1).optional().describe('1-based page number.')
});

export const createHabitSchema = k.object({
  name: k.string().minLength(1, 'Name is required').maxLength(120).describe('Habit name.'),
  reward: k.string().nullish().describe('Reward shown on completion. Optional.'),
  start_date: dateSchema.nullish().describe('First day. Defaults to today.')
});

export const updateHabitSchema = k.object({
  name: k.string().minLength(1).maxLength(120).nullish().describe('New name.'),
  reward: k.string().nullish().describe('New reward, or null to remove it.')
});

// ==================== INFERRED TYPES ====================
export type HabitIdParam = kataxInfer<typeof habitIdParamSchema>;
export type ListHabitsQuery = kataxInfer<typeof listHabitsQuerySchema>;
export type CreateHabitInput = NullsToUndefined<kataxInfer<typeof createHabitSchema>>;
export type UpdateHabitInput = NullsToUndefined<kataxInfer<typeof updateHabitSchema>, (typeof HABIT_CLEARABLE)[number]>;

// ==================== VALIDATORS ====================
export async function validateCreateHabit(data: unknown): Promise<ValidationResult<CreateHabitInput>> {
  return validateNormalized(createHabitSchema, data);
}

export async function validateUpdateHabit(data: unknown): Promise<ValidationResult<UpdateHabitInput>> {
  return validateNormalized(updateHabitSchema, data, HABIT_CLEARABLE);
}
```

- `.describe()` on **every** field: the same text feeds OpenAPI and MCP tool schemas.
- Reuse field schemas (`dateSchema`, `pageQuerySchema`) instead of redeclaring them.
- `validateNormalized` (in `shared/null.utils.ts`, full code in `references/api-architecture.md` of the `katax-ecosystem` skill) = katax-core `validateSchema` + null normalization.

## optional vs nullable vs nullish — pick the right one

`undefined` (missing key) and `null` (explicit empty) are different values. **`.optional()` rejects `null`** — that is by design, not a bug.

| Modifier | `undefined` / missing key | `null` | In `toJsonSchema()` `required`? | TS type |
|---|---|---|---|---|
| (none) | ❌ | ❌ | yes | `T` |
| `.optional()` | ✅ | ❌ | no | `T \| undefined` |
| `.nullable()` | ❌ | ✅ | yes | `T \| null` |
| `.nullish()` | ✅ | ✅ | no | `T \| null \| undefined` |
| `.default(v)` | ✅ → `v` | ❌ | no | `T` |

Which to use:

| Situation | Use |
|---|---|
| Required body field | plain schema |
| Optional field, REST-only client that omits it | `.optional()` |
| Optional field that clients may send as `null` (MCP/Claude, HTML forms, mobile) | `.nullish()` + `validateNormalized` (nulls become `undefined`) |
| PATCH field that can be cleared | `.nullish()` and list the key in the `keep` array → `undefined` = keep, `null` = clear |
| Nullable column whose field must always be sent | `.nullable()` |
| Query string param | `k.coerce.number()` / `k.coerce.boolean()` + `.optional()` — query values are strings and never `null` |
| Default value | prefer `input.x ?? default` in the controller (keeps the default next to the business rule); `.default()` is fine for static defaults |

```ts
k.string().optional().safeParse(null);       // ❌ "Expected string, received null"
k.string().nullish().safeParse(null);        // ✅ null
k.string().nullable().safeParse(undefined);  // ❌ the key is required
k.number().optional().safeParse('2');        // ❌ query strings need k.coerce.number()
k.coerce.number().optional().safeParse('2'); // ✅ 2
```

`.nullable().optional()` ≡ `.nullish()`. Prefer `.nullish()`. (On katax-core ≤ 1.6.5, `.nullish()` was wrongly listed in `toJsonSchema().required` and lacked the `null` type — upgrade to 1.6.6 rather than working around it.)

## API reference

Every schema implements `parse`, `safeParse`, `validate`, `parseAsync`, `safeParseAsync`, `isValidAsync`, `hasAsyncValidation`, `optional`, `nullable`, `nullish`, `default`, `catch`, `transform`, `refine`, `asyncRefine`, `brand`, `describe`, `toJsonSchema`. All builders return new instances (immutable chaining).

### Factories

```ts
k.string()   k.number()   k.boolean()   k.bigint()   k.date()   k.twoDates(separator = '|')
k.object(shape)   k.array(item)   k.tuple([a, b])   k.record(value)   k.set(item)   k.map(key, value)
k.union([...])   k.intersection([...])   k.discriminatedUnion(key, { value: schema })   k.lazy(fn, name?)
k.email()   k.file()   k.base64()   k.promise(schema?)
k.literal(v)   k.enum(['a', 'b'] as const)   k.custom<T>(fn)   k.any()   k.unknown()   k.never()
k.nan()   k.null()   k.undefined()   k.void()
k.coerce.number() / .boolean() / .string() / .date()
k.preprocess(fn, schema)
```

### String

`minLength(n)` `maxLength(n)` `length(n)` `nonempty()`/`notEmpty()` `email()` `url()` `uuid()` `ip()` (IPv4) `datetime()` `jwt()` `cuid2()` `ulid()` `emoji()` `cidr()` `regex(re)` `startsWith(s)` `endsWith(s)` `includes(s)` `oneOf([...])` `notOneOf([...])` `lowercase()` `uppercase()` `alpha()` `alphanumeric()` `ascii()` `noWhitespace()` `trim()` (checks there's no surrounding whitespace; it does not trim). Every rule takes an optional message except `trim()`.

There is **no** `k.string().min()`: use `minLength`.

### Number / BigInt

`min` `max` `between(min, max)` `greaterThan` `lessThan` `positive` `negative` `nonnegative` `nonpositive` `integer` `finite` `multipleOf` `equals` `notEqual` `oneOf` `notOneOf`. BigInt has the same set except `integer`/`finite`, and validates native `bigint` only (no coercion).

### Object

`extend(shape)` `merge(other)` `pick(['a'])` `omit(['a'])` `partial()` `strict()` (reject unknown keys) `passthrough()` (keep them) `strip()` (default: drop them) `caseInsensitive()` `getShape()`.

### Array / Set / Map

Array: `minLength`/`min` `maxLength`/`max` `length` `notEmpty`/`nonempty` `unique` `contains(value)`. Set/Map: `minSize` `maxSize` `nonempty`. Always pass the element schema (`k.array()` without one accepts anything).

### Date

Accepts a `Date` or ISO string (`'2024-01-15'`, `'2024-01-15T10:30:00Z'`), outputs a `Date`. `min(str)` `max(str)` `between(a, b)` `isFuture` `isPast` `format('yyyy-MM-dd')` `isDateOnly` `hasTime` `formatOutput(fmt)` (output becomes a string).

For calendar dates stored in `date` columns, prefer a `YYYY-MM-DD` string schema (like `dateSchema` above) over `k.date()`: a `Date` object carries a timezone and can shift the day.

### Email / File / Base64

- `k.email()`: `domain` `domains` `domainPattern` `notDomains` `localMinLength` `localMaxLength` `localPattern` `corporate` `noPlus` `noDots`. Use it instead of `k.string().email()` when you need domain rules.
- `k.file()` (browser `File` / multer): `maxSize` `minSize` `type` `types` `typePattern('image/*')` `extension` `extensions` `namePattern` `image` `video` `audio` `document`.
- `k.base64()`: `minDecodedSize` `maxDecodedSize` `mimeType` `mimeTypePattern` `image` `pdf` `json` `dataUrl`.

### Composition

```ts
k.union([k.string(), k.number()]);                       // first match wins
k.intersection([k.object({ id: k.number() }), k.object({ name: k.string() })]);
k.discriminatedUnion('type', {                           // map keys = discriminator values
  cat: k.object({ type: k.literal('cat'), meow: k.boolean() }),
  dog: k.object({ type: k.literal('dog'), bark: k.boolean() }),
});
const category: any = k.lazy(() => k.object({ name: k.string(), children: k.array(category) }), 'Category');
```

### Coercion & preprocess

```ts
k.coerce.number();   // "42" → 42, true → 1; null/undefined → issue
k.coerce.boolean();  // "true"/"1"/"yes" → true, "false"/"0"/"no" → false; null → false
k.coerce.string();   // 42 → "42", null → ""
k.coerce.date();     // ISO string or timestamp → Date
k.preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v), k.string().email());
```

Coerced schemas have every method of their target type.

## Async validation

```ts
const emailSchema = k.email().asyncRefine(async (value, path) => {
  const taken = await usersRepository.existsByEmail(value);   // repository call, never inline SQL
  return taken ? [{ path, message: 'Email already registered' }] : [];
});

await emailSchema.safeParseAsync(input);
```

- `parse()`/`safeParse()` on a schema with async validation (own or nested) **throws `KataxAsyncValidationRequiredError`** — they don't silently skip it.
- `validateSchema(schema, data)` (exported by katax-core) picks sync or async automatically; the generated `shared/api.utils.ts` wraps it.
- A DB check inside a validator is still a repository call. If it can fail (DB down), catch and return an issue rather than throwing.

## Errors

- `safeParse` → `{ success: true, data } | { success: false, issues: { path, message }[] }`.
- `parse` throws `KataxError` (`issues`, `message` = `path: message; ...`).
- Messages include the received type: `"Expected string, received number"`.
- Helpers: `createIssue(path, msg)`, `issues(path, msg)`, `mergeIssues(...)`, `isIssueArray(v)`, `describeReceived(v)`.
- Errors thrown inside your own `.transform()`/`.refine()` callbacks propagate (they're bugs); they're not turned into issues.

## Types

```ts
type User = kataxInfer<typeof userSchema>;
// optional keys are inferred as `key: T | undefined` (the key itself is not `?`)
```

Export inferred types from the validator and import them with `import type` in controllers. Response/view types are **not** inferred from validators: they live in `<resource>.types.ts`.

## JSON Schema — `toJsonSchema()`

Draft 2020-12 output, for **OpenAPI 3.1** and MCP tool `inputSchema`s (OpenAPI 3.0 can't represent `type: [..., "null"]`, `const`, `prefixItems`).

```ts
createHabitSchema.toJsonSchema();
// { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 120, description: 'Habit name.' }, ... }, required: ['name'] }
```

Mappings worth knowing (1.6.6+): `.integer()` → `type: "integer"`; `.nullable()` → `type: [T, "null"]` (or `anyOf` for enum/literal/union); `.optional()`/`.nullish()`/`.default()` → key not in `required`; `.strict()` → `additionalProperties: false`; union → `anyOf`; discriminated union → `oneOf` with the key pinned; recursive `k.lazy(fn, 'Name')` → `$anchor` + `$ref: "#Name"`. Runtime-only rules (`refine`, `asyncRefine`, `custom`, transforms, date comparisons, email domain rules, file/base64 checks) are not representable.

Never hand-write a second JSON Schema next to a validator — generate it (see `katax-mcp-server` → `inputSchema()`).

## Gotchas

- `.optional()` does not accept `null`; use `.nullish()` (see table).
- Query params are strings: `k.number()` on `req.query.page` always fails — use `k.coerce.number()`.
- Objects strip unknown keys by default (`.strict()` to reject, `.passthrough()` to keep).
- `.default()` applies only to `undefined`; `.catch()` replaces any failure (including wrong types).
- `k.enum()` takes string values only; use `k.literal()`/`k.union()` for numbers.
- `discriminatedUnion` takes a map `{ value: schema }`, not an array.
- `k.string().trim()` validates, it doesn't transform; use `k.preprocess` or `.transform` to trim.
