# OAuth 2.1 for MCP Clients

MCP clients (the Claude connector, claude.ai) authenticate against your API through a **separate OAuth 2.1 layer**, independent of the app's own login: dynamic client registration (RFC 7591), PKCE `S256`, MCP-only JWTs. The code below is the current reference, `api-habit-forge` (`src/mcp/`), which keeps **no OAuth state in Redis or the database**: the client registration and the authorization codes are signed JWTs.

## Files

```
src/mcp/
├── mcp.config.ts           # every public URL + isMcpPath()
├── mcp-jwt.utils.ts        # secrets, access/refresh tokens, signed client_id, signed auth codes
├── oauth.controller.ts     # well-known handlers, /register, /authorize (GET+POST), /token
├── mcp-auth.middleware.ts  # requireMcpAuth (401 + WWW-Authenticate)
├── mcp.limiters.ts         # register / authorize / token / mcp limiters
├── mcp.routes.ts           # mounted at /api/mcp
├── mcp.types.ts            # McpIdentity { userId, email }
└── mcp.server.ts + tools/  # see server-and-tools.md
```

## URLs in one place (`mcp.config.ts`)

```ts
export function getMcpBaseUrl(): string {
  const explicit = process.env.MCP_BASE_URL || process.env.PRODUCTION_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  return `http://localhost:${process.env.PORT || DEFAULT_PORT}`;
}

export const getMcpResourceUrl = (): string => `${getMcpBaseUrl()}/api/mcp`;
export const getMcpAuthorizationEndpoint = (): string => `${getMcpBaseUrl()}/api/mcp/authorize`;
export const getMcpTokenEndpoint = (): string => `${getMcpBaseUrl()}/api/mcp/token`;
export const getMcpRegistrationEndpoint = (): string => `${getMcpBaseUrl()}/api/mcp/register`;
export const getProtectedResourceMetadataUrl = (): string => `${getMcpBaseUrl()}/.well-known/oauth-protected-resource`;

/** MCP/OAuth paths get their own CORS and rate limits (used by the CORS split and the /api limiter's skip). */
export function isMcpPath(path: string): boolean {
  return path.startsWith('/.well-known/') || path === '/api/mcp' || path.startsWith('/api/mcp/');
}
```

Set `MCP_BASE_URL` in production: it is the `issuer`, the `resource` and the base of every advertised endpoint, so it must be the public HTTPS origin (not `localhost`).

## Routes (`mcp.routes.ts`)

```ts
router.post('/register', registerLimiter, registerClientHandler);
router.get('/authorize', authorizeGetHandler);                    // renders the login page
router.post('/authorize', authorizeLimiter, authorizePostHandler); // checks the password, redirects with ?code
router.post('/token', tokenLimiter, tokenHandler);
router.post('/', mcpLimiter, requireMcpAuth, /* stateless transport, see server-and-tools.md */);
```

The login form and `/token` send `application/x-www-form-urlencoded` bodies: `app.ts` needs `express.urlencoded()` as well as `express.json()`.

## Secrets and tokens (`mcp-jwt.utils.ts`)

```ts
export interface McpTokenPayload { userId: string; email: string; clientId: string }

function derive(label: string, base: string | undefined): string {
  if (!base || base.trim() === '') throw new Error('JWT_SECRET / JWT_REFRESH_SECRET are required for the MCP server');
  return createHmac('sha256', base).update(label).digest('hex');
}

const accessSecret = () => process.env.MCP_JWT_SECRET?.trim() || derive('mcp-access', process.env.JWT_SECRET);
const refreshSecret = () => process.env.MCP_JWT_REFRESH_SECRET?.trim() || derive('mcp-refresh', process.env.JWT_REFRESH_SECRET);
const stateSecret = () => derive('mcp-state', process.env.MCP_JWT_SECRET?.trim() || process.env.JWT_SECRET);

export const MCP_ACCESS_TOKEN_EXPIRY_SECONDS = parseInt(process.env.MCP_JWT_EXPIRES_IN_SECONDS || '3600', 10); // 1 h
export const MCP_REFRESH_TOKEN_EXPIRY_SECONDS = parseInt(
  process.env.MCP_JWT_REFRESH_EXPIRES_IN_SECONDS || String(60 * 60 * 24 * 180), 10);                          // 180 days

