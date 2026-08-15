# katax-service-manager — Application Bootstrap

Singleton service container managing the full lifecycle: config, logger, databases, WebSocket, cron, cache, registry, health, graceful shutdown. Full package docs also live in the standalone `katax-service-manager` skill — this reference exists so `katax-ecosystem` alone still has the complete API.

## Public Surface Summary

| Category   | Exports |
| ---------- | ------- |
| Core       | `Katax`, `katax` |
| Services   | `ConfigService`, `LoggerService`, `DatabaseService`, `WebSocketService`, `CronService`, `CacheService`, `RegistryService`, `RedisStreamBridgeService` |
| Errors     | `KataxServiceError`, `KataxConfigError`, `KataxNotInitializedError`, `KataxDatabaseError`, `KataxRedisError`, `KataxWebSocketError`, `KataxRegistryError` |
| Transports | `RedisTransport`, `CallbackTransport`, `TelegramTransport` |
| Helpers    | `registerVersionToRedis`, `startHeartbeat`, `registerProjectInRedis` |

## Initialization

```ts
import { katax } from 'katax-service-manager';

await katax.init({
  loadEnv: true, // Auto-load .env (requires dotenv)
  appName: 'my-api', // Override (defaults to package.json)
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

## ⚠️ Critical Initialization Order

```ts
// ✅ CORRECT — Option 1: Manual dotenv
import dotenv from 'dotenv';
dotenv.config();
import { katax } from 'katax-service-manager';

// ✅ CORRECT — Option 2: Built-in loadEnv (v0.5+)
import { katax } from 'katax-service-manager';
await katax.init({ loadEnv: true });

// ❌ WRONG — katax reads env at import time, before dotenv
import { katax } from 'katax-service-manager';
import dotenv from 'dotenv';
dotenv.config();
```

1. ✅ Use either manual `dotenv.config()` before importing `katax` or `await katax.init({ loadEnv: true })`
2. ✅ ALWAYS call `katax.init()` before using runtime services
3. ❌ NEVER use `katax.db()` or `katax.ws()` before `katax.init()` completes

## Environment Helpers

```ts
katax.env('PORT', '3000'); // string with default
katax.env('PORT', 3000); // number (auto-cast)
katax.env('DEBUG', false); // boolean (auto-cast)
katax.envRequired('JWT_SECRET'); // throws if missing

katax.isDev; // NODE_ENV === 'development' or not set
katax.isProd; // NODE_ENV === 'production'
katax.isTest; // NODE_ENV === 'test'
katax.nodeEnv; // raw NODE_ENV string
katax.appName; // from package.json name
katax.version; // from package.json version
```

## Configuration Service

```ts
const port = katax.config.get('PORT', 3000);
const exists = katax.config.has('API_KEY');
katax.config.set('custom', value);
katax.config.getAll(); // ⚠️ exists on ConfigService, not on the public IConfigService type
```

## Lifecycle & Shutdown

```ts
// Register custom shutdown hooks
katax.onShutdown(async () => {
  await cleanupCustomResource();
});

// Graceful shutdown (closes all services in order)
await katax.shutdown();

// Automatic signal handling (SIGTERM, SIGINT) registered during init()
```

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

beforeEach(() => Katax.reset());

katax.overrideService('db:main', mockDb);
katax.overrideService('logger', mockLogger);
katax.overrideService('cron', mockCron);
katax.overrideService('ws:main', mockSocket);
katax.overrideService('cache:redis', mockCache);

katax.clearOverride('db:main'); // Remove specific
katax.clearOverride(); // Remove all
```

## Database Service

### Configuration

```ts
interface DatabaseConfig {
  name: string;
  type: 'postgresql' | 'mysql' | 'mongodb' | 'redis';
  required?: boolean; // Default: true (throw on failure)
  connection: string | ConnectionOptions;
  pool?: {
    max?: number; // Default: 10
    min?: number; // Default: 2
    idleTimeoutMillis?: number; // Default: 30000
    connectionTimeoutMillis?: number; // Default: 30000
  };
}
```

### Connection Options

```ts
// PostgreSQL
{ host, port?: 5432, database, user, password, ssl?: boolean | object }

// MySQL
{ host, port?: 3306, database, user, password, ssl?: boolean | object }

// MongoDB
{ uri: string } | { host, port?: 27017, database, user?, password? }

// Redis
{ host, port?: 6379, password?, db?: number, tls?: boolean }
```

