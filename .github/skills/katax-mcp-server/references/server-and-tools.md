# MCP Server & Tools Registry

Reference architecture from two real katax-based APIs that expose themselves as MCP servers for Claude/Claude.ai connectors (`api-property-scout`, `api-second-brain`). Both converge on the same shape independently, which is why this is documented as one canonical pattern rather than two examples.

## SDK Setup

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export function createMcpServer(identity: McpIdentity) {
  const server = new Server(
    { name: 'my-api-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = toolMap.get(request.params.name);
    if (!tool) throw new Error(`Unknown tool: ${request.params.name}`);
    const result = await tool.handler(request.params.arguments ?? {}, identity);
    return {
      content: [{ type: 'text', text: JSON.stringify(result.data ?? result) }],
      isError: result.success === false,
    };
  });

  return server;
}
```

File location convention: `src/mcp/mcp.server.ts`.

## Transport & Session Handling

Mounted as an Express router at `/api/mcp`, handling `POST`/`GET`/`DELETE` on `/`:

```ts
const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();

router.post('/', requireMcpAuth, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  let entry = sessionId ? sessions.get(sessionId) : undefined;
  if (!entry) {
    const server = createMcpServer(req.mcpIdentity);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    await server.connect(transport);
    entry = { server, transport };
    sessions.set(transport.sessionId!, entry);
  }
  await entry.transport.handleRequest(req, res, req.body);
});
```

⚠️ **Known limitation, present in both reference repos, not fixed**: `sessions` is a plain in-memory `Map` keyed by the `Mcp-Session-Id` header. It does **not** survive a process restart and does **not** scale across multiple instances (each instance has its own map — a client's persistent connection will break if load-balanced to a different instance mid-session). This is acceptable for a single-instance PM2 deployment (the standard katax deploy target) but is a real constraint to flag if the app ever needs horizontal scaling — would need a shared session store (Redis) or sticky sessions at the load balancer.

## Tools Registry

```ts
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, identity: McpIdentity) => Promise<ControllerResult>;
}
```

One file per domain, `src/mcp/tools/<domain>.tools.ts`:

```ts
// src/mcp/tools/listings.tools.ts
export const listingsTools: McpTool[] = [
  {
    name: 'listing_list',
    description: 'List property listings matching filters',
    inputSchema: toPublicInputSchema(listingsQuerySchema),
    handler: async (args, identity) => {
      const validated = validateSchema(listingsQuerySchema, { ...args, usuario_id: identity.userId });
      if (!validated.isValid) return createResponse.validation(validated.errors);
      return getListings(validated.data); // ← same controller function the REST route uses
    },
  },
  // ...
];
```

Aggregated in `mcp.server.ts`:

```ts
const allTools: McpTool[] = [...listingsTools, ...watchlistTools, ...coloniasTools, ...configTools];
const toolMap = new Map(allTools.map((t) => [t.name, t]));
```

**Core principle**: the `handler` re-validates `args` and then delegates to the **same controller function the REST route calls** (`getListings()`, `createNode()`, etc.) — business logic is written once; REST and MCP are just two transports in front of it. Don't reimplement logic inside a tool handler.

## Schema Bridge — `toPublicInputSchema()`

The direct katax-core ↔ MCP link. One validator schema drives both REST-body validation and the MCP tool's JSON Schema — no duplicated schema maintained by hand.

```ts
// src/mcp/mcp-schema.utils.ts
export function toPublicInputSchema(
  schema: { toJsonSchema(): unknown },
  omit: string[] = ['user_id'],
): Record<string, unknown> {
  const raw = schema.toJsonSchema() as { properties?: Record<string, unknown>; required?: string[] };
  const jsonSchema = { ...raw, properties: { ...raw.properties } };
  for (const key of omit) delete jsonSchema.properties[key];
  jsonSchema.required = (raw.required ?? []).filter((field) => !omit.includes(field));
  return jsonSchema;
}
```

Usage:

```ts
inputSchema: toPublicInputSchema(CreateNodeSchema) // omits 'user_id' by default
inputSchema: toPublicInputSchema(listingsQuerySchema, ['usuario_id']) // custom field name to omit
```

Why the `omit` step matters: the schema used for REST validation typically includes server-injected fields (`user_id`/`usuario_id`) that get populated from the authenticated identity, never supplied by the client — those must **not** appear in the JSON Schema shown to an MCP client, or the client will try (and be allowed) to supply/spoof them. See the `katax-core` skill (or `katax-ecosystem/references/katax-core.md`) for the full `toJsonSchema()` API this wraps — it's real, universal API surface on every katax-core schema, not something MCP-specific.

Because the REST validator and the MCP tool's `inputSchema` are generated from the exact same object, they can't drift apart — a bug in the validator is automatically visible (and fixed) in both places at once. This is a deliberate advantage of the pattern, not an accidental coupling.