export const generateMcpAccessToken = (p: McpTokenPayload) =>
  jwt.sign({ ...p, typ: 'mcp_access' }, accessSecret(), { expiresIn: MCP_ACCESS_TOKEN_EXPIRY_SECONDS });
export const generateMcpRefreshToken = (p: McpTokenPayload) =>
  jwt.sign({ ...p, typ: 'mcp_refresh' }, refreshSecret(), { expiresIn: MCP_REFRESH_TOKEN_EXPIRY_SECONDS });

function verifyTyped(token: string, secret: string, typ: string): McpTokenPayload | null {
  try {
    const d = jwt.verify(token, secret) as McpTokenPayload & { typ?: string };
    if (d.typ !== typ || !d.userId) return null;
    return { userId: d.userId, email: d.email, clientId: d.clientId };
  } catch {
    return null;
  }
}
export const verifyMcpAccessToken = (t: string) => verifyTyped(t, accessSecret(), 'mcp_access');
export const verifyMcpRefreshToken = (t: string) => verifyTyped(t, refreshSecret(), 'mcp_refresh');
```

- Separate secrets (explicit `MCP_JWT_*`, or HMAC-derived from the app secrets so no new env var is required) **plus** the `typ` claim: a web token never verifies on `/api/mcp` and an MCP token never verifies on the web API.
- The long refresh lifetime is deliberate: the Claude connector shouldn't ask the user to log in again every few days.

### Stateless client registration and auth codes

```ts
// client_id IS the registration: a signed token with the client name and redirect URIs
export const createClientId = (c: { clientName?: string; redirectUris: string[] }) =>
  jwt.sign({ typ: 'mcp_client', name: c.clientName, uris: c.redirectUris }, stateSecret());
// readClientId(clientId) → verifies, checks typ === 'mcp_client', returns { clientName, redirectUris } | null

// authorization code: signed, 120 s, with a jti burned on first use
export const createAuthCode = (d: McpAuthCode) =>
  jwt.sign({ typ: 'mcp_code', ...d }, stateSecret(), { expiresIn: 120, jwtid: randomUUID() });
