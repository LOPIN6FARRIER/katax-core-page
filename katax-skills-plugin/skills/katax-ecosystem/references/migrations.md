# Migrations

How a katax API changes its PostgreSQL schema: numbered SQL files, applied automatically at startup by a small
runner, recorded in a table the runner creates itself, safe when several processes start at once. Copy
`assets/templates/shared/migrations.ts` and `assets/templates/repositories/migrations.repository.ts` (and the two row
types from `assets/templates/types/db.types.ts`); they were run against PostgreSQL 16: fresh database, re-run,
two processes at once, a failing migration, an edited migration, baseline of an existing database, and upgrading
a bookkeeping table written by an older runner.

## Contents

0. Ask first: public repositories
1. Layout and naming
2. Writing a migration (idempotent)
3. Running them at startup
4. Concurrency and failures
5. Existing databases (baseline)
6. Rules
7. Testing migrations

## 0. Ask first: public repositories

The `migrations/` folder exposes the whole schema (tables, columns, constraints, roles, grants) to anyone who can
read the repository. Before adding it, or the runner, to a project:

1. Check whether the repository is public: `gh repo view --json visibility` when `gh` is available, the remote
   host and owner (`git remote -v`), `"private": true` in `package.json` (that only blocks npm publishing; it says
   nothing about GitHub visibility). If you can't tell, treat it as public.
2. Always ask the user before creating `migrations/` or wiring the runner, even when the repository looks
   private, and say what it would expose if the repository is (or becomes) public. Options to offer: add it
   here; keep the SQL in a private repository or folder and point `MIGRATIONS_DIR` at it on the server; or keep
   applying changes by hand.
3. Never put data, secrets, password hashes, real e-mails or seed users in a migration file, whatever the answer.

When nobody can answer (unattended run), don't add the folder: write the migration SQL in the report instead.

## 1. Layout and naming

```
<project>/
  migrations/
    001_init.sql
    002_users_email_index.sql
    027_workspace_files.sql
  src/shared/migrations.ts            # runner (template)
  src/repositories/migrations.repository.ts
```

- `NNN_short_name.sql`, at least three digits, ordered by number. Other files in the folder (`README.md`) are
  ignored.
- `migrations/` lives at the project root, next to `src/` and `dist/`: the runner finds it from both `tsx` and
  compiled code without copying anything into `dist/`. `MIGRATIONS_DIR` overrides it.
- One concern per file. A new change is always a new file: an applied file never changes (the runner stores a
  SHA-256 of each file and warns at boot when an applied one was edited; that edit did not run).

## 2. Writing a migration (idempotent)

A migration can run against a database where part of it already exists: a deploy restarted half-way, a restored
backup, a branch that applied it by hand, two environments that drifted. Guard every statement so running it
twice is a no-op. The audit rule `migration-not-idempotent` checks files after the baseline.

```sql
-- 027_workspace_files.sql
CREATE TABLE IF NOT EXISTS public.workspace_file (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);

ALTER TABLE public.workspace_file ADD COLUMN IF NOT EXISTS size_bytes bigint NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS workspace_file_ws_created_idx
  ON public.workspace_file (workspace_id, created_at DESC) WHERE deleted_at IS NULL;

-- No IF NOT EXISTS for constraints, types or policies: guard them with a DO block.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_file_size_nonneg') THEN
    ALTER TABLE public.workspace_file ADD CONSTRAINT workspace_file_size_nonneg CHECK (size_bytes >= 0);
  END IF;
END $$;

-- Triggers and functions: replace, don't create.
DROP TRIGGER IF EXISTS trg_legacy ON public.node;
DROP FUNCTION IF EXISTS public.legacy_fn();
```

- Data changes are written so a second run changes nothing (`UPDATE ... WHERE <still in the old shape>`,
  `INSERT ... ON CONFLICT DO NOTHING`).
- Each file runs in one transaction with its bookkeeping row, so don't put `BEGIN`/`COMMIT` in it, and avoid what
  can't run in a transaction (`CREATE INDEX CONCURRENTLY`, `ALTER TYPE ... ADD VALUE` before PG 12). For those, a
  separate file run by hand and recorded with `INSERT INTO schema_migrations`, documented in the file itself.
- Long data backfills don't belong in a startup migration (they hold the lock and delay boot): ship a script
  (`scripts/backfill-*.ts`, dry run by default) and keep the migration to the schema.
- Removing things is a two-step change: stop using the column/table in one release, drop it in a later one.

## 3. Running them at startup

The runner does all its work on one dedicated connection. Two ways to call it; pick one per project.

**A. In katax's `afterInit` hook (recommended, with a migration user).** `afterInit` runs at the end of
`katax.init()`, before `katax.database()`, so the runner opens its own `pg.Client` from env and closes it at the
end. Nothing (pool, Redis, sockets, HTTP) starts until the schema is current, and every entry point that calls
`katax.init()` (the API, a pipeline or script bootstrap) migrates through the same hook.

