# Production hardening: bootstrap, rate limiting, Redis, CORS, Helmet

Cross-cutting setup for every katax API. Security rules (secrets, JWT, uploads) are in `security.md`, sessions
and cookies in `auth-and-sessions.md`, background jobs in `workers-and-cron.md`.

## Contents

1. Bootstrap order and configuration
2. Rate limiting (Redis-backed, with fallback)
3. Redis connections, one per use
4. CORS
5. Helmet and request limits
6. Dashboard registry and log streams
7. PM2

## 1. Bootstrap order and configuration

```ts
// src/index.ts
import 'dotenv/config';                     // FIRST line: every module and katax.env() see .env
import { katax } from 'katax-service-manager';
import app from './app.js';
import { validateEnvironment } from './config/env.validator.js';

async function bootstrap(): Promise<void> {
  validateEnvironment();                    // exit early with a clear list of missing variables
  await katax.init({ logger: { level: katax.env('LOG_LEVEL', 'info') as 'info', prettyPrint: katax.isDev } });
  await katax.database({ name: 'main', type: 'postgresql', connection: { /* katax.envRequired(...) */ } });
  await katax.database({ name: 'ratelimit', type: 'redis', required: false, connection: { /* db 6 */ } });
  // ... cache / socket / cron / dashboard (non-fatal)
  const PORT = katax.env('PORT', 3000);
  app.listen(PORT, () => katax.logger.info({ message: `Server running on :${PORT}` }));
  katax.onShutdown(async () => { /* close your own intervals, workers, registry */ });
}
void bootstrap();
```

Why `import 'dotenv/config'` and not `katax.init({ loadEnv: true })`: `loadEnv` loads `.env` inside `init()`, which
is too late for `katax.env('LOG_LEVEL')` in the same options object (it is evaluated before `init` runs) and for any
module that reads `process.env` at import time. A real API ignored `LOG_LEVEL` from `.env` for months because of
this. `dotenv.config()` called inside `index.ts` has the same problem in ESM: imports are evaluated before the
first statement runs. katax-cli 1.7 generates the `import 'dotenv/config'` line.

- Validate required variables at boot with `console` (the logger does not exist yet) and `process.exit(1)`.
- Name every connection with a constant (`'main'`, `RATE_LIMIT_REDIS_NAME`), never a string typed twice.
- Optional services (`required: false`) let the API boot without Redis; code that uses them must cope with
  `katax.db(name)` throwing.
- OpenAPI 3.1 is built at runtime by `mountApiDocs()` from each route's `docs()` metadata; never a static
  `openapi.json`.

## 2. Rate limiting

Counters live in Redis so they survive `pm2 reload` (every deploy) and are shared by every instance; if Redis is
missing or slow (250 ms) the store counts in memory instead of failing the request. Copy
`assets/templates/shared/rate-limit.store.ts` and `assets/templates/middleware/rate-limit.middleware.ts`.

```ts
// app.ts
import { apiLimiter } from './middleware/rate-limit.middleware.js';
app.set('trust proxy', 1);          // before the limiters: real client IP behind nginx
app.use('/api', apiLimiter);

// auth.routes.ts
router.post('/login', authLimiter, loginHandler);
router.post('/register', authLimiter, registerHandler);
router.post('/refresh', refreshLimiter, refreshHandler);   // own, looser bucket: the front end refreshes on every load
```

Tiers and keys:

| Limiter | Key | Typical limit | Why |
| --- | --- | --- | --- |
| `apiLimiter` on `/api` | `u:<userId>` if the bearer token verifies, else `ip:<ipKeyGenerator>` | 1000 / 100 per 15 min | users behind one NAT don't share a cap |
| `authLimiter` (login, register, reset, email codes) | IP | 10 per 15 min | brute force |
| `refreshLimiter` | IP | 60 per 15 min | the login limit would lock real users out |
| API-key / SDK traffic | `apiKeyId`, never IP | per plan | one backend serves many end users from one IP |
| uploads / downloads | user or IP | per hour / 5 min | bandwidth and disk |
| MCP + OAuth | see `katax-mcp-server` | own limiters; the general one skips `isMcpPath()` | the handshake alone would eat the budget |

