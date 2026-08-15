# katax-core — Validation Library

Zod-inspired schema validation for request bodies, env vars, and runtime type-checking. Lightweight with only `date-fns` as dependency. Full package docs also live in the standalone `katax-core` skill — this reference exists so `katax-ecosystem` alone (without loading `katax-core` too) still has the complete API.

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

## Core API — Schema Interface

Every schema implements:

```ts
Schema<T> {
  parse(input: unknown): T                              // Throws KataxError on failure
  safeParse(input: unknown): SafeParseResult<T>          // { success, data } | { success, issues }
  validate(input: unknown): ValidationResult             // { valid, issues }
  parseAsync(input: unknown): Promise<T>                 // Async parse
  safeParseAsync(input: unknown): Promise<AsyncSafeParseResult<T>>
  isValidAsync(input: unknown): Promise<AsyncValidationResult>
  hasAsyncValidation(): boolean
  refine(validator, message?): this                     // Custom refinement
  toJsonSchema(): JsonSchema                             // Convert to standard JSON Schema
  readonly kataxInfer: T                                 // Type inference helper
}
```

## Result Types

- `SafeParseResult<T>`: `{ success: true; data: T } | { success: false; issues: Issue[] }`
- `ValidationResult`: `{ valid: boolean; issues: Issue[] }`
- `AsyncSafeParseResult<T>`: Same as SafeParseResult but for async
- `AsyncValidationResult`: Same as ValidationResult but for async
- `Issue`: `{ path: (string | number)[]; message: string }`
- `KataxError`: Custom error class with `issues: Issue[]` property

## The k() API — All Factory Functions

```ts
const k = {
  // Primitives
  string, number, boolean, bigint, date, twoDates,
  nan, null, undefined, void,
  // Composites
  object, array, tuple, record,
  // Composition
  union, intersection, lazy, discriminatedUnion,
  // Special
  promise, set, map,
  email, file, base64,
  // Custom/Advanced
  custom, literal, enum, any, unknown, never,
  // Transformation
  coerce, preprocess
};
```

## String Schema — `k.string()`

| Method                      | Description                    |
| --------------------------- | ------------------------------ |
| `minLength(n, msg?)`        | Minimum character length       |
| `maxLength(n, msg?)`        | Maximum character length       |
| `length(n, msg?)`           | Exact character length         |
| `email(msg?)`               | Valid email format             |
| `url(msg?)`                 | Valid URL (URL constructor)    |
| `regex(pattern, msg?)`      | Match regex pattern            |
| `uuid(msg?)`                | Valid UUID (RFC 4122)          |
| `ip(msg?)`                  | Valid IPv4 address             |
| `datetime(msg?)`            | Valid ISO 8601 datetime        |
| `jwt(msg?)`                 | Valid JWT structure            |
| `cuid2(msg?)`               | Valid CUID2                    |
| `ulid(msg?)`                | Valid ULID                     |
| `emoji(msg?)`               | Valid emoji sequence           |
| `cidr(msg?)`                | Valid CIDR notation            |
| `startsWith(prefix, msg?)`  | Must start with string         |
| `endsWith(suffix, msg?)`    | Must end with string           |
| `includes(substr, msg?)`    | Must include substring         |
| `oneOf(options[], msg?)`    | Must be one of options         |
| `notOneOf(options[], msg?)` | Must not be one of options     |
| `lowercase(msg?)`           | Must be lowercase              |
| `uppercase(msg?)`           | Must be uppercase              |
| `alpha(msg?)`               | Only letters [A-Za-z]          |
| `alphanumeric(msg?)`        | Only letters and numbers       |
| `ascii(msg?)`               | Only ASCII characters          |
| `noWhitespace(msg?)`        | No whitespace allowed          |
| `nonempty(msg?)`            | Cannot be empty                |
| `trim(msg?)`                | No leading/trailing whitespace |

## Number Schema — `k.number()`

| Method                      | Description                |
| --------------------------- | --------------------------- |
| `min(value, msg?)`          | Minimum value (>=)         |
| `max(value, msg?)`          | Maximum value (<=)         |
| `equals(exact, msg?)`       | Exact value                |
| `positive(msg?)`            | Must be > 0                |
| `negative(msg?)`            | Must be < 0                |
| `nonnegative(msg?)`         | Must be >= 0               |
| `nonpositive(msg?)`         | Must be <= 0               |
| `integer(msg?)`             | Must be integer            |
| `finite(msg?)`              | Must be finite             |
| `multipleOf(factor, msg?)`  | Must be multiple of        |
| `between(min, max, msg?)`   | Between range (inclusive)  |
| `greaterThan(n, msg?)`      | Strictly > n               |
| `lessThan(n, msg?)`         | Strictly < n               |
| `notEqual(n, msg?)`         | Not equal to value         |
| `oneOf(options[], msg?)`    | Must be one of options     |
| `notOneOf(options[], msg?)` | Must not be one of options |

