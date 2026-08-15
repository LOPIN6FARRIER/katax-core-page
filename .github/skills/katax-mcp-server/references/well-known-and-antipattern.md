# Well-Known Discovery & the Anti-Pattern to Avoid

## Well-Known Discovery Endpoints

MCP clients auto-discover an API's OAuth endpoints via two standard `/.well-known/*` routes. These **must** live at the domain root, registered directly in `app.ts` — **not** under `/api` — because RFC 8414/9728 discovery clients request them at the bare domain.

```ts
// src/app.ts — registered before the /api router, at root
app.get('/.well-known/oauth-protected-resource', protectedResourceMetadataHandler);
app.get('/.well-known/oauth-authorization-server', authorizationServerMetadataHandler);
```

### `GET /.well-known/oauth-protected-resource` (RFC 9728)

Tells a client which authorization server protects this resource:

```ts
function protectedResourceMetadataHandler(req: Request, res: Response) {
  res.json({
    resource: `${BASE_URL}/api/mcp`,
    authorization_servers: [BASE_URL],
  });
}
```

### `GET /.well-known/oauth-authorization-server` (RFC 8414)

Full metadata describing how to talk to the authorization server (this API's own `/register`/`/authorize`/`/token` endpoints — see `oauth.md`):

```ts
function authorizationServerMetadataHandler(req: Request, res: Response) {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/api/mcp/authorize`,
    token_endpoint: `${BASE_URL}/api/mcp/token`,
    registration_endpoint: `${BASE_URL}/api/mcp/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
}
```

The exact field names matter — MCP clients parse this metadata programmatically. Copy the shape above rather than improvising field names.

## Anti-Pattern: Hand-Rolled JSON-RPC Without SDK/OAuth/Discovery

A third real repo (`api-time-to-drama`) implements an MCP-*shaped* endpoint without the official SDK or any of the above:

- A single `POST /api/mcp` handler manually parsing JSON-RPC 2.0 (`method: "initialize" | "tools/list" | "tools/call"`), hand-building the responses instead of using `Server`/`StreamableHTTPServerTransport`.
- No OAuth layer at all — auth is just the app's existing Bearer JWT / API-key middleware, reused as-is.
- No `/.well-known/*` discovery — a client has to be told the endpoint URL out-of-band; it can't auto-discover it.
- Tools execute by **`fetch()`-ing the app's own REST routes internally** rather than calling controller functions directly — an extra HTTP round-trip (to itself) per tool call, and the tool's `inputSchema` is a hand-written JSON Schema literal, duplicated by hand alongside the real katax-core validator instead of derived from it via `toJsonSchema()`.

This "works" in the narrow sense that a JSON-RPC-speaking client can call it, but it's missing everything that makes an MCP server *interoperable* with a generic client (standards-compliant discovery, OAuth) and *maintainable* (schema duplication between REST validator and hand-written tool schema, an extra internal HTTP hop per tool call).

**If you find this pattern in an existing repo, prefer migrating it to the `@modelcontextprotocol/sdk` + OAuth 2.1 + well-known pattern documented in `server-and-tools.md` and `oauth.md`, rather than extending the hand-rolled version further.** Don't use the hand-rolled JSON-RPC approach as a reference when building something new.
