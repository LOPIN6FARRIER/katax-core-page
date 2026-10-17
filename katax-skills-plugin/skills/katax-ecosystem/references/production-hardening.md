# Production Hardening — house style for katax-based APIs

Cross-cutting patterns observed consistently across real katax-core + katax-service-manager apps (`api-habit-forge`, `api-my-routine`, `api-second-brain`, `api-property-scout`, `api-time-to-drama`; habit-forge is the most recent and the reference when they differ): rate limiting, CORS, Helmet, the cookie-attachment side of `createResponse`/`sendResponse`, sessions, and the service-registry/heartbeat combo. These apply to any katax-based Express API, independent of whether it also exposes an MCP server (for that, see the `katax-mcp-server` skill, which references this file instead of repeating it).

## Rate Limiting

`express-rate-limit`, in-memory store (none of the reference repos use a Redis-backed store — acceptable for single-instance deployments, but won't share limits across multiple instances). Pattern: one general limiter on `/api`, plus stricter dedicated limiters layered on top for auth-sensitive routes.

```ts
import { rateLimit } from 'express-rate-limit';

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.', error: 'RATE_LIMIT_EXCEEDED' },
});
app.set('trust proxy', 1); // before the limiter: real client IP behind nginx
app.use('/api', apiLimiter);
app.use('/api', router);
```

If the app also serves MCP, the MCP/OAuth paths get their own limiters (the MCP handshake alone would eat the general budget) and the general one skips them:

```ts
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  skip: (req) => isMcpPath(req.originalUrl.split('?')[0] ?? ''), // src/mcp/mcp.config.ts
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.', error: 'RATE_LIMIT_EXCEEDED' },
});
```

```ts
// Stricter limiter on a specific sensitive route (login, registration, email flows)
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
router.post('/login', loginLimiter, loginHandler);
```

`standardHeaders: true` / `legacyHeaders: false` is the consistent choice (modern `RateLimit-*` headers, not the deprecated `X-RateLimit-*` ones). `app.set('trust proxy', 1)` must be set for correct client IP detection behind Nginx/PM2/cloud proxies — without it, every request behind a reverse proxy shares the same perceived IP and the limiter throttles everyone together.

## CORS

`cors` package, `origin` as a **dynamic callback** re-reading `process.env.ALLOWED_ORIGINS` on every request — not a static array captured at module load, so origins configured via env vars that load after import still take effect.

```ts
export const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = (
      process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
        : ['http://localhost:3000', 'http://localhost:5173']
    ).filter(Boolean);
    if (!origin) return callback(null, true); // no-Origin requests (mobile apps, curl) allowed
    if (allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-platform'], // x-platform: native clients (see Cookies)
};
```

If the app also runs an MCP OAuth flow (see `katax-mcp-server`), the login page served by the API posts back to the API, so the browser sends the API's own origin: api-habit-forge also pushes `getMcpBaseUrl()` into `allowedOrigins`. With the path split below those routes already go through `mcpCors`; the push matters for apps without the split.

With an MCP server, split CORS by path: the app routes keep the `ALLOWED_ORIGINS` allow-list with cookies; MCP + OAuth endpoints are public by design (bearer tokens, no cookies) and accept any origin, exposing the headers MCP clients read (api-habit-forge):

```ts
const appCors = cors(corsOptions);
const mcpCors = cors({ origin: true, credentials: false, exposedHeaders: ['Mcp-Session-Id', 'WWW-Authenticate'], maxAge: 86400 });
app.use((req, res, next) => (isMcpPath(req.path) ? mcpCors : appCors)(req, res, next));
```

Socket.IO gets its own separate CORS config passed directly to `katax.socket({ cors: {...} })` — it is **not** shared with the Express `cors` middleware config; keep both in sync manually if they need to match.

## Helmet

Used with defaults in every reference repo — `app.use(helmet())` is enough for a plain REST API. The only override observed anywhere is `contentSecurityPolicy.directives['form-action']`, and only in apps that also run MCP OAuth:

```ts
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'form-action': ["'self'", 'https:'],
      },
    },
  })
);
```

Don't add this override unless you actually have a self-posting login form that redirects cross-origin afterward (see `katax-mcp-server` → `references/oauth.md`) — default Helmet CSP is stricter and should stay that way otherwise.

## Cookies via `createResponse` / `sendResponse`

The `shared/api.utils.ts` pattern generated by `katax-cli` (see `references/katax-cli.md`) centralizes cookie writes through `ControllerResult.cookies?: ResponseCookie[]`, applied inside `sendResponse()`:

```ts
if (controllerResult.cookies?.length) {
  for (const cookie of controllerResult.cookies) {
    cookie.options ? res.cookie(cookie.name, cookie.value, cookie.options) : res.cookie(cookie.name, cookie.value);
  }
}
```

Controllers build cookies as **data**, not side effects — they return `{ ...result, cookies: [{ name, value, options }] }` instead of touching `res` directly. This is the recommended pattern (observed cleanly in `api-property-scout`, which also exports standalone `setCookie(res, name, value, options)` / `clearCookie(res, name, options)` helpers from the same file for the rare case outside the controller-result flow). Prefer this over setting `res.cookie(...)` directly inside route handlers — a couple of reference repos do it ad hoc in the auth handler instead, which works but duplicates cookie-option logic across every place a cookie gets set/cleared instead of centralizing it once.

Keep cookie options in one file (`src/config/cookie.config.ts`, api-my-routine) so set and clear always match:

```ts
import type { CookieOptions } from 'express';

export const REFRESH_COOKIE_NAME = 'refresh_token';

// parseDurationToMs("15m" | "24h" | "7d") -> ms lives in the same file
export function getRefreshCookieOptions(): CookieOptions {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    // cross-site web clients (app on another domain) need SameSite=None + Secure in production;
    // 'lax' in dev so http://localhost works. Same-site deployments can use 'strict'/'lax'.
    sameSite: isProd ? 'none' : 'lax',
    path: '/',
    maxAge: parseDurationToMs(process.env.JWT_REFRESH_EXPIRES_IN || '7d'),
  };
}

export function getClearedRefreshCookieOptions(): CookieOptions {
  return { ...getRefreshCookieOptions(), maxAge: 0 };
}
```

Native clients (React Native, Tauri) can't rely on the httpOnly cookie: the client sends `x-platform: mobile|tauri` and only then the refresh token is also returned in the JSON body (api-habit-forge `AccessTokenResult.refresh_token?`). Web clients never get it in the body.

Clearing a cookie is the same shape with `maxAge: 0` and an empty value pushed into the same `cookies[]` array (or a direct `clearCookie()` call using identical options — the options **must match** what was used to set it, or the browser won't clear it).

## Error hygiene (never leak internals)

- Expected failures are `AppError`s (`notFoundError`, `conflictError`, `validationError`, `unauthorizedError`, `forbiddenError`) whose message is written for the client.
- Everything else (pg errors, bugs) is logged with context and answered with a generic message: `toSafeErrorResult(error, { context, userId })` in every controller `catch`, the same inside `sendResponse`'s catch, and `errorMiddleware` as the last resort.
- The generated `api.utils.ts` (katax-cli 1.6.2) still returns `error.message` on 500: replace it when you create the project.
- Express 4 doesn't forward rejected promises from async middleware to `errorMiddleware`. Either every async path goes through `sendResponse` (it catches), or import an async-errors patch (`shared/async-errors.ts` in api-second-brain, same idea as `express-async-errors`) as the first import of `app.ts`.
- Validation errors: 422 with `[{ field, message }]`; `field` is the dotted path (`schedule.weekdays`).

## Sessions

None of the reference repos use `express-session` or a Redis-backed session store. The consistent pattern is a **Postgres-backed refresh-token session table**:

- Opaque token (`randomUUID()`) or JWT-embedded `sessionId`, hashed (SHA-256) before storing.
- Session row: `user_id`, `refresh_token_hash`, device info (`user_agent`/`ip_address`/`platform` or a single `device_info`), `expires_at`, `revoked_at`.
- Refresh rotates: verify hash → revoke the old row → insert a new one, inside `withTransaction()`.
- Session-limit enforcement (e.g. max 5 concurrent sessions) — oldest revoked when the limit is exceeded.
- Client-facing endpoints: list sessions, get by id, revoke one, revoke all (except current).
- Delivered via the httpOnly refresh cookie above; access token stays a short-lived JWT, never stored server-side.

Redis is deliberately **not** the session store in any of these apps — it's reserved for cache, transient OAuth state (if MCP is present), log transport, and heartbeat (see below). Don't reach for `connect-redis`/`express-session` unless you have a specific reason to diverge from this pattern.

## Dashboard registry & log streams

Current pattern (api-habit-forge, api-second-brain, api-my-routine, api-property-scout all ship the same `src/registry/dashboard-registry.ts`): an **HTTP** registry against the Katax dashboard plus two Redis log streams and their WebSocket bridges. All of it inside a try/catch that only warns — a dashboard being down must never crash boot.

```ts
const redisDb = katax.db('redis') as unknown as IRedisDatabase;
katax.logger.addTransport(new RedisTransport(redisDb, { streamKey: 'katax:logs' }));        // every log
const dashboardTransport = new RedisTransport(redisDb, { streamKey: 'katax:dashboard' });   // what the dashboard shows
dashboardTransport.filter = (log) => log.level === 'error' || log.level === 'info';
katax.logger.addTransport(dashboardTransport);

const dashboard = await initDashboardRegistry({ appName: katax.appName, version: katax.version, port: PORT, intervalMs: 10000 });
await katax.bridge('redis', 'main', { appName: katax.appName, streamKey: 'katax:logs' }).start();
await katax.bridge('redis', 'main', { appName: katax.appName, streamKey: 'katax:dashboard' }).start();
katax.onShutdown(async () => { await dashboard.stop(); });
```

`initDashboardRegistry` needs `DASHBOARD_API_BASE_URL` + `DASHBOARD_API_KEY` (skips with a warning otherwise), registers once and stores `katax.dashboardProjectId` in `package.json`, then heartbeats. The older Redis-only helpers (`registerProjectInRedis`, `katax.heartbeat()`) still exist in katax-service-manager; use them only for services that don't talk to the HTTP dashboard. Full bootstrap: `references/katax-service-manager.md` → "Bootstrap Template".