## Boolean Schema — `k.boolean()`

| Method                   | Description      |
| ------------------------ | ---------------- |
| `isTrue(msg?)`           | Must be true     |
| `isFalse(msg?)`          | Must be false    |
| `equals(expected, msg?)` | Must equal value |

## BigInt Schema - `k.bigint()`

Validates native JavaScript bigint values.

| Method                       | Description                  |
| ---------------------------- | ---------------------------- |
| `min(value, msg?)`           | Minimum value (>=)           |
| `max(value, msg?)`           | Maximum value (<=)           |
| `positive(msg?)`             | Must be > 0n                 |
| `negative(msg?)`             | Must be < 0n                 |
| `nonnegative(msg?)`          | Must be >= 0n                |
| `nonpositive(msg?)`          | Must be <= 0n                |
| `between(min, max, msg?)`    | Between range (inclusive)    |
| `multipleOf(factor, msg?)`   | Must be multiple of          |
| `equals(exact, msg?)`        | Exact value                  |
| `oneOf(options[], msg?)`     | Must be one of options       |
| `notOneOf(options[], msg?)`  | Must not be one of options   |

## Object Schema — `k.object(shape)`

```ts
const schema = k.object({
  name: k.string(),
  age: k.number().optional(),
});
```

| Method              | Description                    |
| ------------------- | ------------------------------ |
| `extend(extension)` | Add/override fields            |
| `merge(other)`      | Merge two object schemas       |
| `pick([keys])`      | Select specific fields         |
| `omit([keys])`      | Remove specific fields         |
| `partial()`         | Make all fields optional       |
| `strict()`          | No extra keys allowed (throws) |
| `passthrough()`     | Allow extra keys in output     |
| `strip()`           | Remove extra keys (default)    |
| `getShape()`        | Get raw shape object           |
| `caseInsensitive()` | Case-insensitive field lookup  |

## Array Schema — `k.array(elementSchema?)`

| Method                    | Description                          |
| ------------------------- | ------------------------------------- |
| `minLength(n, msg?)`      | Minimum array length                 |
| `maxLength(n, msg?)`      | Maximum array length                 |
| `min(n, msg?)`            | Alias for minLength                  |
| `max(n, msg?)`            | Alias for maxLength                  |
| `length(n, msg?)`         | Exact array length                   |
| `notEmpty(msg?)`          | Cannot be empty array                |
| `unique(msg?)`            | All elements unique (deep equality)  |
| `contains(element, msg?)` | Must contain element (deep equality) |

## Email Schema — `k.email()`

| Method                          | Description                          |
| -------------------------------- | ------------------------------------ |
| `domain(domain, msg?)`          | Restrict to specific domain          |
| `domains([domains], msg?)`      | Restrict to multiple domains         |
| `domainPattern(pattern, msg?)`  | Domain regex (`*.domain.com`)        |
| `notDomains([blacklist], msg?)` | Blacklist domains                    |
| `localMinLength(n, msg?)`       | Min length for local part            |
| `localMaxLength(n, msg?)`       | Max length for local part            |
| `localPattern(regex, msg?)`     | Pattern for local part               |
| `corporate(msg?)`               | Block free providers (Gmail, Yahoo…) |
| `noPlus(msg?)`                  | Disallow '+' addressing              |
| `noDots(msg?)`                  | Disallow '.' in local part           |

## Date Schema — `k.date()`

Input: ISO 8601 date strings. Output: Date object. Uses `date-fns`.

| Method                      | Description                          |
| --------------------------- | ------------------------------------ |
| `min(dateStr, msg?)`        | On or after date                     |
| `max(dateStr, msg?)`        | On or before date                    |
| `between(start, end, msg?)` | Between range (inclusive)            |
| `isFuture(msg?)`            | Must be in the future                |
| `isPast(msg?)`              | Must be in the past                  |
| `format(formatStr, msg?)`   | Must match specific format           |
| `isDateOnly(msg?)`          | Date only (YYYY-MM-DD)               |
| `hasTime(msg?)`             | Must include time component          |
| `formatOutput(format)`      | Transform output to formatted string |