- `ipKeyGenerator(req.ip)` groups IPv6 by /56; a raw `req.ip` lets one client rotate addresses.
- Each limiter has its own store name (`new RedisFallbackStore('auth')` -> keys `rl:auth:*`).
- `standardHeaders: true`, `legacyHeaders: false`, body `{ success: false, message, error: 'RATE_LIMIT_EXCEEDED' }`.
- If you prefer the `rate-limit-redis` package instead of the template store: its `RedisStore` calls Redis in the
  constructor, so build the limiter lazily on the first request or it throws `KataxNotInitializedError` at import
  time; and without Redis every request fails.

## 3. Redis connections, one per use

| Connection | Use | Why separate |
| --- | --- | --- |
| `redis` / `cache` | log transports (`XADD`), dashboard bridge, registry, heartbeat | the bridge runs blocking `XREADGROUP` reads |
| `ratelimit` | rate-limit counters | every request waits on it; it must never queue behind a blocking read |
| `appcache` | application cache | a heavy cache load must not slow the limiters |

Use separate logical DBs (`db: 6`, `db: 7`) on the same server. Never use Redis as the session store: sessions
are rows in Postgres (`auth-and-sessions.md`).

## 4. CORS

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

If the app also runs an MCP OAuth flow (see `katax-mcp-server`), the login page served by the API posts back to the API, so the browser sends the API's own origin: push `getMcpBaseUrl()` into `allowedOrigins` too. With the path split below those routes already go through `mcpCors`; the push matters for apps without the split.

With an MCP server, split CORS by path: the app routes keep the `ALLOWED_ORIGINS` allow-list with cookies; MCP + OAuth endpoints are public by design (bearer tokens, no cookies) and accept any origin, exposing the headers MCP clients read:

```ts
const appCors = cors(corsOptions);
const mcpCors = cors({ origin: true, credentials: false, exposedHeaders: ['Mcp-Session-Id', 'WWW-Authenticate'], maxAge: 86400 });
app.use((req, res, next) => (isMcpPath(req.path) ? mcpCors : appCors)(req, res, next));
```

Socket.IO gets its own separate CORS config passed directly to `katax.socket({ cors: {...} })` — it is **not** shared with the Express `cors` middleware config; keep both in sync manually if they need to match.

## 5. Helmet and request limits

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

Request limits: `express.json({ limit: '1mb' })` and `express.urlencoded({ limit: '1mb' })`; uploads have their
own per-route limits (`security.md`).

## 6. Dashboard registry and log streams

Copy `assets/templates/registry/dashboard-registry.ts`: an **HTTP** registry against the Katax dashboard plus two Redis log streams and their WebSocket bridges. All of it inside a try/catch that only warns — a dashboard being down must never crash boot.

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

`initDashboardRegistry` needs `DASHBOARD_API_BASE_URL` + `DASHBOARD_API_KEY` (skips with a warning otherwise), registers once and stores `katax.dashboardProjectId` in `package.json`, then heartbeats. The older Redis-only helpers (`registerProjectInRedis`, `katax.heartbeat()`) still exist in katax-service-manager; use them only for services that don't talk to the HTTP dashboard. Full bootstrap: skill `katax-service-manager` → "Bootstrap Template".

## 7. PM2

`ecosystem.config.cjs` in fork mode with 1 instance unless you planned for more: Socket.IO needs sticky sessions,
in-memory caches diverge, and cron jobs fire once per instance (wrap them in `runExclusive`, see
`workers-and-cron.md`). Secrets go in `.env` on the server (permissions 600), not in `ecosystem.config.cjs`.
