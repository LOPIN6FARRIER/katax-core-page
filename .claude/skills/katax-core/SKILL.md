---
name: katax-core
description: 'Lightweight and extensible schema validation library for TypeScript/JavaScript. Use when: validating request bodies, parsing environment variables, runtime type-checking, building type-safe APIs, defining complex validation schemas with async refinements.'
argument-hint: 'What kind of validation are you working on? (body/query/params/env/file/async)'
---

# katax-core — Schema Validation

Zod-inspired validation library for TypeScript with zero runtime dependencies (except `date-fns`). Part of the [Katax ecosystem](https://github.com/LOPIN6FARRIER/katax-core).

**Version: 1.6.5**

## Quick Start

```ts
import { k, type kataxInfer } from 'katax-core';

const UserSchema = k.object({
  email: k.email(),
  name: k.string().minLength(2).maxLength(100),
  age: k.number().min(18).optional(),
});

type User = kataxInfer<typeof UserSchema>;

const result = UserSchema.safeParse(req.body);
if (!result.success) {
  return res.status(400).json({ errors: result.issues });
}
```

## Core Interface

Every schema implements `Schema<T>`:

```ts
Schema<T> {
  parse(input: unknown): T                              // Throws KataxError
  safeParse(input: unknown): SafeParseResult<T>          // { success, data } | { success, issues }
  validate(input: unknown): ValidationResult             // { valid, issues }
  parseAsync(input: unknown): Promise<T>
  safeParseAsync(input: unknown): Promise<AsyncSafeParseResult<T>>
  isValidAsync(input: unknown): Promise<AsyncValidationResult>
  hasAsyncValidation(): boolean
  refine(validator, message?): this                     // Custom refinement
  toJsonSchema(): JsonSchema                             // Convert to standard JSON Schema
  readonly kataxInfer: T
}
```

### Result Types

| Type | Shape |
|------|-------|
| `SafeParseResult<T>` | `{ success: true; data: T } \| { success: false; issues: Issue[] }` |
| `ValidationResult` | `{ valid: boolean; issues: Issue[] }` |
| `AsyncSafeParseResult<T>` | Same as SafeParseResult but for async |
| `AsyncValidationResult` | Same as ValidationResult but for async |
| `Issue` | `{ path: (string \| number)[]; message: string }` |
| `KataxError` | Custom error with `issues: Issue[]` property |

## The `k()` API — Factory Functions

```ts
const k = {
  // Primitives
  string, number, boolean, bigint, date, twoDates,
  nan, null, undefined, void: voidSchema,
  // Composites
  object, array, tuple, record,
  // Composition
  union, intersection, lazy, discriminatedUnion,
  // Wrappers
  promise, set, map,
  // Special
  email, file, base64,
  // Custom/Advanced
  custom, literal, enum, any, unknown, never,
  // Transformation
  coerce, preprocess,
};
```

## String Schema — `k.string()`

```ts
k.string()
  .minLength(n, msg?)   .maxLength(n, msg?)    .length(n, msg?)
  .email(msg?)          .url(msg?)              .regex(pattern, msg?)
  .uuid(msg?)           .ip(msg?)               .datetime(msg?)
  .jwt(msg?)            .cuid2(msg?)            .ulid(msg?)
  .emoji(msg?)          .cidr(msg?)             .startsWith(prefix, msg?)
  .endsWith(suffix)     .includes(substr)       .oneOf(options[], msg?)
  .notOneOf(options[])  .lowercase(msg?)        .uppercase(msg?)
  .alpha(msg?)          .alphanumeric(msg?)     .ascii(msg?)
  .noWhitespace(msg?)   .nonempty(msg?)         .trim(msg?)
```

## Number Schema — `k.number()`

```ts
k.number()
  .min(n, msg?)         .max(n, msg?)           .equals(exact, msg?)
  .positive(msg?)       .negative(msg?)         .nonnegative(msg?)
  .nonpositive(msg?)    .integer(msg?)          .finite(msg?)
  .multipleOf(n, msg?)  .between(min, max, msg?)
  .greaterThan(n)       .lessThan(n)            .notEqual(n)
  .oneOf(options[])     .notOneOf(options[])
```

## Boolean Schema — `k.boolean()`

```ts
k.boolean()
  .isTrue(msg?)         .isFalse(msg?)          .equals(expected, msg?)
```

## Primitive Schemas

```ts
k.nan()               // only NaN
k.null()              // only null
k.undefined()         // only undefined
k.void()              // null | undefined
```

## BigInt Schema — `k.bigint()`

Validates JavaScript `bigint` values.

```ts
k.bigint()
  .min(n)           .max(n)             .positive()
  .negative()       .nonnegative()      .nonpositive()
  .between(min, max)  .multipleOf(factor)
  .equals(exact)    .oneOf([])          .notOneOf([])
```

## Object Schema — `k.object(shape)`

```ts
k.object({ name: k.string(), age: k.number().optional() })
  .extend(extension)    .merge(other)         .pick([keys])
  .omit([keys])         .partial()            .strict()
  .passthrough()        .strip()              .getShape()
  .caseInsensitive()
```

## Array Schema — `k.array(elementSchema?)`

```ts
k.array(k.string())
  .minLength(n)         .maxLength(n)          .length(n)
  .min(n)               .max(n)                .notEmpty()
  .unique()             .contains(element)
```

## Email Schema — `k.email()`

```ts
k.email()
  .domain(domain)       .domains([domains])    .domainPattern(pattern)
  .notDomains([list])   .localMinLength(n)     .localMaxLength(n)
  .localPattern(regex)  .corporate()           .noPlus()
  .noDots()
```

## Date Schema — `k.date()`

Parses ISO 8601 strings → `Date` objects. Uses `date-fns`.

```ts
k.date()
  .min(dateStr)         .max(dateStr)          .between(start, end)
  .isFuture()           .isPast()              .format(formatStr)
  .isDateOnly()         .hasTime()             .formatOutput(format)
```

## TwoDates Schema — `k.twoDates(separator?)`

Input: Two ISO dates separated by `separator` (default `|`). Output: `[Date, Date]`.

```ts
k.twoDates()
  .maxDifference(days)      .minDifference(days)
  .maxDifferenceHours(h)    .minDifferenceHours(h)
  .order(ascending?)
```

## File Schema — `k.file()`

Works with Browser File API and Node.js Multer.

```ts
k.file()
  .maxSize(bytes)     .minSize(bytes)       .type(mimeType)
  .types([mimes])     .typePattern(pattern) .extension(ext)
  .extensions([exts]) .namePattern(regex)   .image()  .video()
  .audio()            .document()
```

## Base64 Schema — `k.base64()`

```ts
k.base64()
  .minDecodedSize(n)  .maxDecodedSize(n)    .mimeType(type)
  .mimeTypePattern(p) .dataUrl()            .json()
  .image()            .pdf()
```

## Promise, Set, Map

```ts
k.promise()                   // validates input is a Promise
k.promise(k.number())         // also validates resolved value
k.set(k.number())             // validates each element of a Set
k.map(k.string(), k.number()) // validates keys and values of a Map
```

## Discriminated Union

O(1) dispatch by a discriminator key. Use instead of `union()` for tagged object types.

```ts
k.discriminatedUnion("type", {
  cat: k.object({ type: k.literal("cat"), meow: k.boolean() }),
  dog: k.object({ type: k.literal("dog"), bark: k.boolean() }),
});
```

## Branded Types

Add nominal typing with `.brand()`. Returns `T & { __brand: B }`.

```ts
const userId = k.string().brand("UserId");
```

## Composition

```ts
// Union — matches first matching schema
k.union([k.string(), k.number()]);

// Intersection — MUST match ALL schemas
k.intersection([k.object({ id: k.number() }), k.object({ name: k.string() })]);

// Lazy — recursive types
const category = k.lazy(() => k.object({ name: k.string(), sub: k.array(category) }));
```

## Literal, Enum, Tuple, Record

```ts
k.literal('active');           // Exact value (===)
k.enum(['a', 'b']);            // String literal union
k.tuple([k.number(), k.string()]); // Fixed-length typed array
k.record(k.number());          // Record<string, number>
k.any();                       // Accepts everything
k.unknown();                   // Accepts all, forces narrowing
k.never();                     // Never matches
```

## Custom Schema — `k.custom<T>(validator)`

```ts
const positiveEven = k.custom<number>((value, path) => {
  if (typeof value !== 'number') return [{ path, message: 'Not a number' }];
  if (value <= 0 || value % 2 !== 0) return [{ path, message: 'Not a positive even' }];
  return value;
});
positiveEven.refine((v) => v < 1000, 'Must be less than 1000');
```

## Universal Modifiers (all schemas)

```ts
schema.optional()            // T | undefined
schema.nullable()            // T | null
schema.nullish()             // T | null | undefined
schema.default(42)           // Return default if undefined/null
schema.catch(42)             // Fallback on parse failure
schema.transform((v) => ...) // Transform output type
schema.brand("Name")         // Nominal typing (T & { __brand: Name })
schema.refine(validator, msg?) // Custom synchronous refinement
```

## Coercion — `k.coerce`

Auto-converts before validation:

```ts
k.coerce.number();    // "42" → 42, true → 1
k.coerce.boolean();   // "true"/"1"/"yes" → true
k.coerce.string();    // 42 → "42", null → ""
k.coerce.date();      // ISO string → Date, timestamp → Date
```

## Preprocess — `k.preprocess(fn, schema)`

Transform input BEFORE validation:

```ts
k.preprocess(
  (val) => typeof val === 'string' ? val.trim().toLowerCase() : val,
  k.string().email()
);
```

## Async Validation

```ts
const usernameSchema = k
  .string().minLength(3)
  .asyncRefine(async (value) => {
    const exists = await usersRepo.existsByUsername(value);
    return exists ? [{ path: ['username'], message: 'Already taken' }] : [];
  });

const result = await usernameSchema.safeParseAsync(input);
```

## Error Utilities

```ts
import { createIssue, issues, mergeIssues, isIssueArray, describeReceived } from 'katax-core';

createIssue(['field'], 'msg'); // → Issue
issues(['field'], 'msg');      // → Issue[]
mergeIssues(a, b);             // → Issue[]
isIssueArray(v);               // → boolean
describeReceived(v);           // → 'null' | 'undefined' | 'array' | typeof v
```

Error messages now include the received type automatically:
```
"Expected string, received number"
"Expected object, received null"
"Expected an array, received string"
```

## Express Middleware Pattern

```ts
function validate<T>(schema: { safeParse(v: unknown): any }) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) return res.status(400).json({ errors: result.issues });
    req.body = result.data;
    next();
  };
}
```

## Type Inference

```ts
const UserSchema = k.object({ email: k.email(), name: k.string() });
type User = kataxInfer<typeof UserSchema>;
// { email: string; name: string }
```

## JSON Schema Conversion — `schema.toJsonSchema()`

Every schema (every class extending `BaseSchema`, ~22 implementations — primitives, `object`, `array`, `union`, `intersection`, `discriminatedUnion`, `lazy`, and all wrapper schemas like `optional`/`nullable`/`default`/`catch`/`branded`) implements `toJsonSchema(): JsonSchema`, converting the validator into a standard JSON Schema object. No arguments — call it directly on any schema instance:

```ts
const CreateUserSchema = k.object({
  email: k.email().describe('User email address'),
  name: k.string().minLength(2).maxLength(100),
});

const jsonSchema = CreateUserSchema.toJsonSchema();
// { type: 'object', properties: { email: {...}, name: {...} }, required: [...] }
```

`.describe(text)` (a universal modifier, works on any schema) sets the JSON Schema's `description` field — useful for documenting fields that end up in generated JSON Schema (e.g. MCP tool `inputSchema`, OpenAPI). Wrapper modifiers (`optional()`, `nullable()`, `default()`, `catch()`, `brand()`) merge their own JSON Schema fragment on top of the inner schema's output (e.g. `default()` adds a `default` key), so `toJsonSchema()` reflects the full modifier chain, not just the base type.

Common use: bridging a katax-core validator directly into a JSON-Schema-consuming API (MCP tool definitions, OpenAPI specs) without hand-writing a second, parallel schema — see the `katax-mcp-server` skill for the concrete pattern (`toPublicInputSchema()` wrapping `toJsonSchema()` to strip server-injected fields before exposing it to a client).

## Common Gotchas

- `parse()` throws `KataxError` on failure — use `safeParse()` for graceful handling
- Object schema default is `strip()` (removes unknown keys) — use `.strict()` to throw or `.passthrough()` to keep them
- `coerce` transforms before validation — all coerced schemas inherit their base methods
- Async schemas need `safeParseAsync()` — calling `safeParse()` on them silently skips async refinements
- `k.array()` without element schema creates an untyped array — always specify element type
- `k.email()` is more configurable than `k.string().email()` — use it when you need domain restrictions
- File validation works in both browser (FormData/File) and Node.js (Multer)
- The `catch()` modifier provides a fallback on parse failure (unlike `default()` which only applies to undefined/null)
- `k.bigint()` validates native `bigint` values — does NOT coerce from strings/numbers
- `nullish()` combines both `.nullable()` and `.optional()` — accepts both `null` and `undefined`

### AI Agent Skill

Install the [katax-ecosystem AI agent skill](https://skills.sh/LOPIN6FARRIER/katax-service-manager) for enhanced IDE assistance across all Katax packages:

[![skills.sh](https://skills.sh/b/LOPIN6FARRIER/katax-service-manager)](https://skills.sh/LOPIN6FARRIER/katax-service-manager)

```bash
npx skills add LOPIN6FARRIER/katax-service-manager
```

Compatible with Claude Code, Cursor, Windsurf, GitHub Copilot, and other AI coding agents.
