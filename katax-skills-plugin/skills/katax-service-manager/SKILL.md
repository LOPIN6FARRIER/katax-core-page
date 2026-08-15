---
name: katax-service-manager
description: 'Runtime service container (singleton) for Node.js apps — manages config, Pino logging, database pools (PostgreSQL/MySQL/MongoDB/Redis), WebSocket (Socket.IO), cron, cache, registry, health checks, and graceful shutdown. Use when: bootstrapping a Katax-based app, wiring databases/websocket/cron/cache, debugging init order or shutdown, working directly inside the katax-service-manager repo itself.'
argument-hint: 'What part of katax-service-manager? (bootstrap/database/logger/websocket/cron/cache/registry/shutdown/internals)'
---

# katax-service-manager — Runtime Service Container

Singleton service container for Node.js apps: config, logger, database pools, WebSocket, cron, cache, registry, health, graceful shutdown. Part of the [Katax ecosystem](https://github.com/LOPIN6FARRIER/katax-service-manager) alongside `katax-core` (validation) and `katax-cli` (scaffolding).

**Version: 0.5.9** | ESM-only | Node >= 18 | `npm install katax-service-manager`

All DB/WS/cron/pino-pretty/dotenv dependencies are **optional peer dependencies**, dynamically imported — the package works with none installed until a feature needing them is used.

## Quick Start

```ts
import { katax } from 'katax-service-manager';

await katax.init({ loadEnv: true });

const db = await katax.database({
  name: 'main',
  type: 'postgresql',
  connection: { host: 'localhost', user: 'admin', password: 'secret', database: 'myapp' },
});

const users = await db.query('SELECT * FROM users WHERE active = $1', [true]);
katax.logger.info({ message: 'App started', users: users.length });

process.on('SIGTERM', async () => {
  await katax.shutdown();
  process.exit(0);
});
```

## Public Surface Summary

| Category   | Exports |
| ---------- | ------- |
| Core       | `Katax`, `katax` |
| Services   | `ConfigService`, `LoggerService`, `DatabaseService`, `WebSocketService`, `CronService`, `CacheService`, `RegistryService`, `RedisStreamBridgeService` |
| Errors     | `KataxServiceError`, `KataxConfigError`, `KataxNotInitializedError`, `KataxDatabaseError`, `KataxRedisError`, `KataxWebSocketError`, `KataxRegistryError` |
| Transports | `RedisTransport`, `CallbackTransport`, `TelegramTransport` |
| Helpers    | `registerVersionToRedis`, `startHeartbeat`, `registerProjectInRedis` |

## Singleton vs Isolated Instance

```ts
import { Katax, katax } from 'katax-service-manager';

katax.init();                 // pre-exported singleton (recommended)
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

`katax.init()` guards against concurrent calls — a second call while one is in flight returns the same in-flight `_initPromise` instead of re-running bootstrap. Core service creation (config, logger, cron) is delegated to `BootstrapService.initialize()` (`src/services/bootstrap.service.ts`) rather than done inline in `Katax`. SIGTERM/SIGINT handlers are registered exactly once (`registerProcessHandlers`/`removeProcessHandlers`) — this pairing matters for tests calling `Katax.reset()` repeatedly, otherwise listeners leak and trigger `MaxListenersExceededWarning`. Registry registration failure is non-fatal (logged as warning, `hooks.onError` called).

`database()`, `socket()`, `cron()`, `cache()`, `bridge()`, `heartbeat()` are all lazy and keyed by name: an existing name returns the cached instance; a name with creation in-flight returns the same pending promise rather than racing a second connection.

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
katax.appName;   // from package.json
katax.version;   // from package.json
```

## Configuration Service

```ts
const port = katax.config.get('PORT', 3000);
const all = katax.config.getAll();   // ⚠️ real method on ConfigService, NOT on public IConfigService type
const exists = katax.config.has('API_KEY');
katax.config.set('custom', value);
```

## Lifecycle & Shutdown

```ts
katax.onShutdown(async () => { await cleanupCustomResource(); });
await katax.shutdown(); // closes DBs, sockets, bridges, heartbeats, stops cron, unregisters, closes transports
// SIGTERM/SIGINT handled automatically after init()
```

Shutdown order (`LifecycleService.shutdown`, `src/services/lifecycle.service.ts`): user `onShutdown` hooks run first → `hooks.beforeShutdown` → databases closed (`Promise.allSettled`, one failure doesn't block others) → sockets closed (same pattern) → cron stopped → registry unregistered → logger transports closed → `hooks.afterShutdown`. Errors are collected, not thrown — shutdown always completes even with partial failures.

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

beforeEach(() => Katax.reset()); // awaits shutdown(), clears maps, removes process listeners

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

// MongoDB
{ uri: string } | { host, port?: 27017, database, user?, password? }

// Redis
{ host, port?: 6379, password?, db?: number, tls?: boolean }
```

```ts
const db = await katax.database({ name: 'main', type: 'postgresql', connection: {...}, pool: { max: 10, min: 2 } });
const optionalDb = await katax.database({ name: 'analytics', type: 'postgresql', required: false, connection: {...} });

const db2 = katax.db('main'); // quick lookup, throws KataxDatabaseError if not found
db2.asSql();    // → ISqlDatabase, throws if not postgresql/mysql
db2.asMongo();  // → IMongoDatabase, throws if not mongodb
db2.asRedis();  // → IRedisDatabase, throws if not redis
```

Same name returns same instance (`db1 === db2`). `db.query()` only for SQL. Redis reconnect is built-in for katax-managed connections; only customize `reconnectStrategy` for external custom clients.

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
| `mget<T>(keys[])` / `mset(entries[])` | Batch get/set |
| `clear(pattern?)` | Delete by pattern (disabled for `'*'` in production) |
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

const redis = new RedisTransport(katax.db('cache'), { streamKey: 'katax:logs', maxLen: 10000 });
redis.filter = (log) => log.level === 'error' || log.persist === true;
katax.logger.addTransport(redis);

const telegram = new TelegramTransport({
  botToken: katax.envRequired('TELEGRAM_BOT_TOKEN'),
  chatId: katax.envRequired('TELEGRAM_ALERTS_CHAT_ID'),
  levels: ['error', 'fatal'], includePersist: true, parseMode: 'Markdown', name: 'telegram-errors',
});
katax.logger.addTransport(telegram);

const callback = new CallbackTransport({ name: 'custom', send: async (log) => { /* ... */ }, filter: (log) => log.level === 'error' });
katax.logger.addTransport(callback);

katax.logger.removeTransport('telegram-errors');
await katax.logger.closeTransports();
katax.logger.getPinoLogger(); // ⚠️ real method on LoggerService, NOT on public ILoggerService type — escape hatch to raw Pino
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
| `getServer()` | Raw `SocketIOServer \| null` |
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

```ts
katax.cron({
  name: 'process-assets',
  schedule: '*/10 6-15 * * 1-5',
  task: processAssets,
  runOnInit: katax.isProd,   // default false
  timezone: 'America/Mexico_City', // default UTC
  enabled: true,              // boolean or () => boolean
});

katax.cronService.getJobs();              // [{ name, schedule, enabled, running }]
katax.cronService.startJob('process-assets');
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
katax.getServiceInfo(); // ServiceInfo | null — name, version, hostname, platform, arch, nodeVersion, pid, uptime, memory, metadata, timestamp
```

## Health Check

```ts
const health = await katax.healthCheck();
// { status: 'healthy' | 'degraded' | 'unhealthy',
//   services: { databases: Record<string, boolean>, sockets: Record<string, boolean>, cron: boolean },
//   timestamp: number }

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
hb?.stop();
```

## Error Classes

All extend `KataxServiceError` (`code`, `message`, `details`):

```ts
import {
  KataxServiceError, KataxConfigError, KataxNotInitializedError,
  KataxDatabaseError, KataxRedisError, KataxWebSocketError, KataxRegistryError,
} from 'katax-service-manager';

try { await katax.init({ loadEnv: true }); }
catch (e) { if (e instanceof KataxConfigError) { /* handle */ } }
```

## Bootstrap Template

```ts
import dotenv from 'dotenv';
dotenv.config();

import { katax } from 'katax-service-manager';
import { createServer } from 'http';
import app from './app.js';

async function bootstrap(): Promise<void> {
  try {
    await katax.init({
      loadEnv: true,
      logger: { level: katax.env('LOG_LEVEL', 'info') as any, prettyPrint: katax.isDev, enableBroadcast: true },
    });

    await katax.database({
      name: 'main', type: 'postgresql',
      connection: {
        host: katax.envRequired('DB_HOST'), port: katax.env('DB_PORT', 5432),
        database: katax.envRequired('DB_NAME'), user: katax.envRequired('DB_USER'), password: katax.envRequired('DB_PASSWORD'),
      },
      pool: { max: 10, min: 2 },
    });

    await katax.database({ name: 'cache', type: 'redis', connection: { host: katax.env('REDIS_HOST', '127.0.0.1'), port: 6379 } });

    const PORT = katax.env('PORT', '3000');
    const httpServer = createServer(app);
    await katax.socket({ name: 'main', httpServer, cors: { origin: '*' } });

    katax.cron({ name: 'cleanup', schedule: '0 3 * * *', task: async () => { /* nightly cleanup */ } });

    httpServer.listen(PORT, () => katax.logger.info({ message: `Server running on http://localhost:${PORT}` }));
  } catch (err) {
    console.error('Bootstrap failed:', err);
    process.exit(1);
  }
}

void bootstrap();
```

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
- `config.getAll()` and `logger.getPinoLogger()` exist on the concrete classes but are **not** part of the public `IConfigService`/`ILoggerService` interfaces — usable, but not guaranteed by the typed contract.
- Never call `katax.db()`/`katax.ws()` before `katax.init()` resolves — throws `KataxNotInitializedError`.
- `required: false` on `database()` → logs warning and returns `null` instead of throwing on connection failure.
- Redis reconnect is built-in for katax-managed connections; only customize `reconnectStrategy` for Redis clients created outside katax.
- `Katax.reset()` is async — always `await` it in test teardown, it awaits `shutdown()` and removes process listeners.
