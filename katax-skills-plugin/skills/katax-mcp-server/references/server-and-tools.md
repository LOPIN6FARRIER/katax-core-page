# MCP Server & Tools Registry

Reference architecture from the real katax APIs that expose MCP servers (`api-habit-forge` — newest, the reference —, `api-my-routine`, `api-second-brain`, `api-property-scout`).

## SDK Setup (`src/mcp/mcp.server.ts`)

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { katax } from 'katax-service-manager';
import { habitTools } from './tools/habits.tools.js';
import type { McpTool } from './tools/tool.types.js';
import type { McpIdentity } from './mcp.types.js';

export const allTools: McpTool[] = [...habitTools /* , ...otherTools */];

// Shown to the model once per connection: domain rules, tone, date conventions.
const SERVER_INSTRUCTIONS =
  'Habit Forge is a personal habit app: kind wording, no guilt. Dates are the user\'s local YYYY-MM-DD. ' +
  'Talk to the user in Spanish unless they write otherwise.';

export function createMcpServer(identity: McpIdentity): Server {
  const server = new Server(
    { name: 'habit-forge-mcp', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as never,
      annotations: { readOnlyHint: tool.readOnly, destructiveHint: false, openWorldHint: false }
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = allTools.find((t) => t.name === request.params.name);
    if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }] };
    try {
      const args = (request.params.arguments as Record<string, unknown> | undefined) ?? {};
      const result = await tool.handler(args, identity);
      // data may be undefined: JSON.stringify(undefined) is not a string -> always send null
      const payload = result.success
        ? { message: result.message, data: result.data ?? null }
        : { error: result.error, message: result.message, details: result.details };
      return { isError: !result.success, content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    } catch (error) {
      katax.logger.error({ err: error, message: 'MCP tool execution failed', tool: request.params.name, userId: identity.userId });
      return { isError: true, content: [{ type: 'text', text: 'Internal error executing tool' }] };
    }
  });

  return server;
}
```

- `readOnly` on each tool → `annotations.readOnlyHint` (clients skip confirmation prompts for reads).
- Errors inside tools never return raw messages (same rule as REST: controllers already use `toSafeErrorResult`).

## Transport — stateless (recommended)

```ts
// src/mcp/mcp.routes.ts
router.post('/', mcpLimiter, requireMcpAuth, async (req, res) => {
  const identity = (req as McpRequest).mcpIdentity!;
  try {
    const server = createMcpServer(identity);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    katax.logger.error({ err: error, message: 'MCP request handling failed' });
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  }
});

// Without sessions there are no server-initiated streams (GET) or session teardown (DELETE)
const methodNotAllowed = (_req: Request, res: Response) => {
  res.setHeader('Allow', 'POST');
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
};
router.get('/', mcpLimiter, requireMcpAuth, methodNotAllowed);
router.delete('/', mcpLimiter, requireMcpAuth, methodNotAllowed);
```

Every POST gets its own `Server` + transport and no `Mcp-Session-Id` is issued: nothing is lost on restart/deploy, it works with several PM2 instances, and the identity comes from the bearer token on each request.

Older APIs (api-second-brain, api-property-scout) keep a `Map<sessionId, { server, transport }>`; that map doesn't survive restarts and breaks across instances. Migrate to the stateless version unless you actually need server → client notifications.

## Tools Registry

One file per domain in `src/mcp/tools/<domain>.tools.ts`, shared helpers in `tool.types.ts` / `tool.utils.ts`. A tool's handler re-validates with the **same `validate*` function the REST handler uses** and calls the **same controller**: business logic is written once, REST and MCP are two transports in front of it.

```ts
// src/mcp/tools/tool.types.ts
import type { ControllerResult } from '../../shared/api.utils.js';
import type { McpIdentity } from '../mcp.types.js';

export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema of the arguments shown to the client (built from the katax-core validators). */
  inputSchema: Record<string, unknown>;
  /** true = never changes anything (sent as annotations.readOnlyHint). */
  readOnly: boolean;
  handler: (args: Record<string, unknown>, identity: McpIdentity) => Promise<ControllerResult>;
}

export type JsonSchemaObject = { properties?: Record<string, unknown>; required?: string[] } & Record<string, unknown>;

export interface ExtraProperty {
  type: string;
  description: string;
  [key: string]: unknown;
}
```

```ts
// src/mcp/tools/tool.utils.ts
import { createResponse } from '../../shared/api.utils.js';
import type { ControllerResult, ValidationResult } from '../../shared/api.utils.js';
import type { ExtraProperty, JsonSchemaObject } from './tool.types.js';

/**
 * Tool inputSchema from one or more katax object schemas (their .describe()
 * texts become the field docs) plus hand-written extras such as the `id`
 * that REST takes from the URL. Server-injected fields (user_id) are never
 * part of these schemas: the identity comes from the bearer token.
 */
