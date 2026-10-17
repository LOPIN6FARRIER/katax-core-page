# Well-Known Discovery & the Anti-Pattern to Avoid

## Well-Known Discovery Endpoints

MCP clients auto-discover an API's OAuth endpoints via two standard `/.well-known/*` routes. These **must** live at the domain root, registered directly in `app.ts` — **not** under `/api` — because RFC 8414/9728 discovery clients request them at the bare domain.

```ts
// src/app.ts — registered before the /api router, at root
import { authorizationServerMetadataHandler, protectedResourceMetadataHandler } from './mcp/oauth.controller.js';

app.get('/.well-known/oauth-protected-resource', protectedResourceMetadataHandler);
app.get('/.well-known/oauth-authorization-server', authorizationServerMetadataHandler);
```

### `GET /.well-known/oauth-protected-resource` (RFC 9728)

Tells a client which authorization server protects this resource:

```ts
// src/mcp/oauth.controller.ts — URLs come from src/mcp/mcp.config.ts (see oauth.md)
export function protectedResourceMetadataHandler(_req: Request, res: Response): void {
  res.json({
    resource: getMcpResourceUrl(),               // https://api.example.com/api/mcp
    authorization_servers: [getMcpBaseUrl()],    // https://api.example.com
    bearer_methods_supported: ['header']
  });
}
```

### `GET /.well-known/oauth-authorization-server` (RFC 8414)

Full metadata describing how to talk to the authorization server (this API's own `/register`/`/authorize`/`/token` endpoints — see `oauth.md`):

```ts
export function authorizationServerMetadataHandler(_req: Request, res: Response): void {
  res.json({
    issuer: getMcpBaseUrl(),
    authorization_endpoint: getMcpAuthorizationEndpoint(), // …/api/mcp/authorize
    token_endpoint: getMcpTokenEndpoint(),                 // …/api/mcp/token
    registration_endpoint: getMcpRegistrationEndpoint(),   // …/api/mcp/register
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none']
  });
}
```

The exact field names matter — MCP clients parse this metadata programmatically. Copy the shape above rather than improvising field names.

## Anti-pattern: tools that re-implement or proxy the REST API

`api-time-to-drama` shows what to avoid, in two generations:

- **Hand-rolled stage (older):** `POST /api/mcp` parsed JSON-RPC 2.0 by hand (`initialize` / `tools/list` / `tools/call`) with the app's API-key/JWT middleware and no discovery; a separate `mcp-timetodrama-api` package is a stdio proxy that relays every JSON-RPC call to that endpoint with an `x-api-key`. Generic clients can't discover or authenticate against it.
- **Current stage:** it now uses the SDK, the OAuth layer and `/.well-known/*` like the reference, but its tools still come from a hand-written `tool-definitions.ts` (~100 KB of JSON Schema literals) and each call is **forwarded over HTTP to the API's own REST routes**, after minting a normal web access token for the MCP identity (`mcp-web-bridge.utils.ts`).

Why it's worse than the reference pattern:

- The tool schemas drift from the katax-core validators because they are maintained twice; `inputSchema()` from the same schema can't drift.
- Every tool call pays an extra HTTP round-trip to itself and re-runs the whole Express stack (CORS, limiters, logging).
- Minting web tokens for MCP calls undoes the separation between MCP and web credentials described in `oauth.md`.

**New servers:** build tools with `inputSchema()` + `withValid()` and call the controllers directly (`server-and-tools.md`). **Existing repos with this pattern:** migrate one domain at a time — replace its forwarded tools with registry tools that call the controller, then delete those entries from the hand-written definitions.
