# OAuth 2.1 for MCP Clients

MCP clients (Claude's connector, `claude.ai`) need to authenticate against your API independently of your app's own login system. The reference pattern (from `api-property-scout`, `api-second-brain`) implements a **separate, self-contained OAuth 2.1 layer** specifically for MCP — distinct JWT secrets, distinct token endpoints, distinct storage — rather than reusing the app's regular session auth.

## Why a separate layer

- MCP clients register themselves dynamically (RFC 7591) — you don't pre-provision API keys for them like a normal third-party integration.
- The MCP spec requires PKCE and specific discovery metadata (see `well-known-and-antipattern.md`) that a normal app login flow doesn't have.
- Keeping MCP-issued JWTs on a separate secret from the app's session JWT means a leaked/compromised MCP token can't be used to forge a regular user session, and vice versa.

## Endpoints

Mounted under `/api/mcp` (or wherever your MCP router lives):

### `POST /register` — Dynamic Client Registration (RFC 7591)

Accepts a client's self-description (`client_name`, `redirect_uris`, etc.), stores it, returns a `client_id` (and `client_secret` if using confidential clients). No pre-approval step — any MCP client can self-register.

```ts
router.post('/register', async (req, res) => {
  const clientId = randomUUID();
  await mcpOauthStore.saveClient(clientId, { redirectUris: req.body.redirect_uris, clientName: req.body.client_name });
  res.json({ client_id: clientId, redirect_uris: req.body.redirect_uris, /* ... */ });
});
```

### `GET /authorize` + `POST /authorize` — Authorization with PKCE (S256)

- `GET` renders a server-side HTML login form (username/password), embedding the OAuth params (`client_id`, `redirect_uri`, `code_challenge`, `state`) as hidden fields — this is why the form **posts to itself** (same origin) before redirecting cross-origin to the client's `redirect_uri`. This is also why CORS/Helmet need the specific adjustments in `katax-ecosystem/references/production-hardening.md` (self-origin in CORS allow-list; `form-action` CSP override).
- `POST` validates credentials against the app's own user table (`verifyPassword`), generates a single-use authorization code, stores it in Redis with the PKCE `code_challenge` attached and a short TTL, then redirects to `redirect_uri?code=...&state=...`.

```ts
// POST /authorize
const user = await verifyCredentials(req.body.email, req.body.password);
if (!user) return res.render('login', { error: 'Invalid credentials' });

const code = randomUUID();
await mcpOauthStore.saveAuthCode(code, {
  userId: user.id,
  clientId: req.body.client_id,
  codeChallenge: req.body.code_challenge, // PKCE S256
  redirectUri: req.body.redirect_uri,
}, 120); // seconds TTL

res.redirect(`${req.body.redirect_uri}?code=${code}&state=${req.body.state}`);
```

### `POST /token` — Token Exchange

Two grant types:

- `authorization_code`: exchanges the one-time code for an access + refresh token pair. Verifies PKCE by hashing the client-supplied `code_verifier` (SHA-256, base64url) and comparing to the stored `code_challenge`. The code is deleted immediately on use (single-use, `GET` then `DEL` in Redis) — replay is rejected.
- `refresh_token`: issues a new access token from a valid MCP refresh token.

```ts
if (grantType === 'authorization_code') {
  const stored = await mcpOauthStore.getAuthCode(code); // GET, then DEL — single use
  if (!stored) return res.status(400).json({ error: 'invalid_grant' });
  const computedChallenge = base64url(sha256(codeVerifier));
  if (computedChallenge !== stored.codeChallenge) return res.status(400).json({ error: 'invalid_grant' });

  const accessToken = signMcpJwt({ sub: stored.userId, clientId: stored.clientId }, MCP_JWT_SECRET, '15m');
  const refreshToken = signMcpJwt({ sub: stored.userId, clientId: stored.clientId }, MCP_JWT_REFRESH_SECRET, '30d');
  res.json({ access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: 900 });
}
```

## JWT Secrets — Keep Separate

```
MCP_JWT_SECRET          ← MCP access token secret (NOT the app's session JWT secret)
MCP_JWT_REFRESH_SECRET  ← MCP refresh token secret
```

Easy mistake to make: reusing the app's regular `JWT_SECRET` for MCP tokens. Don't — a token minted for MCP scope should never verify successfully against the app's normal session-auth middleware, and vice versa.

## Auth Middleware for Tool Calls

```ts
export async function requireMcpAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer /, '');
  const payload = token && verifyMcpAccessToken(token);
  if (!payload) {
    res.setHeader(
      'WWW-Authenticate',
      `Bearer error="invalid_token", resource_metadata="${mcpConfig.protectedResourceMetadataUrl}"`
    );
    return res.status(401).json({ error: 'invalid_token' });
  }
  req.mcpIdentity = { userId: payload.sub, clientId: payload.clientId };
  next();
}
```

The `WWW-Authenticate` header pointing at the resource-metadata well-known URL is part of RFC 9728 — it's how a compliant MCP client discovers *where* to go re-authenticate after a 401, instead of failing silently.

## Redis-backed transient state

Both auth codes and registered clients live in Redis via `katax.db('redis')` (not Postgres — this state is short-lived and doesn't need durability):

```ts
// registered clients: no TTL, persist until explicitly removed
await redis.redis('SET', `mcp:client:${clientId}`, JSON.stringify(clientData));

// auth codes: short TTL, single-use (GET then DEL)
await redis.redis('SET', `mcp:code:${code}`, JSON.stringify(codeData), 'EX', '120');
const raw = await redis.redis('GET', `mcp:code:${code}`);
await redis.redis('DEL', `mcp:code:${code}`);
```

See `katax-ecosystem/references/katax-service-manager.md` for the general `katax.db('redis')` API this builds on.