## TwoDates Schema — `k.twoDates(separator?)`

Input: Two ISO dates separated by `separator` (default `'|'`). Output: `[Date, Date]`.

| Method                            | Description                     |
| ---------------------------------- | ------------------------------- |
| `maxDifference(days, msg?)`       | Max days apart                  |
| `minDifference(days, msg?)`       | Min days apart                  |
| `maxDifferenceHours(hours, msg?)` | Max hours apart                 |
| `minDifferenceHours(hours, msg?)` | Min hours apart                 |
| `order(ascending, msg?)`          | Chronological order enforcement |

## File Schema — `k.file()`

Works with Browser File API and Node.js Multer objects.

| Method                       | Description                           |
| ----------------------------- | -------------------------------------- |
| `maxSize(bytes, msg?)`       | Maximum file size                     |
| `minSize(bytes, msg?)`       | Minimum file size                     |
| `type(mimeType, msg?)`       | Exact MIME type                       |
| `types([mimeTypes], msg?)`   | Multiple MIME options                 |
| `typePattern(pattern, msg?)` | MIME pattern (`image/*`)              |
| `extension(ext, msg?)`       | File extension (.jpg)                 |
| `extensions([exts], msg?)`   | Multiple extensions                   |
| `namePattern(regex, msg?)`   | Filename regex                        |
| `image(msg?)`                | Shortcut: `image/*`                   |
| `video(msg?)`                | Shortcut: `video/*`                   |
| `audio(msg?)`                | Shortcut: `audio/*`                   |
| `document(msg?)`             | Shortcut: PDF, Word, Excel, plaintext |

## Base64 Schema — `k.base64()`

Input: Base64 string (optionally with data URL prefix). Browser + Node.js compatible.

| Method                           | Description                   |
| ---------------------------------- | ------------------------------ |
| `minDecodedSize(bytes, msg?)`    | Min decoded content size      |
| `maxDecodedSize(bytes, msg?)`    | Max decoded content size      |
| `mimeType(type, msg?)`           | Exact MIME from data URL      |
| `mimeTypePattern(pattern, msg?)` | MIME type pattern             |
| `dataUrl(msg?)`                  | Must be data URL (`data:...`) |
| `json(msg?)`                     | Decoded must be valid JSON    |
| `image(msg?)`                    | Shortcut: `image/*`           |
| `pdf(msg?)`                      | Shortcut: `application/pdf`   |

## Union, Intersection, Lazy

```ts
// Union — matches at least one schema (short-circuits on first match)
k.union([k.string(), k.number()]);

// Intersection — must match ALL schemas (merges objects)
k.intersection([k.object({ id: k.number() }), k.object({ name: k.string() })]);

// Lazy — deferred resolution for recursive types
const categorySchema = k.lazy(() =>
  k.object({
    name: k.string(),
    subcategories: k.array(categorySchema),
  })
);
```

## Literal, Enum, Tuple, Record

```ts
k.literal('active'); // Exact value (===)
k.enum(['active', 'inactive']); // String literal union
k.tuple([k.number(), k.string()]); // Fixed-length typed array
k.record(k.number()); // Record<string, number>
k.any(); // Accepts all (bypasses safety)
k.unknown(); // Accepts all (forces narrowing)
k.never(); // Never matches
```

## Custom Schema — `k.custom<T>(validator)`

```ts
const positiveEven = k.custom<number>((value, path) => {
  if (typeof value !== 'number') return [{ path, message: 'Must be number' }];
  if (value <= 0 || value % 2 !== 0) return [{ path, message: 'Must be positive even' }];
  return value;
});

// Add refinements
positiveEven.refine((v) => v < 1000, 'Must be less than 1000');
```

## Universal Modifiers (all schemas)

```ts
schema.optional()            // T | undefined
schema.nullable()            // T | null
schema.nullish()             // T | null | undefined
schema.default(42)           // Returns default if undefined
schema.catch(42)             // Fallback on parse failure
schema.transform((v) => ...) // Transform output type
schema.brand("Name")         // Nominal typing (T & { __brand: Name })
schema.refine(validator, msg?) // Custom refinement
schema.describe(text)        // Sets JSON Schema description (see toJsonSchema())
```

## Coercion — `k.coerce`