### Database Setup & Access

```ts
// Create
await katax.database({
  name: 'main',
  type: 'postgresql',
  connection: {
    host: katax.envRequired('DB_HOST'),
    port: katax.env('DB_PORT', 5432),
    database: katax.envRequired('DB_NAME'),
    user: katax.envRequired('DB_USER'),
    password: katax.envRequired('DB_PASSWORD'),
  },
  pool: { max: 10, min: 2 },
});

// Optional database (won't crash on failure)
await katax.database({
  name: 'analytics',
  type: 'postgresql',
  required: false,
  connection: { ... },
});

// Redis
await katax.database({
  name: 'cache',
  type: 'redis',
  connection: {
    host: katax.env('REDIS_HOST', '127.0.0.1'),
    port: katax.env('REDIS_PORT', 6379),
    password: katax.env('REDIS_PASSWORD', ''),
    db: 0,
  },
});

// Retrieve — generic
const db = katax.db('main');

// Retrieve — type-cast methods
db.asSql();    // → ISqlDatabase (throws if not PostgreSQL/MySQL)
db.asMongo();  // → IMongoDatabase (throws if not MongoDB)
db.asRedis();  // → IRedisDatabase (throws if not Redis)
```

### Typed Interfaces

```ts
interface ISqlDatabase {
  readonly config: DatabaseConfig;
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T>;
  getClient(): Promise<unknown>;
  close(): Promise<void>;
}

interface IMongoDatabase {
  readonly config: DatabaseConfig;
  getClient(): Promise<unknown>; // Returns MongoClient
  close(): Promise<void>;
}

interface IRedisDatabase {
  readonly config: DatabaseConfig;
  redis(...args: (string | number | Buffer)[]): Promise<unknown>;
  close(): Promise<void>;
}
```

### Redis Reconnect

From v0.5+, reconnect strategy is built-in by default. For custom Redis clients outside katax:

```ts
const client = createClient({
  url: 'redis://localhost:6379',
  socket: { reconnectStrategy: (retries) => Math.min(retries * 100, 3000) },
});
```

### Database Gotchas

- `db.query()` only works for SQL (PostgreSQL/MySQL)
- Redis: prefer `db.getClient()` for typed, `db.redis()` uses raw `sendCommand`
- Redis reconnect is built-in; only customize for external clients
- Use `asSql()`, `asRedis()` for type-safe casting
- MongoDB → `db.getClient().db().collection()`
- `required: false` on databases → app continues if connection fails; always check for `null` before use

## Cache Service

Requires a Redis database. High-level API with auto JSON serialization.

```ts
const cache = katax.cache('cache'); // 'cache' = redis db name
```

| Method                  | Description                                    |
| ------------------------ | ----------------------------------------------- |
| `get<T>(key)`           | Get value (auto-deserializes JSON)             |
| `set(key, value, ttl?)` | Set with optional TTL (seconds)                |
| `del(key)`              | Delete single key                              |
| `delMany(keys[])`       | Delete multiple keys                           |
| `exists(key)`           | Check key existence                            |
| `ttl(key)`              | Get remaining TTL (-1 no expiry, -2 missing)   |
| `expire(key, seconds)`  | Set expiration                                 |
| `incr(key)`             | Increment by 1                                 |
| `incrBy(key, n)`        | Increment by amount                            |
| `decr(key)`             | Decrement by 1                                 |
| `mget<T>(keys[])`       | Get multiple values                            |
| `mset(entries[])`       | Set multiple `[key, value]` pairs              |
| `clear(pattern?)`       | Delete by pattern (disabled on prod for `'*'`) |
| `stats()`               | Get Redis stats                                |

```ts
await cache.set('user:123', userData, 3600);
const user = await cache.get<User>('user:123');
await cache.del('user:123');
const exists = await cache.exists('session:abc');
await cache.incr('page:views');
await cache.mset([
  ['k1', v1],
  ['k2', v2],
]);
```

## Logger Service

Pino-based structured logging with WebSocket broadcasting and transport system.

```ts
interface LoggerConfig {
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'success';
  prettyPrint?: boolean;
  enableBroadcast?: boolean;
  destination?: string;
}
```

### Log Methods

All accept string or object:

