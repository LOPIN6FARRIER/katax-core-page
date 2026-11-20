# Changelog - katax-skills

## 1.5.1 - 2026-11-20

### Fixed
- `known-issues.md` B13 (new) + `katax-audit.mjs` rule `redis-maxlen-number`: a numeric arg to any raw `redis(...)`
  call — `RedisTransport`'s `maxLen`, `CacheService.set`'s `ttl`/`.expire`'s `seconds`/`.incrBy`'s `increment` —
  threw `"arguments[N] must be of type string | Buffer, got number instead"` on katax-service-manager <= 0.6.1.
  `maxLen` hit hardest: it throws on **every single log call**, not only once trimming actually kicks in. Found
  across 11 production APIs that had just added `maxLen` following the skill's own (wrong) example.
  - **Fixed at the root in katax-service-manager 0.6.2**: `RedisAdapter.redis()` now coerces every numeric arg to
    a string before `sendCommand()`, so no caller needs its own cast. Upgrade to drop the workaround.
  - `katax-service-manager` skill: fixed the `RedisTransport` example and rewrote the gotcha to describe the real
    fix (0.6.2) with the <= 0.6.1 workaround as a fallback.
  - `katax-ecosystem` → `production-hardening.md` §6: the dashboard log-stream example never had `maxLen` at all,
    so streams grew unbounded (one hit ~15M entries / ~2GB in Redis before this). Added it.

## 1.5.0 - 2026-11-19

### Changed
- `/katax-skills:katax-new-api` and `/katax-skills:katax-add-resource` now run in the main conversation: scope
  interview first, then they start the `katax-project-builder` agent with the spec as its contract. The agent
  returns open decisions instead of guessing when it gets no spec.

### Added
- Skill `katax-security-audit` (`/katax-skills:katax-security-audit [diff <ref> | resource <name> | full]`): security
  audit with independently verified findings, adapted from Cloudflare's `security-audit-skill` (coverage ledger,
  isolated hunters, a fresh verifier per candidate, schema-checked records) but cheaper: the inventory, the coverage
  critic, record validation, carry-over between runs and the report are scripts.
  - `katax-routes.mjs`: endpoints with full path and inherited middleware, handler → validator / controller,
    MCP tools (grouped with their REST twin), socket events, cron jobs, risk hints, hunting groups, per-unit file
    hash; `--diff <ref>` scope; `--md` table.
  - `katax-findings.mjs`: `ledger`, `gaps` (required check classes per unit), `findings` (per-status fields,
    units exist, file:line exists), `carry` (reuse unchanged units from a previous run), `report`.
  - References: `checklist.md` (21 classes, katax-specific), `records.md` (run folder outside the repo, formats,
    severities).
- Skill `scope-interview` (any project): before a new API or a feature that leaves decisions open, rounds of at
  most 4 questions with a recommended default each (problem and outcome, scope must / later / no, flows and
  acceptance criteria, data, permission matrix, architecture, non-functional, rollout), reading the repository
  first so it never asks what the code answers; ends in a spec from `assets/spec-template.md` and a go from the
  user. Unattended, it takes the defaults and lists them as assumptions.
- Agents `katax-security-hunter` (read-only, writes only its hunt file) and `katax-security-verifier` (read-only,
  tries to disprove one candidate).

## 1.4.0 - 2026-11-19

### Added
- Skill `test-strategy` (any language or framework): investigate the stack and the existing suite first, propose a
  way of working and ask which runner and how far to go ("necessary" or "optimize as much as possible"), value
  filters, one rule at one level, an optimize procedure (inventory, keep/merge/rewrite/delete, mutation testing on
  critical modules) and a report format. References: `frameworks.md` (detection, defaults per stack, real
  databases in tests, mutation tools) and `examples.md` (before/after cases).
- Migrations: runner template (`shared/migrations.ts` + `repositories/migrations.repository.ts`) that creates
  `schema_migrations` if missing, takes a PostgreSQL advisory lock, applies each pending `migrations/NNN_name.sql`
  in its own transaction, warns when an applied file changed (checksum) and supports a baseline for existing
  databases (`MIGRATIONS_BASELINE_THROUGH`). Runs from katax's `afterInit` hook with its own `pg.Client` and an optional
  table-owner user (`DB_MIGRATIONS_USER`), or after `katax.database()` with a pooled client. Always asks the user before adding `migrations/` (a public repository exposes the
  schema); unattended runs put the SQL in the report instead. Reference `migrations.md`, known issue D10, audit rule `migration-not-idempotent`.

### Changed
- Tests no longer say "Vitest, the only runner": use the project's runner (Vitest by default for new katax
  projects, one runner per repository) and prefer endpoint tests against a real database built by the migrations;
  the agent loads `test-strategy` before writing tests.

## 1.3.0 - 2026-11-19