Auto-converts before validation:

```ts
k.coerce.number(); // "42" → 42, true → 1
k.coerce.boolean(); // "true"/"1"/"yes"/"on" → true, "false"/"0"/"no"/"off" → false
k.coerce.string(); // 42 → "42", null → ""
k.coerce.date(); // ISO string → Date, timestamp → Date
```

All coerced schemas inherit their base schema methods.

## Preprocess — `k.preprocess(fn, schema)`

Transform input BEFORE validation:

```ts
k.preprocess(
  (val) => (typeof val === 'string' ? val.trim().toLowerCase() : val),
  k.string().email()
);
```

## Error Utilities

```ts
import { createIssue, issues, mergeIssues, isIssueArray, describeReceived } from 'katax-core';

createIssue(['field'], 'error message');  // Single issue
issues(['field'], 'error message');       // Issue[]
mergeIssues(arr1, arr2);                  // Merge issue arrays
isIssueArray(value);                      // Type guard
describeReceived(value);                  // 'null' | 'undefined' | 'array' | typeof value
```

Error messages now include the received type:
```
"Expected string, received number"
"Expected object, received null"
"Expected an array, received string"
```

## Async Validation

```ts
const usernameSchema = k
  .string()
  .minLength(3)
  .asyncRefine(async (value) => {
    const exists = await usersRepo.existsByUsername(value);
    return exists ? [{ path: ['username'], message: 'Already taken' }] : [];
  });

const result = await usernameSchema.safeParseAsync(input);
```

## Express Validation Pattern

```ts
function validate<T>(schema: { safeParse(v: unknown): any }) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ errors: result.issues });
    }
    req.body = result.data;
    next();
  };
}
```

## API Example — Email + File + Base64

```ts
const profileSchema = k
  .object({
    email: k.email().corporate().noPlus(),
    avatar: k
      .file()
      .image()
      .maxSize(5 * 1024 * 1024),
    resume: k
      .base64()
      .pdf()
      .maxDecodedSize(10 * 1024 * 1024),
    birthdate: k.date().isPast().isDateOnly(),
  })
  .strict();
```

## JSON Schema Conversion — `schema.toJsonSchema()`

Every schema (all ~22 `BaseSchema` implementations — primitives, `object`, `array`, `union`, `intersection`, `discriminatedUnion`, `lazy`, and wrapper schemas like `optional`/`nullable`/`default`/`catch`/`branded`) implements `toJsonSchema(): JsonSchema`, converting the validator into a standard JSON Schema object. No arguments:

```ts
const CreateUserSchema = k.object({
  email: k.email().describe('User email address'),
  name: k.string().minLength(2).maxLength(100),
});

const jsonSchema = CreateUserSchema.toJsonSchema();
// { type: 'object', properties: { email: {...}, name: {...} }, required: [...] }
```

`.describe(text)` sets the JSON Schema's `description` field. Wrapper modifiers (`optional()`, `nullable()`, `default()`, `catch()`, `brand()`) merge their own JSON Schema fragment on top of the inner schema's output, so `toJsonSchema()` reflects the full modifier chain.

Direct use case in this ecosystem: bridging a katax-core validator into MCP tool `inputSchema` definitions without hand-writing a second, parallel schema — see the `katax-mcp-server` skill for the concrete `toPublicInputSchema()` pattern built on top of this.

## Validation Gotchas

- Always validate `req.body` with `.safeParse()`
- Use `coerce` for query params (strings → numbers/booleans)
- Use `asyncRefine` for database checks (unique username, etc.)
- Use `nullish()` when a field accepts both `null` and `undefined`
- Prefer `minLength`/`maxLength` for strings
- Use `k.discriminatedUnion()` over `k.union()` for tagged object types (faster O(1) dispatch)
- `.brand()` provides nominal typing at compile time; runtime `__brand` only set on objects
- `k.nan()` only matches `NaN` (use `k.void()` to accept both null and undefined)
- `k.promise()` without a wrapped schema just checks `instanceof Promise`
- `k.bigint()` validates native `bigint` values — does NOT coerce from strings/numbers
- `parse()` throws `KataxError` on failure — use `safeParse()` for graceful handling
- Object schema default is `strip()` (removes unknown keys) — use `.strict()` to throw or `.passthrough()` to keep them
- Async schemas need `safeParseAsync()` — calling `safeParse()` on them silently skips async refinements
- `k.array()` without element schema creates an untyped array — always specify element type