```ts
katax.logger.info('Server started');
katax.logger.info({ message: 'Server started', port: 3000 });
katax.logger.success({ message: 'User registered successfully', userId: 123 });
katax.logger.warn({ message: 'Redis unavailable' });
katax.logger.error({ message: 'Query failed', error: err, query: sql });
katax.logger.debug({ message: 'Cache hit', key });
katax.logger.trace({ message: 'Detailed trace' });
katax.logger.fatal({ message: 'Unrecoverable error' });
```

### Log Message Object Fields

```ts
interface LogMessageObject {
  message: string; // Required
  broadcast?: boolean; // Emit to WebSocket
  room?: string; // Target WebSocket room
  persist?: boolean; // Force persist to transports
  skipTransport?: boolean; // Skip ALL transports
  skipTelegram?: boolean; // Skip Telegram only
  skipRedis?: boolean; // Skip Redis only
  error?: string | Error;
  stack?: string;
  code?: string | number;
  userId?: string | number;
  requestId?: string;
  duration?: number;
  statusCode?: number;
  method?: string;
  path?: string;
  ip?: string;
  [key: string]: unknown; // Custom fields
}
```

### Child Logger

```ts
const log = katax.logger.child({ service: 'payments', userId: 123 });
log.info({ message: 'Payment processed' });
```

### Transports

```ts
import { RedisTransport, TelegramTransport, CallbackTransport } from 'katax-service-manager';

// Redis — persist logs to Redis Stream
const redis = new RedisTransport(katax.db('cache'), {
  streamKey: 'katax:logs',
});
redis.filter = (log) => log.level === 'error' || log.persist === true;
katax.logger.addTransport(redis);

// Telegram — critical alerts
const telegram = new TelegramTransport({
  botToken: katax.envRequired('TELEGRAM_BOT_TOKEN'),
  chatId: katax.envRequired('TELEGRAM_ALERTS_CHAT_ID'),
  levels: ['error', 'fatal'],
  includePersist: true,
  parseMode: 'Markdown',
  name: 'telegram-errors',
});
katax.logger.addTransport(telegram);

// Callback — custom handler
const callback = new CallbackTransport({
  name: 'custom',
  send: async (log) => {
    /* custom logic */
  },
  filter: (log) => log.level === 'error',
});
katax.logger.addTransport(callback);

// Management
katax.logger.removeTransport('telegram-errors');
await katax.logger.closeTransports();
katax.logger.getPinoLogger(); // ⚠️ escape hatch: exists on LoggerService, not on the public ILoggerService type
```

### Logger Gotchas

- Strings and objects are both valid
- Use objects for metadata: `{ message, ...meta }`
- `broadcast: true` → emits to WebSocket
- `persist: true` → forces Redis transport
- `skipTransport: true` → avoids feedback loops
- `skipTelegram: true` / `skipRedis: true` → selective skip
- `logger.info('text')` or `logger.info({ message: 'text' })` — `message` is required either way

## WebSocket Service (Socket.IO)

```ts
interface WebSocketConfig {
  name: string;
  port?: number; // Default: 3001 (standalone)
  httpServer?: unknown; // Attach to HTTP server (shared port)
  cors?: { origin: string | string[]; credentials?: boolean };
  authToken?: string;
  enableAuth?: boolean;
  authValidator?: (token: string | undefined) => boolean | Promise<boolean>;
}
```

```ts
// Attached to Express (shared port — preferred)
const httpServer = createServer(app);
await katax.socket({
  name: 'main',
  httpServer,
  cors: { origin: '*' },
});

// Standalone with auth
await katax.socket({
  name: 'events',
  port: 3001,
  enableAuth: true,
  authValidator: async (token) => token === katax.envRequired('WS_SECRET'),
});

const ws = katax.ws('main');
```

| Method                          | Description                     |
| --------------------------------- | ---------------------------------- |
| `emit(event, data, room?)`      | Emit event (optionally to room) |
| `emitToRoom(room, event, data)` | Emit to specific room           |
| `on(event, handler)`            | Listen for events               |
| `onConnection(handler)`         | Handle new connections          |
| `hasRoomListeners(room)`        | Check room has listeners        |
| `getRoomClientsCount(room)`     | Count clients in room           |
| `hasConnectedClients()`         | Any clients connected?          |
| `getConnectedClientsCount()`    | Total connected clients         |
| `getServer()`                   | Get underlying Socket.IO server |
| `close()`                       | Close WebSocket server          |