export function inputSchema(
  extra: Record<string, ExtraProperty> = {},
  ...schemas: Array<{ toJsonSchema(): unknown }>
): Record<string, unknown> {
  const properties: Record<string, unknown> = { ...extra };
  const required = new Set<string>(Object.keys(extra));
  for (const schema of schemas) {
    const json = schema.toJsonSchema() as JsonSchemaObject;
    Object.assign(properties, json.properties ?? {});
    for (const key of json.required ?? []) required.add(key);
  }
  return { type: 'object', properties, ...(required.size > 0 ? { required: [...required] } : {}), additionalProperties: false };
}

export const uuidProp = (description: string): ExtraProperty => ({ type: 'string', format: 'uuid', description });

export function pick(args: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => k in args).map((k) => [k, args[k]]));
}

export function omit(args: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([k]) => !keys.includes(k)));
}

/** Re-validates the tool args with the SAME validate* function the REST handler uses, then calls the controller. */
export async function withValid<T>(
  validate: (data: unknown) => Promise<ValidationResult<T>>,
  data: unknown,
  fn: (value: T) => Promise<ControllerResult>
): Promise<ControllerResult> {
  const result = await validate(data);
  if (!result.isValid || result.data === undefined) return createResponse.validation(result.errors ?? []);
  return fn(result.data);
}
```

```ts
// src/mcp/tools/habits.tools.ts
import { archiveHabit, createHabit, getHabit, listHabits, updateHabit } from '../../api/habits/habits.controller.js';
import {
  createHabitSchema, listHabitsQuerySchema, updateHabitSchema,
  validateCreateHabit, validateHabitIdParam, validateListHabitsQuery, validateUpdateHabit
} from '../../api/habits/habits.validator.js';
import { inputSchema, omit, pick, uuidProp, withValid } from './tool.utils.js';
import type { McpTool } from './tool.types.js';

const habitId = { id: uuidProp('ID of the habit.') };

export const habitTools: McpTool[] = [
  {
    name: 'habit_list',
    description: 'List the user\'s habits. Active ones by default; active=false for archived. Paginated (page).',
    readOnly: true,
    inputSchema: inputSchema({}, listHabitsQuerySchema),
    handler: (args, identity) => withValid(validateListHabitsQuery, args, (q) => listHabits(identity.userId, q))
  },
  {
    name: 'habit_create',
    description: 'Create a habit. Only name is required; omit (or send null) any optional field you don\'t want to set.',
    readOnly: false,
    inputSchema: inputSchema({}, createHabitSchema),
    handler: (args, identity) => withValid(validateCreateHabit, args, (input) => createHabit(identity.userId, input))
  },
  {
    name: 'habit_update',
    description: 'Update a habit: only the fields you send change. reward / tiny_action accept null to remove them.',
    readOnly: false,
    inputSchema: inputSchema(habitId, updateHabitSchema),
    handler: (args, identity) =>
      withValid(validateHabitIdParam, pick(args, ['id']), (p) =>
        withValid(validateUpdateHabit, omit(args, ['id']), (input) => updateHabit(identity.userId, p.id, input))
      )
  },
  {
    name: 'habit_archive',
    description: 'Archive a habit (it can be restored later).',
    readOnly: false,
    inputSchema: inputSchema(habitId),
    handler: (args, identity) => withValid(validateHabitIdParam, args, (p) => archiveHabit(identity.userId, p.id))
  }
];
```

(Compiled and checked: `habit_update`'s schema comes out as `required: ["id"]` with `type: ["string", "null"]` for the clearable fields.)

## null from MCP clients

Claude and other MCP clients routinely send `null` for optional arguments they don't want to set. Two pieces handle it (details in `katax-ecosystem/references/api-architecture.md`):

1. Optional fields are `.nullish()` in the validator, so `null` validates.
2. `validateNormalized(schema, data, CLEARABLE)` turns `null` into `undefined` ("not provided") except for the fields in the `CLEARABLE` list, where `null` means "remove the value".

Describe it in the tool `description` ("reward accepts null to remove it") so the model uses it on purpose.

**katax-core version**: use `katax-core ^1.6.6`. On ≤ 1.6.5, `.nullish()` fields were listed as `required` in `toJsonSchema()` and lacked the `null` type, so clients thought they had to send them.

## Older bridge — `toPublicInputSchema()`

APIs whose validators include a server-injected field (`user_id`/`usuario_id`, filled from the identity) strip it before showing the schema:

```ts
export function toPublicInputSchema(schema: { toJsonSchema(): unknown }, omit: string[] = ['user_id']): Record<string, unknown> {
  const raw = schema.toJsonSchema() as { properties?: Record<string, unknown>; required?: string[] };
  const jsonSchema = { ...raw, properties: { ...raw.properties } };
  for (const key of omit) delete jsonSchema.properties[key];
  jsonSchema.required = (raw.required ?? []).filter((field) => !omit.includes(field));
  return jsonSchema;
}
```

New code shouldn't need it: keep `user_id` out of request schemas entirely and pass `identity.userId` as a separate controller argument (`createHabit(identity.userId, input)`), exactly like REST passes `req.user!.id`.
