# katax-cli — Project & Endpoint Generator

CLI tool for scaffolding katax-based APIs and managing VPS deployments. Full package docs also live in the standalone `katax-cli` skill — this reference exists so `katax-ecosystem` alone still has the complete API.

## All Commands

### `katax init [project-name]`

Scaffolds a complete Express + TypeScript + katax-core API project.

| Flag               | Description                              |
| -------------------- | ------------------------------------------ |
| `-f, --force`      | Overwrite existing directory             |
| `--pm <npm\|pnpm>` | Package manager (default: pnpm)          |
| `--ignore-scripts` | Disable lifecycle scripts                |
| `--write-npmrc`    | Write `.npmrc` for reproducible installs |

Interactive prompts: project name/description, database (PostgreSQL/MySQL/MongoDB/None), auth (JWT/None), validation (katax-core/None), Swagger/OpenAPI, katax-service-manager mode (singleton/instance), registry, lifecycle hooks, Redis cache, WebSocket/Socket.IO, port, git init.

### `katax add endpoint <name>`

Scaffolds a single endpoint with 4 files: validator, controller, handler, routes.

| Flag                    | Description                                 |
| ------------------------- | ---------------------------------------------- |
| `-m, --method <method>` | HTTP method (GET, POST, PUT, DELETE), default `POST` |
| `-p, --path <path>`     | Custom route path                           |

Supports interactive field definition (name, type, required, validation rules). Auto-updates main router and regenerates OpenAPI docs.

### `katax generate crud <resource-name>`

Generates full CRUD (5 endpoints): list, get by ID, create, update, delete.

| Flag        | Description          |
| ------------- | ----------------------- |
| `--no-auth` | Skip auth middleware |

### `katax generate repository <name>`

Database access layer. Detects DB type from package.json. Generates typed methods: `findAll()`, `findById()`, `create()`, `update()`, `delete()`. Uses `ISqlDatabase` / `IMongoDatabase`.

### `katax generate docs`

| Flag                  | Description           |
| ----------------------- | ------------------------ |
| `-f, --force`         | Force regenerate      |
| `-o, --output <path>` | Custom output path    |
| `-p, --port <port>`   | Server port           |
| `-u, --url <url>`     | Production server URL |

Scans `src/api/`, generates OpenAPI 3.0 spec, creates Swagger UI at `/docs` and `/api-docs`.

### `katax info`

Display project structure, dependencies, routes. Aliases: `status`, `ls`.

### Deploy Commands

```bash
katax deploy init      # First-time PM2 setup (repo, branch, path, cluster, memory, env)
katax deploy update    # Pull, rebuild, restart
  -b, --branch <branch>
  --hard               # Hard reset
  -a, --app-name <name>
katax deploy rollback  # Revert to previous commit(s)
  -c, --commits <n>
  -a, --app-name <name>
katax deploy logs      # View PM2 logs
  -l, --lines <n>
  -f, --follow
  -a, --app-name <name>
katax deploy status    # Show all running PM2 apps
```

### Fix Commands

```bash
katax fix docs         # Patch build script to copy openapi.json
  --skip-install
katax fix all          # Apply all available fixes
  --skip-install
katax fix list         # List available patches
```

## Code Generators

| Generator          | Output                                                                         |
| -------------------- | ---------------------------------------------------------------------------------- |
| **Validator**      | `k.object()` schemas, field validation, async validators, TypeScript inference |
| **Controller**     | `ControllerResult<T>`, `createSuccessResult()`, `createErrorResult()`          |
| **Handler**        | Express middleware, validator + controller chaining, `sendResponse()`          |
| **Route**          | Express Router, method calls, JSDoc                                            |
| **Router Updater** | AST-based `routes.ts` updater, prevents duplicates                             |
| **OpenAPI**        | Scans validators/routes, builds OpenAPI 3.0 spec                               |

## Template Generators

| Template                | Features                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Auth Utils**          | `hashPassword()`/`verifyPassword()` (bcrypt), `hashPasswordArgon2()`/`verifyPasswordArgon2()`, `generateToken()`/`verifyToken()`/`decodeToken()`/`generateRefreshToken()` (JWT), `generateRandomToken()`, `generateNumericCode()`, `sha256()`/`md5()`, `encrypt()`/`decrypt()`, `secureCompare()` |
| **Stream Utils**        | SSE: `initSSE()`, `sendSSEEvent()`, `sendSSEComment()`, `closeSSE()`, `SSEStream` class           |
| **API Utils**           | `ControllerResult<T>`, `createSuccessResult()`, `createErrorResult()`, `validateSchema()`, `sendResponse()`, `setCookie()`, `clearCookie()` (real generated file: `shared/api.utils.ts` — no separate `response.utils.ts` exists) |
| **Test Generator**      | Repository/controller test stubs with mocks                                                       |
| **Controller Template** | Class-based, repository/logger injection, `Result<T,E>`                                           |

## CLI Utilities

| Utility         | Description                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **CodeBuilder** | `line()`, `raw()`, `import()`, `export()`, `comment()`, `section()`, `openBlock()`, `closeBlock()`, `build()`          |
| **File Utils**  | `renderTemplate()`, `copyTemplate()`, `writeFile()`, `ensureDir()`, `toPascalCase()`, `toCamelCase()`, `toKebabCase()` |
| **Logger**      | `success()`, `error()`, `warning()`, `info()`, `verbose()`, `gray()`, `title()`, `code()` with colors; `setVerbose()`/`setColorMode()` toggle global state |

## Generated Project Architecture

```
src/
├── api/               # Generated validators, controllers, handlers, routes
│   ├── validators/    # k.object() schemas per endpoint
│   ├── controllers/   # Business logic with ControllerResult<T>
│   ├── handlers/      # Express middleware (validator + controller)
│   └── routes/        # Express Router definitions
├── shared/            # api.utils.ts (createResponse/sendResponse/cookies), auth utils, stream utils
├── config/            # Environment config
├── middleware/        # Auth, error handling, logging
└── index.ts           # Bootstrap entry point
```

## Common Patterns

- **Architecture**: `validator -> controller -> handler -> routes`
- **Nested resources**: `katax add endpoint admin/users` generates relative imports correctly
- **Defaults**: `katax init` defaults to pnpm and supports `--ignore-scripts` + `--write-npmrc`
- **Repository access**: Generated repositories use typed `ISqlDatabase` / `IMongoDatabase`
- **OpenAPI**: Auto-generated from validators — keep validators up to date
- **Deploy**: Uses `.katax-deploy.json` for config persistence across updates
