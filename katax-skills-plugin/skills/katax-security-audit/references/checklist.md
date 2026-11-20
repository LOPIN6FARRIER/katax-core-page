# What hunters check (katax APIs)

One class per row of a unit's `checks`. Each class says what to open, what a real failure looks like and what is
NOT a finding. `katax-audit.mjs` already catches the mechanical rules (SQL outside repositories, leaked error
messages, default secrets, `jwt.verify` without `algorithms`, `===` on secrets, uploads in memory...): don't
re-check those by hand, read its output in the run folder instead.

Background for every class: `<plugin>/skills/katax-ecosystem/references/security.md` and `known-issues.md` (ids in
brackets below).

## Required classes per unit

`katax-findings.mjs gaps` enforces this; a check with `result: "n/a"` and a one-line reason counts.

| Unit | Required |
| --- | --- |
| endpoint behind auth (middleware or in the handler) | `authz-membership` |
| public / optional auth | `authn` |
| `:id` (or any id) in the path | `idor-parent-scope` |
| public write | `rate-limit` |
| upload | `upload`, `resource-exhaustion` |
| POST / PUT / PATCH | `mass-assignment` |
| MCP tool | `mcp-parity`, `authz-membership` |
| socket event | `authz-membership` |
| migration file (diff mode) | `migration` |

Add any other class when the code gives a reason (a raw query → `sql-injection`, a fetch to a user URL → `ssrf`).

## Classes

**authn**: who can call it without credentials, and with which ones. Open the middleware chain in the unit and the
handler. Failure: a write or a private read reachable anonymously; `optionalAuthenticate` followed by code that
assumes `req.user`; a token from another system or the refresh token accepted as access token (also
`token-confusion`). Not a finding: endpoints that are public by design (health, public share by token) as long as
they return only what the design says.

**authz-membership**: the caller must belong to the workspace / own the record, with the right role. Follow
handler → controller → repository: the membership or ownership condition must be in the SQL of the write or read
itself (`WHERE ... AND user_id = $n`, or a join to memberships), or checked in the controller in the same
transaction. Failure: role read from the request body; check done in a validator only (S14, D3); a read-only role
reaching a write; check on a different id than the one written (D2). Not a finding: a check that lives in a
different layer than usual but holds.

**idor-parent-scope**: every id in the path or body resolved under its parent (S9). `/workspaces/:ws/notes/:id` must
look up the note `WHERE id = $1 AND workspace_id = $2` with `$2` = the URL workspace the caller was authorized for.
Failure: lookup by the child id alone after authorizing the parent; ids in arrays (`ids: []`) not each scoped; bulk
endpoints that check the first id only.

**scope-capability**: API keys with scopes or flags (read / write / public app), share tokens, signed URLs: the
capability matches the action (a share link is a read; a write-only key can't read). Failure: a write-only key
reaching a read; a signed URL that keeps working after the file is trashed.

**mcp-parity**: the MCP tool applies exactly the rules of its REST twin (same controller, same validator, identity
from the MCP token, same scoping) (S13). Compare side by side; the tool's group contains both. Failure: the tool
passes `user_id` from args, skips a permission the REST handler checks, or exposes fields the REST response hides.

**mass-assignment**: the validator schema is the allow-list. Failure: `...req.body` spread into an update; fields
like `role`, `user_id`, `workspace_id`, `owner_id`, `is_admin`, `deleted_at`, `quota` accepted from the client;
`UPDATE ... SET` built from object keys.

**sql-injection**: only for SQL built with string interpolation / `format()` of identifiers or `ORDER BY` columns.
Parameterized values (`$1`) are fine. Failure: user input reaching an identifier or a fragment without an allow-list.

**race-condition**: one-time tokens, invites, limits, counters, quotas, "check then insert", refresh rotation
(C1-C4, C7). Failure: a SELECT followed by an UPDATE/INSERT without a lock, a conditional update or a unique
constraint that makes the second request fail.

**upload**: type from magic bytes, not the client; filename decoded (`defParamCharset`); size and count limits;
temp files removed; stored name generated; served with the stored type, `nosniff`, HTML/SVG neutralized (S11,
S12, B10, `security.md` §6).

**resource-exhaustion**: unbounded `limit`, page size, array lengths, recursion depth, ZIP / export size, regex on
user input, work per request (N+1 on hot paths), body size; uploads streamed and capped.

**info-leak**: responses and logs. Failure: driver messages or stacks in responses (S3); tokens, cookies,
signatures or query strings in logs; responses that include other users' emails or internal columns; error
differences that reveal whether an account exists where that matters (login, reset).

**secrets-config**: env validation, default secrets, CORS with credentials and `*`, cookie flags (`httpOnly`,
`secure`, `sameSite`, path), `trust proxy`, health details exposed (S1, S7, `security.md` §1, §8).

**rate-limit**: public writes (login, register, reset, email sends, OAuth registration), expensive endpoints, and
anything that sends email or calls a paid API need a limiter that survives restarts (Redis) and keys by user /
IP / key correctly (B2). Not a finding: a route without its own limiter when a global one covers it with a
sensible budget (then `hardening` at most).

**csrf-cookie**: endpoints authenticated by cookie (refresh, logout, login) must reject cross-site requests
(Origin check, `sameSite`, JSON-only bodies). Bearer-only endpoints are not CSRF-able.

**token-confusion**: access vs refresh vs MCP vs API key vs share token: each verified with its own secret or
`aud`/`typ`, and the session behind it still active where the design says so (S10).

**ssrf**: server-side fetches to URLs the user controls (webhooks, imports, previews, avatars by URL). Failure: no
allow-list, internal addresses reachable, redirects followed.

**path-traversal**: user input reaching a filesystem path (download by name, thumbnails, exports). Failure: `..`
or absolute paths not rejected; the resolved path not checked to stay inside its folder.

**tenant-isolation**: data of one workspace / user / app visible to another through listings, search, counts,
caches (cache keys without the tenant), websockets rooms, background jobs.

**business-logic**: rules specific to the product (last owner can't leave, trashed items can't be shared,
quota counts trash...). Only report a broken rule you can point to in code and in the product's own docs/tests.

**migration**: new SQL files: idempotent, no data loss without a backup step, grants for the app user, no secrets
or real personal data in seed rows, constraints that enforce what the code assumes (unique, foreign keys, NOT
NULL).

## Rules for a candidate

- It needs a concrete path: caller (anonymous / member with role X / outsider / key with scope Y), request, the
  line that lets it through, and what they get. "Might be" without a path is not a candidate.
- Only boundary failures are vulnerabilities. A missing layer when another layer already blocks the attack is
  `hardening`, not a finding.
- No severity before the verifier has tried to disprove it.
- One root cause = one candidate, even if it shows up in several units (list them all in `units`).
