---
name: katax-cli
description: 'CLI tool to generate Express APIs with TypeScript and katax-core validation. Use when: scaffolding new API projects, generating CRUD endpoints, adding validators/controllers/handlers/routes, deploying to VPS with PM2, managing katax-based project structure.'
argument-hint: 'What katax-cli task? (init/add/generate/deploy/fix/info)'
---

# katax-cli — Project & Endpoint Generator

CLI tool for scaffolding Express + TypeScript REST APIs with katax-core validation, and managing VPS deployments via PM2.

**Version: 1.5.2** | `npm install -g katax-cli`

## All Commands

### `katax init [project-name]`

Scaffolds a complete Express + TypeScript + katax-core API project with interactive prompts.

| Flag | Description |
|------|-------------|
| `-f, --force` | Overwrite existing directory |
| `--pm <npm\|pnpm>` | Package manager (default: pnpm) |
| `--ignore-scripts` | Disable lifecycle scripts |
| `--write-npmrc` | Write `.npmrc` for reproducible installs |

**Interactive prompts**: project name, description, database (PostgreSQL/MySQL/MongoDB/None), auth (JWT/None), validation (katax-core/None), Swagger/OpenAPI, katax-service-manager mode (singleton/instance), registry, lifecycle hooks, Redis cache, WebSocket/Socket.IO, port, git init.

### `katax add endpoint <name>`

Scaffolds a single endpoint with 4 files: validator, controller, handler, routes.

| Flag | Description |
|------|-------------|
| `-m, --method <method>` | HTTP method (GET, POST, PUT, DELETE), default `POST` |
| `-p, --path <path>` | Custom route path |

Supports interactive field definition (name, type, required, validation rules). Auto-updates main router and regenerates OpenAPI docs.

### `katax generate crud <resource-name>`

Generates full CRUD (5 endpoints): list, get by ID, create, update, delete.

| Flag | Description |
|------|-------------|
| `--no-auth` | Skip auth middleware |

### `katax generate repository <name>`

Database access layer. Detects DB type from `package.json`. Generates typed methods: `findAll()`, `findById()`, `create()`, `update()`, `delete()`. Uses `ISqlDatabase` / `IMongoDatabase`.

### `katax generate docs`

| Flag | Description |
|------|-------------|
| `-f, --force` | Force regenerate |
| `-o, --output <path>` | Custom output path |
| `-p, --port <port>` | Server port |
| `-u, --url <url>` | Production server URL |

Scans `src/api/`, generates OpenAPI 3.0 spec, creates Swagger UI at `/docs` and `/api-docs`.

### `katax info`

Aliases: `status`, `ls`. Display project structure, dependencies, and routes.

## Deploy Commands (PM2 on Ubuntu VPS)

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
  -l, --lines <n>      # or --follow / -f
  -a, --app-name <name>
katax deploy status    # Show all running PM2 apps
```

## Fix Commands

```bash
katax fix docs         # Patch build script to copy openapi.json
  --skip-install
katax fix all          # Apply all available fixes
katax fix list         # List available patches
```

## Global Options

| Flag | Description |
|------|-------------|
| `--no-color` | Disable colored output |
| `--verbose` | Enable verbose logging |
| `-v, --version` | Output version |

## Code Generators

| Generator | Output |
|-----------|--------|
| **Validator** | `k.object()` schemas, field validation, async validators, TypeScript inference |
| **Controller** | `ControllerResult<T>`, `createSuccessResult()`, `createErrorResult()` |
| **Handler** | Express middleware, validator + controller chaining, `sendResponse()` |
| **Route** | Express Router, method calls, JSDoc |
| **Router Updater** | AST-based `routes.ts` updater, prevents duplicates |
| **OpenAPI** | Scans validators/routes, builds OpenAPI 3.0 spec |

## Template Generators

| Template | Features |
|----------|----------|
| **Auth Utils** | `hashPassword()` (bcrypt), `hashPasswordArgon2()`, JWT gen/verify, refresh tokens, crypto |
| **Stream Utils** | SSE: `initSSE()`, `sendSSEEvent()`, `sendSSEComment()`, `closeSSE()`, `SSEStream` class |
| **Response Utils** | `sendSuccess<T>()`, `sendError()`, `sendValidationError()`, `sendResult<T,E>()`, `sendResponse()` |
| **Test Generator** | Repository/controller test stubs with mocks |
| **Controller Template** | Class-based, repository/logger injection, `Result<T,E>` |

## CLI Utilities (for custom generators)

| Utility | Description |
|---------|-------------|
| **CodeBuilder** | `line()`, `raw()`, `import()`, `export()`, `comment()`, `section()`, `openBlock()`, `closeBlock()`, `build()` |
| **File Utils** | `renderTemplate()`, `copyTemplate()`, `writeFile()`, `ensureDir()`, `toPascalCase()`, `toCamelCase()`, `toKebabCase()` |
| **Logger** | `success()`, `error()`, `warning()`, `info()`, `verbose()`, `gray()`, `title()`, `code()` with colors; `setVerbose()`/`setColorMode()` toggle global state |

## Generated Project Architecture

```
src/
├── api/               # Generated validators, controllers, handlers, routes
│   ├── validators/    # k.object() schemas per endpoint
│   ├── controllers/   # Business logic with ControllerResult<T>
│   ├── handlers/      # Express middleware (validator + controller)
│   └── routes/        # Express Router definitions
├── config/            # Environment config
├── middleware/        # Auth, error handling, logging
├── shared/           # Response utils, stream utils, types
├── database/         # Migrations, seeds, repositories
├── core/             # Result<T,E>, errors, constants
├── app.ts            # Express app setup
└── index.ts          # Bootstrap entry point
```

## Dependency Chain

```
katax init
  └── katax-service-manager (singleton/instance mode)
  └── katax-core (validation)
  └── Express + TypeScript

katax add endpoint / generate crud
  └── Validator (katax-core k.object())
  └── Controller (ControllerResult<T>)
  └── Handler (validates + calls controller)
  └── Routes (Express Router)
  └── Auto-updates routes.ts (AST-based)
  └── Regenerates OpenAPI docs

katax deploy
  └── PM2 ecosystem file
  └── Git pull + npm rebuild + restart
```

## Common Patterns

- **Nested resources**: `katax add endpoint admin/users` generates relative imports correctly
- **Defaults**: `katax init` defaults to pnpm and supports `--ignore-scripts` + `--write-npmrc`
- **Validator architecture**: `validator → controller → handler → routes`
- **Repository access**: Generated repositories use typed `ISqlDatabase` / `IMongoDatabase`
- **OpenAPI**: Auto-generated from validators — keep validators up to date
- **Deploy**: Uses `.katax-deploy.json` for config persistence across updates