Lessons from building and hardening a real multi-repo katax system (API + worker + file service): authorization
that silently disappeared, cross-parent lookups, token confusion between issuers, uploads, Redis, and tooling
that broke deploys.

### Added
- Commands that run the `katax-project-builder` agent from the `/` menu: `katax-new-api`, `katax-add-resource`,
  `katax-audit-api` (skills with `context: fork`, slash-only).
- Audit rules: `multer-param-charset`, `upload-in-memory`, `missing-eslint-config`, `pnpm-release-age-katax`;
  `katax-core-version` now asks for `^1.6.7`.
- Known issues D7-D9, C7, S9-S14, B9-B12, T4-T5 (missing columns reaching production, legacy triggers, orphaned
  external resources, overlapping client saves, IDOR through child ids, interchangeable tokens, mangled upload
  names, client-supplied file types, MCP tools weaker than REST, authorization living only in validators,
  katax-core <= 1.6.6 skipping `asyncRefine`, uploads buffered in RAM, Redis clients without an error listener,
  pnpm's 24 h release age, missing ESLint config and mixed runners, dead checks).
- `workers-and-cron.md`: cleaning up external resources (soft delete + retention job + compensation).
- Agent: "Working in someone else's repositories" (git instructions, `.env*`, line endings, minimal lockfile edits
  and frozen installs, real-database runs, query counts on hot paths, contract deviations, half-finished work) and
  richer Finish/Report steps.

### Changed
- Standard targets katax-core 1.6.7; required negative authorization tests; real PostgreSQL run of new SQL when
  available; repository hygiene and contracts sections in `katax-ecosystem` SKILL.md.
- `security.md`: `aud` per token issuer; uploads section rewritten (charset, allow-lists, no client-type fallback,
  text detection, streaming, concurrency, check-first); child lookups scoped by the URL parent.
- `jwt.utils.ts` template signs and verifies `aud`.
- `katax-service-manager`: 0.6.1 gotchas (no Redis `'error'` listener, `cache().set` TTL ignored, bridges need
  their own connection).
- `katax-mcp-server`: separate `aud` for MCP tokens; tools never check less than REST.

## 1.2.0 - 2026-10-30

The standard was rebuilt from twelve real katax APIs, taking the best implementation of each topic from
whichever API had it, and everything needed to apply it now ships inside the plugin.

### Added
- `katax-ecosystem/references/`: `concurrency.md` (race conditions and their fixes), `security.md`,
  `auth-and-sessions.md`, `errors.md`, `workers-and-cron.md`, `audit.md`, `known-issues.md` (catalog of issues
  found in real APIs, with how to detect and fix each).
- `katax-ecosystem/assets/templates/`: `db.ts` (SqlExecutor, lockKey), `db-errors.ts`, `jwt.utils.ts`,
  `secret-compare.utils.ts`, `rate-limit.store.ts` + `rate-limit.middleware.ts` (Redis with memory fallback),
  `job-lock.utils.ts` (runExclusive for cron), `cookie.config.ts`, `no-store.middleware.ts`, `db.types.ts`
  (CountRow/IdRow), `dashboard-registry.ts`. All typecheck in a katax-cli 1.7.1 project; the database, lock and
  rate-limit ones were run against PostgreSQL and Redis.
- `katax-ecosystem/scripts/katax-audit.mjs`: audit script (project, file, or hook mode).
- `hooks/hooks.json`: PostToolUse (Write/Edit/MultiEdit) blocks standard violations in the file just written;
  Stop checks changed files and runs `tsc --noEmit` before finishing. Both do nothing outside katax projects.

### Changed
- `katax-cli` skill describes 1.7.1 (`add endpoint` with `--fields`/`--methods`/`--id`/`--public`/sub-resources,
  runtime OpenAPI, reworked deploy) and lists the gaps between the generated code and the standard.
- `katax-ecosystem` SKILL.md is the standard on one page with levels (required / allowed when / prohibited).
- `api-architecture.md` uses a resource generated by katax-cli 1.7.1 plus the standard's fixes, compiled and
  exercised over HTTP.
- `production-hardening.md`: Redis-backed rate limiting with tiers and keys, one Redis connection per use,
  bootstrap with `import 'dotenv/config'` first.
- `katax-service-manager`: initialization order and bootstrap template fixed (the old template ignored
  `LOG_LEVEL` from `.env`); ratelimit connection and jobs in the template.
- `katax-project-builder`: three modes (new project, new resource, audit/migrate); finishes only with audit at
  0 errors, typecheck and tests.
- References no longer point to files in other repositories: every practice carries its code here.

### Removed
- `katax-ecosystem/references/katax-cli.md`, `katax-core.md`, `katax-service-manager.md` (copies of the sibling
  skills that had drifted out of date; the skills themselves are the source).