```ts
ws.onConnection((socket) => {
  socket.on('message', (data) => { ... });
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
  runOnInit: katax.isProd,
  timezone: 'America/Mexico_City',
  enabled: true,
});

katax.cronService.getJobs();
katax.cronService.startJob('process-assets');
katax.cronService.stopJob('process-assets');
katax.cronService.removeJob('process-assets');
katax.cronService.stopAll();
```

## Registry Service

```ts
interface RegistryConfig {
  url?: string;
  handler?: {
    register?: (info: ServiceInfo) => Promise<void>;
    heartbeat?: (info: ServiceInfo) => Promise<void>;
    unregister?: (payload) => Promise<void>;
  };
  apiKey?: string;
  heartbeatInterval?: number; // Default: 30000
  requestTimeoutMs?: number; // Default: 5000
  retryAttempts?: number; // Default: 2
  retryBaseDelayMs?: number; // Default: 300
  metadata?: Record<string, unknown>;
}

interface ServiceInfo {
  name: string;
  version: string;
  hostname: string;
  platform: NodeJS.Platform;
  arch: string;
  nodeVersion: string;
  pid: number;
  uptime: number;
  memory: { rss: number; heapTotal: number; heapUsed: number };
  metadata?: Record<string, unknown>;
  timestamp: number;
}

katax.isRegistered;
katax.getServiceInfo();
```

## Health Check

```ts
const health = await katax.healthCheck();
// { status: 'healthy' | 'degraded' | 'unhealthy',
//   services: { databases: {}, sockets: {}, cron: boolean },
//   timestamp: number }

app.get('/api/health', async (req, res) => {
  const health = await katax.healthCheck();
  const code = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 503 : 500;
  res.status(code).json(health);
});
```

## Redis Stream Bridge

```ts
const bridge = katax.bridge('cache', 'main', {
  appName: 'my-api',
  streamKey: 'katax:logs',
  group: 'katax-bridge-my-api',
  batchSize: 10,
  blockTimeout: 2000,
});
await bridge.start();
bridge.isRunning();
bridge.stop();

// Client events:
// subscribe-project(appName) → 'project-history' + 'log'
// unsubscribe-project(appName)
```

## Heartbeat & Registration Helpers

```ts
// Managed (auto-cleanup on shutdown)
katax.heartbeat(
  { app: katax.appName, port: 3000, version: katax.version, intervalMs: 10000 },
  'cache',
  'main'
);

// Manual helpers
import {
  registerProjectInRedis,
  registerVersionToRedis,
  startHeartbeat,
} from 'katax-service-manager';
await registerProjectInRedis(redisDb, { app: katax.appName, version: katax.version, port: PORT });
const hb = startHeartbeat(redisDb, { app: katax.appName, port: PORT, intervalMs: 10000 }, ws);
hb?.stop();
```

Use this managed-heartbeat + registry-helper combination as a unit, not piecemeal — it's how a Katax service "joins the fleet" so a dashboard/other service can see it's alive. See `references/production-hardening.md` for how this fits into a full production setup.

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
      logger: {
        level: katax.env('LOG_LEVEL', 'info') as any,
        prettyPrint: katax.isDev,
        enableBroadcast: true,
      },
    });

    await katax.database({
      name: 'main',
      type: 'postgresql',
      connection: {
        host: katax.envRequired('DB_HOST'),
        port: katax.env('DB_PORT', 5432),
        database: katax.envRequired('DB_NAME'),
        user: katax.envRequired('DB_USER'),
        password: katax.envRequired('DB_PASSWORD'),
      },
      pool: { max: 10, min: 2 },
    });

    await katax.database({
      name: 'cache',
      type: 'redis',
      connection: { host: katax.env('REDIS_HOST', '127.0.0.1'), port: 6379 },
    });

    const PORT = katax.env('PORT', '3000');
    const httpServer = createServer(app);
    await katax.socket({ name: 'main', httpServer, cors: { origin: '*' } });

    katax.cron({
      name: 'cleanup',
      schedule: '0 3 * * *',
      task: async () => {
        /* nightly cleanup */
      },
    });

    httpServer.listen(PORT, () => {
      katax.logger.info({ message: `Server running on http://localhost:${PORT}` });
    });
  } catch (err) {
    console.error('Bootstrap failed:', err);
    process.exit(1);
  }
}

void bootstrap();
```
