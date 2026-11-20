# Security

What a katax API must do with secrets, tokens, passwords, files, CORS and headers. Each item says why, so the
cases not listed here can be judged the same way. Sessions and cookies are in `auth-and-sessions.md`; races
(token reuse, double redemption) in `concurrency.md`.

## Contents

1. Secrets and environment
2. JWT
3. Comparing secrets
4. API keys
5. Passwords
6. File uploads and downloads
7. WebSockets
8. CORS, headers, caching
9. SQL and input
10. What the audit script blocks

## 1. Secrets and environment

- No default value for a secret anywhere in the code (`process.env.JWT_SECRET || 'change-me'`). Anyone who can
  read the repository can then forge tokens on any server where the variable is missing. Throw instead.
- Read secrets inside the function that uses them, not into a module-level constant: a constant evaluated at
  import time can capture `undefined` (or the fallback) before `.env` is loaded, for the whole life of the process.
- Validate at boot: required variables present, JWT secrets at least 32 characters, and not one of the example
  values that ever shipped in `.env.example` (compare by SHA-256 so the example value isn't repeated in code):

```ts
// config/env.validator.ts (excerpt)
const KNOWN_PUBLIC_SECRET_HASHES = new Set(['<sha256 of a value that was once committed>']);
for (const name of ['JWT_SECRET', 'JWT_REFRESH_SECRET']) {
  const value = process.env[name] ?? '';
  if (value.length < 32) fail(`${name} must be at least 32 characters`);
  if (KNOWN_PUBLIC_SECRET_HASHES.has(sha256(value))) fail(`${name} is a published example value; generate a new one`);
}
```

- `.env.example` holds placeholders only; `.env` is git-ignored and has permissions 600 on the server
  (`katax deploy init` does both). The audit flags `.env.example` lines that look like real values.

## 2. JWT

Use `assets/templates/shared/jwt.utils.ts`: HS256 pinned on sign and verify, secrets read lazily with a
32-character minimum, short access tokens (15 min) and a `typ` claim so a refresh token is never accepted as an
access token.

```ts
jwt.verify(token, secret('JWT_SECRET'), { algorithms: ['HS256'] });
```

Without `algorithms`, the accepted algorithm depends on the token header and library defaults; pinning it closes
algorithm-confusion attacks. MCP tokens use their own secrets (`MCP_JWT_SECRET`) and `typ` values
(`katax-mcp-server`).

Separate secrets are not enough on their own: deployments end up with the same value in both variables. Every
issuer also signs an `aud` claim (`app`, `mcp`, ...) and every verifier checks `audience` together with `typ` and
`algorithms`, so an MCP token is never accepted as an app token or the reverse, whatever the secrets are. Log a
warning at boot (never the value) when two issuers share a secret. Adding the claim invalidates tokens issued
without it once: app access tokens are short-lived and refresh re-issues them; long-lived clients (an MCP
connector) reconnect once. Say so in the change notes.

## 3. Comparing secrets

`===` stops at the first different character, so response timing tells an attacker how much of a guess was
right. Compare API keys, socket tokens, webhook secrets and client secrets with
`safeTokenEquals()` (`assets/templates/shared/secret-compare.utils.ts`), which hashes both sides and uses
`crypto.timingSafeEqual`. It replaces the generated `secureCompare()` in `password.utils.ts`, which returns early when the lengths differ and accepts an empty expected value.

## 4. API keys

- Show the key once at creation; store only `sha256(key)` and look it up by hash. A leaked database then leaks no
  usable keys.
- A recognisable prefix (`ak_live_...`) lets you skip JWT verification for key traffic and lets secret scanners
  find leaked keys.
- Record `last_used_at`, support `revoked_at` and `expires_at`, and rate-limit by key id (never by IP).

## 5. Passwords

`bcryptjs ^3` with cost >= 12 (or argon2): `hashPassword()` in the generated `password.utils.ts` already defaults to 12. Cost 10 is too cheap for 2026 hardware.
Never log passwords or hashes; compare with the library's `compare`, never by re-hashing and `===`.

## 6. File uploads and downloads

- Size limit per route (multer `limits.fileSize`, `files`), and a smaller one for avatars.
- multer with `defParamCharset: "utf8"`: its default decodes multipart filenames as latin1, so `Árbol.png` arrives
  as `Ãrbol.png` (audit rule `multer-param-charset`).
- Detect the real type from the bytes with `file-type` (`fileTypeFromBuffer` on the first 8 KB) and store that
  MIME, not the client's `Content-Type` or the extension. Never fall back to the client's type when detection or
  a downstream verification is missing: reject instead.
- Text formats have no signature (txt, md, csv, json, code, svg/xml): accept them only when the first chunk has no
  NUL bytes and is valid UTF-8, and map by extension; a binary renamed `.txt` must fail.
- One allow-list per route, decided by what the route is for: covers and avatars are images, voice is audio
  (browser recorders produce `webm`/`mp4` containers that `file-type` may report as video), general file stores
  block executables and installers. Admin-only routes may allow more, checked by role. Reject with 415 and a
  generic message; log declared vs detected type, never content.
- Run the check before any other work: before writing to disk, before forwarding to another service, before
  counting quota.
- Large files are streamed, not buffered: `multer.memoryStorage()` with a big limit keeps every upload whole in
  RAM, and a few concurrent ones exhaust it (audit rule `upload-in-memory`). Read the first chunk for the type
  check, then pipe the rest to its destination, enforce the size cap while streaming (abort + 413), abort upstream
  when the client disconnects, and cap uploads in flight per process and per user (503 + `Retry-After`).
- If the file reaches another service and a later step fails, delete it there (known issue D9).
- Generate the storage name yourself (UUID); never build a path from the original filename. Revalidate anything
  that becomes part of a path (thumbnail size names, folder ids) at the filesystem boundary, even if the request
  schema already checked it.
- Serve with `X-Content-Type-Options: nosniff` and `Content-Disposition` (`attachment` for anything that could
  run in the browser: HTML, SVG, JS). Quote an ASCII fallback name and add the UTF-8 `filename*`.
- Temporary access goes through signed URLs with an expiry (HMAC of path + expiry with a dedicated secret,
  compared with `timingSafeEqual`), not public folders.

## 7. WebSockets

`katax.socket({ enableAuth: true, authValidator })`. If the expected token is not configured, refuse every
connection (and warn at boot) instead of accepting anonymous ones; a socket that carries the log stream or user
events must never be open.

```ts
const socketToken = katax.env('SOCKET_AUTH_TOKEN', '');
if (!socketToken) console.warn('SOCKET_AUTH_TOKEN not set: WebSocket connections are refused.');
await katax.socket({ name: 'main', httpServer, cors: { origin: allowedOrigins }, enableAuth: true,
  authValidator: (token) => safeTokenEquals(token, socketToken) });
```

## 8. CORS, headers, caching

- App routes: dynamic allow-list from `ALLOWED_ORIGINS` with `credentials: true`. Open origins (`true` / `'*'`)
  only on public bearer-token routes (MCP, OAuth) and always with `credentials: false`. Details in
  `production-hardening.md`.
- `app.set('trust proxy', 1)` behind nginx, `helmet()` with defaults, body limit 1 MB.
- Responses that carry tokens or private data: `Cache-Control: no-store` (`assets/templates/middleware/no-store.middleware.ts`,
  mount it on `/api/auth`).

## 9. SQL and input

- Parameterised queries only. The only things interpolated into SQL are column names from a whitelist and
  constants defined in the repository.
- The caller's identity comes from `req.user` / the MCP identity, never from the body or query (`user_id` in a
  request schema is flagged).
- A child resource is looked up and written under the parent in the URL (`WHERE id = $1 AND workspace_id = $2`),
  never by its own id followed by a check on the parent stored in its row; otherwise a caller who controls one
  parent acts on another parent's children (known issue S9). Same 404 for missing and foreign. A field about another user (invite, transfer) is named for what it is
  (`member_id`, `target_user_id`).
- Error responses never carry driver messages, stack traces, hostnames or SQL (`errors.md`).

## 10. What the audit script blocks

`fallback-secret`, `jwt-verify-algorithms`, `cors-open-with-credentials`, `error-message-leak`,
`real-secret-in-example` are errors; `secret-at-module-scope`, `timing-unsafe-compare`, `weak-bcrypt-cost`,
`user-id-in-schema`, `multer-param-charset`, `upload-in-memory` are warnings. See `audit.md`.