// consumeAuthCode(code) → verifies typ === 'mcp_code', rejects a jti already in the in-process usedCodes map,
// records it until exp, returns { clientId, redirectUri, codeChallenge, userId, email } | null
```

Registrations survive restarts and deploys and there is no table to clean up. The used-codes map is per process: with several instances a code could be replayed on another instance inside its 120 s window — PKCE still blocks a stolen code, and the house default is one PM2 instance anyway.

## `POST /register` (RFC 7591)

```ts
export function registerClientHandler(req: Request, res: Response): void {
  const redirectUris: unknown = req.body?.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 10 ||
      !redirectUris.every((uri) => typeof uri === 'string' && isAllowedRedirectUri(uri))) {
    res.status(400).json({ error: 'invalid_redirect_uri',
      error_description: 'redirect_uris must be a non-empty array of https (or loopback http) URLs' });
    return;
  }
  const clientName = typeof req.body?.client_name === 'string' ? req.body.client_name.slice(0, 100) : undefined;
  const clientId = createClientId({ clientName, redirectUris: redirectUris as string[] });
  res.status(201).json({
    client_id: clientId, client_name: clientName, redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code']
  });
}
// isAllowedRedirectUri: https:, or http: only for localhost / 127.0.0.1 / [::1]
```

Public clients only (`token_endpoint_auth_method: 'none'`): no client secret, PKCE is the proof.

## `GET` + `POST /authorize` (PKCE S256)

`parseAuthorizeParams(source)` is shared by both: `response_type === 'code'`, a `client_id` that `readClientId` accepts, a `redirect_uri` registered for that client, a `code_challenge`, and `code_challenge_method === 'S256'`. Any failure → `400 text/plain` (never redirect to an unverified `redirect_uri`).

- **GET** renders a small server-side HTML login page (every interpolated value through `escapeHtml`) whose form posts to `getMcpAuthorizationEndpoint()` with the OAuth params as hidden fields. Because the browser then follows a redirect to the client's origin, Helmet's CSP needs the `form-action` adjustment described in `katax-ecosystem` → `references/production-hardening.md`.
- **POST** re-validates the params, loads the user through the **auth repository** (`findUserByEmail` — no SQL in the controller), rejects inactive users, checks `verifyPassword`, then:

```ts
const code = createAuthCode({
  clientId: parsed.params.clientId, redirectUri: parsed.params.redirectUri,
  codeChallenge: parsed.params.codeChallenge, userId: user.id, email: user.email
});
const redirect = new URL(parsed.params.redirectUri);
redirect.searchParams.set('code', code);
if (parsed.params.state) redirect.searchParams.set('state', parsed.params.state);
res.redirect(302, redirect.toString());
```

Wrong credentials re-render the page with a generic message (200), never a JSON error.

## `POST /token`

```ts
function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const computed = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const a = Buffer.from(computed), b = Buffer.from(codeChallenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sendTokens(res: Response, payload: McpTokenPayload): void {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    access_token: generateMcpAccessToken(payload), refresh_token: generateMcpRefreshToken(payload),
    token_type: 'Bearer', expires_in: MCP_ACCESS_TOKEN_EXPIRY_SECONDS, scope: 'mcp'
  });
}
```

- `grant_type=authorization_code`: requires `code`, `redirect_uri`, `client_id`, `code_verifier` (else `invalid_request`); `consumeAuthCode` (else `invalid_grant`); `client_id` and `redirect_uri` must match the code; `verifyPkce`; then `sendTokens`.
- `grant_type=refresh_token`: `verifyMcpRefreshToken`, then reload the user (`findUserById`) and refuse inactive accounts; `sendTokens` issues a new pair.
- Anything else: `unsupported_grant_type`. Error responses also set `Cache-Control: no-store` and use the OAuth shape `{ error, error_description }`.

## `requireMcpAuth`

```ts
function unauthorized(res: Response, reason: string): void {
  res.setHeader('WWW-Authenticate',
    `Bearer error="invalid_token", error_description="${reason}", resource_metadata="${getProtectedResourceMetadataUrl()}"`);
  res.status(401).json({ error: 'invalid_token', error_description: reason });
}

export function requireMcpAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header && header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) return unauthorized(res, 'Missing bearer token');
  const payload = verifyMcpAccessToken(token);
  if (!payload) return unauthorized(res, 'Invalid or expired token');
  (req as McpRequest).mcpIdentity = { userId: payload.userId, email: payload.email };
  next();
}
```

The `resource_metadata` parameter of `WWW-Authenticate` (RFC 9728) is how a client that gets a 401 finds the discovery document and starts (or restarts) the OAuth flow.

## Rate limits (`mcp.limiters.ts`)

| Limiter | Route | Limit | 429 body |
|---|---|---|---|
| `registerLimiter` | `POST /register` | 30 / hour | `{ error: 'rate_limited', error_description }` |
| `authorizeLimiter` | `POST /authorize` | 10 / 15 min | plain text (it's an HTML form) |
| `tokenLimiter` | `POST /token` | 60 / 15 min | `{ error: 'rate_limited', error_description }` |
| `mcpLimiter` | `/api/mcp` (POST/GET/DELETE) | 1000 / 15 min | JSON-RPC `{ jsonrpc: '2.0', error: { code: -32029, ... }, id: null }` |

All use `standardHeaders: true, legacyHeaders: false`. The general `/api` limiter skips `isMcpPath()` so the buckets don't overlap.

## Older variant (api-my-routine, api-property-scout)

These store registered clients and authorization codes in Redis (`mcp-oauth.store.ts` over `katax.db('redis')`: `mcp:client:<id>` without TTL, `mcp:code:<code>` with `EX 120`, consumed with GET then DEL). It works, but it adds a dependency on Redis for login and loses every registration if Redis is flushed; GET-then-DEL is also not atomic (use `GETDEL`). Prefer the stateless version above for new servers.
