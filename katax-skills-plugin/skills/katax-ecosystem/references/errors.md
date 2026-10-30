# Errors and the response contract

Expected failures are typed `AppError`s with a message written for the client; everything else is logged with
context and answered with a generic 500. katax-cli generates `shared/errors.utils.ts` and `shared/api.utils.ts`
with this contract; the rules below are how controllers use it.

## The contract

```json
{ "success": false, "message": "Status must be one of: draft, active, done.", "error": "VALIDATION_ERROR",
  "details": [{ "field": "status", "message": "Status must be one of: draft, active, done." }] }
```

- Validation: 422, `details` is `[{ field, message }]` with the dotted path (`schedule.weekdays`).
- Someone else's resource: 404, never 403 (don't confirm it exists).
- A validator that itself fails (database down inside an `asyncRefine`): 500, not 422.

## In controllers

```ts
import { notFoundError, conflictError, forbiddenError } from '../../shared/errors.utils.js';
import { isUniqueViolation } from '../../shared/db-errors.js';

export async function createProject(userId: string, input: CreateProjectInput): Promise<ControllerResult<ProjectView>> {
  try {
    if (!(await plansRepository.canCreateProject(userId))) throw forbiddenError('Your plan does not allow more projects');
    const row = await projectsRepository.insertProject({ userId, name: input.name, slug: input.slug });
    return createResponse.success('Project created', toView(row), 201);
  } catch (error) {
    if (isUniqueViolation(error, 'projects_slug_key')) return toSafeErrorResult(conflictError('That slug is taken'));
    return toSafeErrorResult(error, { context: 'projects.create', userId });
  }
}
```

- Throw the `AppError` where the failure is detected (repository returns `null` -> controller throws
  `notFoundError`; a service that finds a conflict throws `conflictError`). Never decide the status by comparing
  `error.message` text (`includes('not empty')`, `=== 'Forbidden'`): wording changes and the check silently breaks.
- Translate database constraint errors by code (`isUniqueViolation`, `isForeignKeyViolation`), never by message.
- Business codes beyond the standard ones (`REVISION_CONFLICT`, `PLAN_LIMIT`) go in `new AppError(message, status,
  code)`; the front end switches on `error`, not on `message`.
- `toSafeErrorResult(error, { context, userId, ...ids })` in every `catch`. The context string is how you find the
  log line.

## Outside controllers

- `sendResponse` has its own `catch` (validator or controller threw), and `errorMiddleware` is the last resort;
  both answer the generic body.
- Express 4 does not forward rejected promises from async middleware: `import './shared/async-errors.js'` is the
  first line of `app.ts` (katax-cli generates it).
- `shared/sanitize.utils.ts` (generated) is a last line of defence: it detects technical text (SQL, `ECONNREFUSED`,
  stack traces, hostnames, file paths) in a message about to be sent and replaces it with the generic one. It is a
  net, not a reason to pass `error.message` around.

## Prohibited

- `createResponse.error('Failed', error instanceof Error ? error.message : '...', 500)` and any other way of
  putting a driver message, stack or SQL in a response.
- `res.status(...).json(...)` in a controller.
