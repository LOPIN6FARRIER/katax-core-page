---
name: katax-service-manager
description: 'Runtime service container (singleton) for Node.js apps — manages config, Pino logging, database pools (PostgreSQL/MySQL/MongoDB/Redis), WebSocket (Socket.IO), cron, cache, registry, health checks, and graceful shutdown. Use when: bootstrapping a Katax-based app, wiring databases/websocket/cron/cache, debugging init order or shutdown, working directly inside the katax-service-manager repo itself.'
argument-hint: 'What part of katax-service-manager? (bootstrap/database/logger/websocket/cron/cache/registry/shutdown/internals)'
---

# katax-service-manager — Runtime Service Container

Singleton service container for Node.js apps: config, logger, database pools, WebSocket, cron, cache, registry, health, graceful shutdown. Part of the [Katax ecosystem](https://github.com/LOPIN6FARRIER/katax-service-manager) alongside `katax-core` (validation) and `katax-cli` (scaffolding).

**Version: 0.6.1** | ESM-only | Node >= 18 | `npm install katax-service-manager`

All DB/WS/cron/pino-pretty/dotenv dependencies are **optional peer dependencies**, loaded with dynamic `import()` on first use — `import { katax } from 'katax-service-manager'` works with none installed (also under pnpm's strict `node_modules`).

House style for how repositories/controllers use the database: `katax-ecosystem` skill → `references/api-architecture.md` (`shared/db.ts` with `db()` + `withTransaction()`).

## Quick Start

```ts
import { katax } from 'katax-service-manager';

await katax.init({ loadEnv: true });

const db = await katax.database({
  name: 'main',
  type: 'postgresql',
  connection: { host: 'localhost', user: 'admin', password: 'secret', database: 'myapp' },
});

// typed by `type`: ISqlDatabase for postgresql/mysql
const rows = await db.query<Array<{ id: string }>>('SELECT id FROM users WHERE active = $1', [true]);
katax.logger.info({ message: 'App started', users: rows.length });

// No process.on('SIGTERM') needed: init() registers SIGTERM/SIGINT → katax.shutdown() → exit.
katax.onShutdown(async () => { /* close your own resources */ });
```

## Public Surface Summary

| Category   | Exports |
| ---------- | ------- |
| Core       | `Katax`, `katax` |
| Services   | `ConfigService`, `LoggerService`, `DatabaseService`, `CacheService`, `RegistryService`, `RedisStreamBridgeService` (WebSocket/Cron classes are not exported — use `katax.socket()` / `katax.cron()`, so `socket.io`/`node-cron` stay optional) |
| Types      | `ISqlDatabase`, `IMongoDatabase`, `IRedisDatabase`, `IDatabaseService`, `LogConfig`, `LogEntry`, `LogTransport`, `DatabaseConfig`, `WebSocketConfig`, `CronJobConfig`, ... |
| Errors     | `KataxServiceError`, `KataxConfigError`, `KataxNotInitializedError`, `KataxDatabaseError`, `KataxRedisError`, `KataxWebSocketError`, `KataxRegistryError` |
| Transports | `RedisTransport`, `CallbackTransport`, `TelegramTransport` |
| Helpers    | `registerVersionToRedis`, `startHeartbeat`, `registerProjectInRedis` |

## Singleton vs Isolated Instance

```ts
import { Katax, katax } from 'katax-service-manager';

await katax.init();           // pre-exported singleton (recommended)
Katax.getInstance();          // explicit singleton (same instance)
const instance = new Katax(); // isolated instance (testing / multi-tenant)
await instance.init();
await Katax.reset();          // reset singleton (testing) — awaits shutdown() first
```

## Initialization

```ts
await katax.init({
  loadEnv: true,                 // auto-load .env (requires dotenv, dynamic import)
  appName: 'my-api',             // override (else KATAX_APP_NAME → npm_package_name → package.json)
  logger: { level: 'info', prettyPrint: true, enableBroadcast: false },
  hooks: {
    beforeInit: () => {},
    afterInit: () => {},
    beforeShutdown: () => {},
    afterShutdown: () => {},
    onError: (context, error) => {},
  },
  registry: { url: 'https://dashboard.example.com/api/services' },
});
```

### ⚠️ Critical Initialization Order

```ts
// ✅ Option 1: manual dotenv
import dotenv from 'dotenv';
dotenv.config();
import { katax } from 'katax-service-manager';

// ✅ Option 2: built-in loadEnv
import { katax } from 'katax-service-manager';
await katax.init({ loadEnv: true });

// ❌ WRONG — katax reads env at usage time, but importing dotenv after katax
// still risks races/ordering bugs; always load env before using services
import { katax } from 'katax-service-manager';
import dotenv from 'dotenv';
dotenv.config();
```

### Internals (init flow)

`katax.init()` guards against concurrent calls — a second call while one is in flight returns the same in-flight `_initPromise` instead of re-running bootstrap. Core service creation (config, logger, app name) is delegated to `BootstrapService.initialize()` (`src/services/bootstrap.service.ts`) rather than done inline in `Katax`; the cron service is not created at init but on the first `katax.cron()`. `loadEnv: true` without `dotenv` installed throws `KataxConfigError`. SIGTERM/SIGINT handlers are registered exactly once (`registerProcessHandlers`/`removeProcessHandlers`) — this pairing matters for tests calling `Katax.reset()` repeatedly, otherwise listeners leak and trigger `MaxListenersExceededWarning`. Registry registration failure is non-fatal (logged as warning, `hooks.onError` called).

`database()` and `socket()` are keyed by name: an existing name returns the cached instance, and a name whose creation is in flight returns the same pending promise (`_pendingDatabases` / `_pendingSockets`) rather than racing a second connection. `cache(name)` and `bridge(...)` are synchronous and cached per Redis name / per redis+socket+streamKey+appName. `heartbeat()` is not cached: every call starts a new one (all are stopped on shutdown).

## Environment Helpers

```ts
katax.env('PORT', '3000');       // string with default
katax.env('PORT', 3000);         // number (auto-cast)
katax.env('DEBUG', false);       // boolean (auto-cast)
katax.envRequired('JWT_SECRET'); // throws KataxConfigError if missing

katax.isDev;     // NODE_ENV === 'development' or unset
katax.isProd;    // NODE_ENV === 'production'
katax.isTest;    // NODE_ENV === 'test'
katax.nodeEnv;   // raw NODE_ENV or 'development'
katax.appName;   // init({ appName }) → KATAX_APP_NAME → npm_package_name → package.json name
katax.version;   // from package.json
```

## Configuration Service

```ts
const port = katax.config.get('PORT', 3000);
const all = (katax.config as ConfigService).getAll(); // getAll() is on the ConfigService class, not on IConfigService
const exists = katax.config.has('API_KEY');
katax.config.set('custom', value);
```

## Lifecycle & Shutdown

```ts
katax.onShutdown(async () => { await cleanupCustomResource(); });
await katax.shutdown(); // closes DBs, sockets, bridges, heartbeats, stops cron, unregisters, closes transports
// SIGTERM/SIGINT handled automatically after init()
```

Shutdown order (`Katax.shutdown` in `src/katax.ts` + `LifecycleService.shutdown`): user `onShutdown` hooks first (run in parallel, failures logged) → `hooks.beforeShutdown` → databases closed (`Promise.allSettled`, one failure doesn't block others) → sockets closed (same pattern) → cron stopped → registry unregistered → logger transports closed → `hooks.afterShutdown` → Redis stream bridges and heartbeats stopped → process signal handlers removed. `shutdown()` before `init()` is a no-op. Errors are collected, not thrown — shutdown always completes even with partial failures.

```ts
interface KataxLifecycleHooks {
  beforeInit?: () => void | Promise<void>;
  afterInit?: () => void | Promise<void>;
  beforeShutdown?: () => void | Promise<void>;
  afterShutdown?: () => void | Promise<void>;
  onError?: (context: string, error: unknown) => void | Promise<void>;
}
```

## Service Override (Testing)

```ts
import { Katax } from 'katax-service-manager';

beforeEach(async () => { await Katax.reset(); }); // awaits shutdown(), clears maps, removes process listeners

katax.overrideService('db:main', mockDb);
katax.overrideService('logger', mockLogger);
katax.overrideService('cron', mockCron);
katax.overrideService('ws:main', mockSocket);
katax.overrideService('cache:cache', mockCache);
katax.overrideService('config', mockConfig);

katax.clearOverride('db:main'); // remove specific
katax.clearOverride();          // remove all
```

## Database Service

```ts
interface DatabaseConfig {
  name?: string;              // ⚠️ optional in the type, but required at runtime (throws KataxDatabaseError if missing)
  type: 'postgresql' | 'mysql' | 'mongodb' | 'redis';
  required?: boolean;         // default true (throw on failure); false → warn + return null
  connection: string | PostgreSQLConnectionOptions | MySQLConnectionOptions | MongoDBConnectionOptions | RedisConnectionOptions;
  pool?: { max?: number; min?: number; idleTimeoutMillis?: number; connectionTimeoutMillis?: number };
  // pool defaults: max 10, min 2, idleTimeoutMillis 30000, connectionTimeoutMillis 30000
}
```

```ts
// PostgreSQL / MySQL
{ host, port?, database, user, password, ssl?: boolean | object } // pg default 5432, mysql default 3306

// MongoDB (or pass a connection string as `connection`)
{ host, port?: 27017, database, user?, password?, authSource? }

// Redis
{ host, port?: 6379, password?, db?: number, tls?: boolean }
```

```ts
const db = await katax.database({ name: 'main', type: 'postgresql', connection: {...}, pool: { max: 10, min: 2 } });
const optionalDb = await katax.database({ name: 'analytics', type: 'postgresql', required: false, connection: {...} });
```

`katax.database()` is overloaded by `type`: `ISqlDatabase` (postgresql/mysql, has `query<T>()`), `IMongoDatabase` (`getClient()` → MongoClient), `IRedisDatabase` (`redis(...args)`); with `required: false` the result is `... | null`.

`katax.db(name)` returns the generic `IDatabaseService` (its `query`/`redis` are optional, so `katax.db('main').query(...)` doesn't compile under `strict`). Narrow it **once**, in a shared helper, and make every repository use the helper:

```ts
// src/shared/db.ts
import { katax } from 'katax-service-manager';
import type { ISqlDatabase } from 'katax-service-manager';

export function db(): ISqlDatabase {
  return katax.db('main') as unknown as ISqlDatabase;  // 'main' is always postgresql (see index.ts)
}

// runtime-checked alternative: (katax.db('main') as DatabaseService).asSql() / .asMongo() / .asRedis()
```

Transactions: there's no transaction API. Use a dedicated client: `const client = (await db().getClient()) as PoolClient` → `BEGIN` / `COMMIT` / `ROLLBACK` / `client.release()` (full `withTransaction()` in the architecture reference). Never send `BEGIN` through `db().query()` — consecutive calls may run on different pooled connections.

Same name returns same instance (`db1 === db2`). Redis clients are created with `RESP: 2` (array-shaped replies, also on Redis 6+/Valkey); reconnect is built-in for katax-managed connections.

## Cache Service

Requires a Redis database connection. High-level API with auto JSON serialization.

```ts
const cache = katax.cache('cache'); // arg = redis db name, default 'cache'
```

| Method | Description |
| --- | --- |
| `get<T>(key)` | Get value, auto-deserialize JSON, `null` if missing |
| `set(key, value, ttl?)` | Set with optional TTL (seconds) |
| `del(key)` | Delete single key |
| `delMany(keys[])` | Delete multiple keys |
| `exists(key)` | Check existence |
| `ttl(key)` | Remaining TTL (-1 no expiry, -2 missing) |
| `expire(key, seconds)` | Set expiration |
| `incr(key)` / `incrBy(key, n)` / `decr(key)` | Counters |
| `mget<T>(keys[])` / `mset([[key, value], ...])` | Batch get/set (`mset` has no TTL) |
| `clear(pattern = '*')` | Delete by pattern; `clear()` / `clear('*')` throws when `NODE_ENV=production` |
| `stats()` | Redis INFO stats |

## Logger Service

Pino-based, custom `'success'` level (displays blue with pino-pretty), WebSocket broadcast, pluggable transports.

```ts
interface LoggerConfig {
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'success';
  prettyPrint?: boolean;    // requires pino-pretty
  enableBroadcast?: boolean;
  destination?: string;
}
```

```ts
katax.logger.info('Server started');                                  // string form
katax.logger.info({ message: 'Server started', port: 3000 });         // object form
katax.logger.success({ message: 'User registered', userId: 123 });
katax.logger.warn(...); katax.logger.error(...); katax.logger.debug(...);
katax.logger.trace(...); katax.logger.fatal(...);
```

`LogConfig` (routing) is separate from `LogMessageObject` (payload data) — never passed to transports:

```ts
interface LogConfig {
  broadcast?: boolean; room?: string; persist?: boolean;
  skipTransport?: boolean; skipTelegram?: boolean; skipRedis?: boolean;
}
logger.info('Payment processed', { persist: true });                          // recommended
logger.info({ message: 'Payment', amount: 100 }, { broadcast: true, room: 'ops' });
logger.info({ message: 'Payment', amount: 100, persist: true });              // legacy, still works, @deprecated
```

```ts
const log = katax.logger.child({ service: 'payments', userId: 123 });
log.info({ message: 'Payment processed' }); // includes bindings
```

### Transports

```ts
import { RedisTransport, TelegramTransport, CallbackTransport } from 'katax-service-manager';

const redisDb = katax.db('redis') as unknown as IRedisDatabase;   // RedisTransport needs IRedisDatabase
const redis = new RedisTransport(redisDb, { streamKey: 'katax:logs', maxLen: 10000 });
redis.filter = (log) => log.level === 'error' || log.persist === true;
katax.logger.addTransport(redis);

const telegram = new TelegramTransport({
  botToken: katax.envRequired('TELEGRAM_BOT_TOKEN'),
  chatId: katax.envRequired('TELEGRAM_ALERTS_CHAT_ID'),
  levels: ['error', 'fatal'], includePersist: true, parseMode: 'Markdown', name: 'telegram-errors',
});
katax.logger.addTransport(telegram);

const callback = new CallbackTransport(async (log) => { await myApi.send(log); }, 'custom'); // (fn, name?)
katax.logger.addTransport(callback);

katax.logger.removeTransport('telegram-errors');
await katax.logger.closeTransports();
(katax.logger as LoggerService).getPinoLogger(); // on the LoggerService class, not on ILoggerService — escape hatch to raw Pino
```

```ts
interface LogTransport {
  name?: string;
  filter?(log: LogEntry): boolean;
  send(log: LogEntry): Promise<void>;
  close?(): Promise<void>;
}
```

## WebSocket Service (Socket.IO)

```ts
interface WebSocketConfig {
  name?: string;             // ⚠️ optional in the type, required at runtime (throws KataxWebSocketError if missing)
  port?: number;              // default 3001 (standalone mode, ignored if httpServer given)
  httpServer?: unknown;        // attach to HTTP server, shared port
  cors?: { origin: string | string[]; credentials?: boolean };
  authToken?: string;
  enableAuth?: boolean;
  authValidator?: (token: string | undefined) => boolean | Promise<boolean>;
}
```

```ts
const httpServer = createServer(app);
await katax.socket({ name: 'main', httpServer, cors: { origin: '*' } }); // preferred, shared port

await katax.socket({ name: 'events', port: 3001, enableAuth: true,
  authValidator: async (token) => token === katax.envRequired('WS_SECRET') });

const ws = katax.ws('main'); // quick lookup, throws KataxWebSocketError if not found
```

| Method | Description |
| --- | --- |
| `emit(event, data, room?)` | Broadcast (optionally scoped to room) |
| `emitToRoom(room, event, data)` | Emit to specific room |
| `on(event, handler)` | Listen for client events |
| `onConnection(handler)` | Handle new connections |
| `hasRoomListeners(room)` / `getRoomClientsCount(room)` | Room state |
| `hasConnectedClients()` / `getConnectedClientsCount()` | Global client state |
| `getServer()` | Raw `SocketIOServer \| null` — on the class, not on `IWebSocketService`: `(ws as unknown as { getServer(): import('socket.io').Server \| null }).getServer()` |
| `close()` | Close the server |

The first socket created also gets wired to the logger for broadcast (`logger.setSocketService`) automatically.

```ts
ws.onConnection((socket) => {
  socket.on('message', (data) => { /* ... */ });
  socket.emit('welcome', { status: 'connected' });
  socket.join('room-123');
  socket.leave('room-123');
});
```

## Cron Service

`node-cron` is loaded on the first `katax.cron()`. `cron()` returns `Promise<void>`: `await` it so an invalid schedule or a missing `node-cron` fails at the call site. `katax.cronService` exists only after the first `await katax.cron(...)` (before that it throws `KataxConfigError`).

```ts
await katax.cron({
  name: 'process-assets',
  schedule: '*/10 6-15 * * 1-5',
  task: processAssets,
  runOnInit: katax.isProd,   // default false
  timezone: 'America/Mexico_City', // default UTC
  enabled: true,              // boolean or () => boolean
});

katax.cronService.getJobs();              // [{ name, schedule, enabled, running }]
await katax.cronService.startJob('process-assets');
katax.cronService.stopJob('process-assets');
katax.cronService.removeJob('process-assets');
katax.cronService.stopAll();
```

## Registry Service

```ts
interface RegistryConfig {
  url?: string;
  handler?: { register?, heartbeat?, unregister? }; // custom non-HTTP integration
  apiKey?: string;
  heartbeatInterval?: number;   // default 30000
  requestTimeoutMs?: number;    // default 5000
  retryAttempts?: number;       // default 2
  retryBaseDelayMs?: number;    // default 300
  metadata?: Record<string, unknown>;
}

katax.isRegistered;
katax.getServiceInfo(); // ServiceInfo, or null when init() had no `registry` — name, version, hostname, platform, arch, nodeVersion, pid, uptime, memory, metadata, timestamp
```

## Health Check

```ts
const health = await katax.healthCheck();
// { status: 'healthy' | 'degraded' | 'unhealthy',
//   services: { databases: Record<string, boolean>, sockets: Record<string, boolean>, cron: boolean },
//   timestamp: number }
// any failed DB ping / socket / cron check → 'degraded'; every database failing → 'unhealthy'

app.get('/api/health', async (req, res) => {
  const health = await katax.healthCheck();
  const code = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 503 : 500;
  res.status(code).json(health);
});
```

## Redis Stream Bridge

Broadcasts logs from Redis Stream to WebSocket. Filters by `appName`, supports multiple apps on the same Redis.

```ts
const bridge = katax.bridge('cache', 'main', {
  appName: 'my-api',
  streamKey: 'katax:logs',              // default
  group: 'katax-bridge-my-api',         // default: katax-bridge-${appName}
  batchSize: 10,                        // default
  blockTimeout: 2000,                   // default
});
await bridge.start();
bridge.isRunning();
bridge.stop();

// client events: subscribe-project(appName) → 'project-history' + 'log'; unsubscribe-project(appName)
```

## Heartbeat & Registration Helpers

```ts
// managed — auto-cleanup on shutdown
katax.heartbeat({ app: katax.appName, port: 3000, version: katax.version, intervalMs: 10000 }, 'cache', 'main');

// manual helpers
import { registerProjectInRedis, registerVersionToRedis, startHeartbeat } from 'katax-service-manager';
await registerProjectInRedis(redisDb, { app: katax.appName, version: katax.version, port: PORT });
const hb = startHeartbeat(redisDb, { app: katax.appName, port: PORT, intervalMs: 10000 }, ws);
hb.stop();   // ttlSeconds default 60, intervalMs default (ttl − 10) s
```

## Error Classes

All extend `KataxServiceError` (`code`, `message`, `details?`). Codes: `KATAX_CONFIG_ERROR`, `KATAX_NOT_INITIALIZED`, `KATAX_DATABASE_ERROR`, `KATAX_REDIS_ERROR`, `KATAX_WEBSOCKET_ERROR`, `KATAX_REGISTRY_ERROR`.

```ts
import {
  KataxServiceError, KataxConfigError, KataxNotInitializedError,
  KataxDatabaseError, KataxRedisError, KataxWebSocketError, KataxRegistryError,
} from 'katax-service-manager';

try { await katax.init({ loadEnv: true }); }
catch (e) { if (e instanceof KataxConfigError) { /* handle */ } }
```

## Bootstrap Template (real, from api-habit-forge)

PostgreSQL + Redis + Socket.IO on the Express port + dashboard log streams. Everything dashboard-related is **non-fatal**: an unreachable dashboard must never stop the API from booting.

```ts
import { katax, RedisTransport } from 'katax-service-manager';
import type { IRedisDatabase } from 'katax-service-manager';
import { createServer } from 'http';
import app from './app.js';
import { initDashboardRegistry } from './registry/dashboard-registry.js';

async function bootstrap(): Promise<void> {
  try {
    await katax.init({
      loadEnv: true, // dotenv, no manual dotenv.config()
      logger: { level: katax.env('LOG_LEVEL', 'info') as 'info', prettyPrint: katax.isDev },
    });

    await katax.database({
      name: 'main',
      type: 'postgresql',
      connection: {
        host: katax.envRequired('DB_HOST'),
        port: parseInt(katax.env('DB_PORT', '5432')),
        database: katax.envRequired('DB_NAME'),
        user: katax.envRequired('DB_USER'),
        password: katax.envRequired('DB_PASSWORD'),
      },
    });

    await katax.database({
      name: 'redis',
      type: 'redis',
      connection: {
        host: katax.env('REDIS_HOST', 'localhost'),
        port: parseInt(katax.env('REDIS_PORT', '6379')),
        password: katax.env('REDIS_PASSWORD'),
        db: parseInt(katax.env('REDIS_DB', '0')),
      },
    });

    const PORT = katax.env('PORT', '3000');
    const httpServer = createServer(app);
    await katax.socket({ name: 'main', httpServer }); // same port as Express

    let dashboard: { stop: () => Promise<void> } | null = null;
    try {
      const redisDb = katax.db('redis') as unknown as IRedisDatabase;
      katax.logger.addTransport(new RedisTransport(redisDb, { streamKey: 'katax:logs' }));
      const dashboardTransport = new RedisTransport(redisDb, { streamKey: 'katax:dashboard' });
      dashboardTransport.filter = (log) => log.level === 'error' || log.level === 'info';
      katax.logger.addTransport(dashboardTransport);

      dashboard = await initDashboardRegistry({ appName: katax.appName, version: katax.version, port: PORT, intervalMs: 10000 });

      await katax.bridge('redis', 'main', { appName: katax.appName, streamKey: 'katax:logs' }).start();
      await katax.bridge('redis', 'main', { appName: katax.appName, streamKey: 'katax:dashboard' }).start();
    } catch (err) {
      katax.logger.warn({ message: 'Dashboard setup failed (non-fatal)', err });
    }

    httpServer.listen(PORT, () => katax.logger.info({ message: `Server + WebSocket on http://localhost:${PORT}` }));

    katax.onShutdown(async () => { await dashboard?.stop(); });
    // SIGTERM/SIGINT → katax.shutdown() are registered by katax.init()
  } catch (err) {
    console.error('Failed to start application:', err);
    process.exit(1);
  }
}

void bootstrap();
```

`registry/dashboard-registry.ts` (same file in api-habit-forge, api-second-brain, api-my-routine, api-property-scout): reads `DASHBOARD_API_BASE_URL` + `DASHBOARD_API_KEY` (skips if missing), registers over HTTP on first run and saves the assigned `katax.dashboardProjectId` into `package.json`, then sends heartbeats every `intervalMs`; `stop()` clears the interval. Copy it from an existing project rather than reinventing it.

## Repo Internals (working inside katax-service-manager itself)

- ESM-only (`"type": "module"`), TS 5.7, built with `tsc --build`. All DB/WS/cron/pino-pretty/dotenv deps are optional peer dependencies, dynamically imported.
- `src/index.ts` is the sole export barrel — new public symbols must be re-exported there.
- `src/types.ts` holds every public interface/config shape. `IDatabaseService`/`ISqlDatabase`/`IMongoDatabase`/`IRedisDatabase` are narrowed interfaces so callers get compile-time guarantees per DB type.
- Service classes live in `src/services/`, one file per concern, composed (not inherited) by `Katax` in `src/katax.ts`. `bootstrap.service.ts` handles init-time construction, `lifecycle.service.ts` handles shutdown orchestration — both exist specifically to keep `Katax` itself thin.
- `src/services/transports/` holds pluggable `LogTransport` implementations.
- Tests are colocated `*.test.ts` next to source (not a separate `tests/` dir). `katax-audit-regressions.test.ts` specifically locks in previously-fixed bugs (reset() listener leaks, concurrent-init races, silent catches) — check it before touching anything that resembles those patterns.

### Commands

```bash
npm run build          # tsc --build (prebuild runs clean = rimraf dist)
npm run dev              # tsx watch src/index.ts
npm test                  # vitest (watch mode)
npm run test:coverage     # vitest --coverage
npm run typecheck         # tsc --noEmit
npm run lint               # eslint src --ext .ts
npm run format              # prettier --write "src/**/*.ts"
```

```bash
npx vitest run src/services/database.service.test.ts   # single file
npx vitest run -t "asRedis"                              # single test name
```

## Common Gotchas

- `DatabaseConfig.name` and `WebSocketConfig.name` are typed optional but **required at runtime** — throws `KataxDatabaseError`/`KataxWebSocketError` immediately if omitted.
- `config.getAll()`, `logger.getPinoLogger()`, `ws.getServer()` and `db.asSql()/asMongo()/asRedis()` exist on the concrete classes but are **not** on the public interfaces — cast to the class (`ConfigService`, `LoggerService`, `DatabaseService`) to use them.
- `katax.db(name)` is typed `IDatabaseService`: narrow it once in `shared/db.ts` (`db()`), don't cast in every repository.
- `await katax.cron(...)` before touching `katax.cronService`.
- Never call `katax.db()`/`katax.ws()` before `katax.init()` resolves — throws `KataxNotInitializedError`.
- `required: false` on `database()` → logs warning and returns `null` instead of throwing on connection failure.
- Redis reconnect is built-in for katax-managed connections; only customize `reconnectStrategy` for Redis clients created outside katax.
- `Katax.reset()` is async — always `await` it in test teardown, it awaits `shutdown()` and removes process listeners.