```ts
await katax.init({
  loadEnv: true,
  hooks: {
    afterInit: async () => {
      if (katax.env('RUN_MIGRATIONS_ON_START', 'true') === 'false') return;
      const report = await runMigrations();   // throws: init() rejects and the process doesn't start
      if (report.changed.length) katax.logger.warn({ message: 'Edited migrations', files: report.changed });
    }
  }
});
await katax.database({ name: 'main', /* app user: DML only */ });
```

Env: `DB_HOST`, `DB_PORT`, `DB_NAME`, and `DB_MIGRATIONS_USER` / `DB_MIGRATIONS_PASSWORD` (the owner of the
tables, allowed to run DDL). Without them it falls back to `DB_USER` / `DB_PASSWORD`. Least privilege: the app user
gets `SELECT/INSERT/UPDATE/DELETE` and can't `DROP` or `ALTER` anything; only the migration user can. Grant the app
user its rights in the migration that creates each table (or with `ALTER DEFAULT PRIVILEGES` once).

**B. Right after `katax.database({ name: 'main' })`.** Simpler (one set of credentials); the runner borrows a client
from katax's pool. Use it when there is no separate migration user.

```ts
await katax.database({ name: 'main', type: 'postgresql', connection: { /* ... */ } });
if (katax.env('RUN_MIGRATIONS_ON_START', 'true') !== 'false') await runMigrations();
// then Redis users, sockets, app.listen
```

The runner chooses by itself: its own `pg.Client` when `DB_MIGRATIONS_USER` is set or katax has no `main` database
yet; the pool otherwise. Both were run against PostgreSQL 16 (fresh, re-run, the two modes at once on one
database, a failing file, a separate owner user).

- A failure throws and the process exits: PM2 / the deploy shows it, and the old version keeps serving during a
  `pm2 reload`. Never catch it and continue.
- `RUN_MIGRATIONS_ON_START=false` for one-off processes (a script, a REPL, a second service that shares the
  database but doesn't own its schema). Exactly one codebase owns a schema's migrations; a worker from another
  repository that reads the same tables never runs them.
- The bookkeeping table `public.schema_migrations (name text PRIMARY KEY, applied_at timestamptz, checksum text)`
  is created by the runner if it doesn't exist; no manual step on a new server.
- If the env names the migration user, the error/warning must name the variable actually read (a warning that
  mentions `DB_MIGRATIONS_USER` while the code reads `DB_USER` hides that the app user is doing DDL).

## 4. Concurrency and failures

- A session-level `pg_try_advisory_lock` on one dedicated connection guards the whole run. A second process polls
  until the first finishes (default 120 s, `MIGRATIONS_LOCK_TIMEOUT_MS`), then finds everything applied. PM2 with
  several instances, the overlap of `pm2 reload` and a deploy script running migrations are all safe.
- Each migration runs in its own transaction together with `INSERT INTO schema_migrations`: either both happen or
  neither. A failing file is rolled back, not recorded, and the next start retries it after you fix it.
- The bookkeeping insert has no `ON CONFLICT`: if something else recorded the same name meanwhile, the migration
  rolls back instead of running twice.

## 5. Existing databases (baseline)

A database created before the runner (schema loaded with psql, migrations applied by hand) needs its history
recorded without re-running old, probably non-idempotent files:

1. Make sure the database really has every file up to the last one applied by hand.
2. Set `MIGRATIONS_BASELINE_THROUGH=<that file name>` (also in `.env.example`, so the audit skips those files).
3. Start the API. With an empty `schema_migrations`, the runner records the files up to that one without running
   them, then applies the rest. It refuses when the database has no tables (nothing to baseline).
4. From then on the variable does nothing (the table is no longer empty); leave it for documentation.

Before baselining production, take a backup (`pg_dump -Fc`), and say so in the change notes.

## 6. Rules

- Required: schema changes only through numbered files in `migrations/`, applied by the runner; files after the
  baseline idempotent; one transaction per file; one owner service per schema.
- Required: runner called after the main database connects and before the server listens; failure stops the
  process.
- Prohibited: editing an applied migration; `BEGIN`/`COMMIT` inside a file; `CREATE INDEX CONCURRENTLY` in a
  startup migration; running migrations from more than one service; manual schema changes on a server without a
  migration file.
- Allowed when: a statement can't run in a transaction or takes long (big index, backfill) — a script run by hand,
  recorded afterwards, documented in the file.

## 7. Testing migrations

The pure helpers (file order, baseline selection, pending set, normalisation, checksum) are unit-tested. The
behaviour that matters is tested against a real PostgreSQL (throwaway container or local instance):

- every migration applies on an empty database, in order;
- running the runner twice applies nothing the second time;
- two runners started together: one applies, the other waits and applies nothing;
- the newest migration also applies on a copy of the previous schema (a dump of production without data, when
  available), which is where non-idempotent statements and missing columns show up.
