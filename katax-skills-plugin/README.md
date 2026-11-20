# katax-skills

The katax standard for Node.js/TypeScript APIs built with katax-core, katax-service-manager and katax-cli,
packaged for Claude.

- **Skills**: `katax-ecosystem` (the standard: layers, null handling, repositories and transactions, race
  conditions, errors, sessions, security, Redis rate limiting, cron, plus copy-ready templates and the audit
  script and the migration runner), `katax-cli` (1.7.1), `katax-core`, `katax-service-manager`,
  `katax-mcp-server`, and `test-strategy` (framework-agnostic: investigates the project's runner, asks how far to
  go, writes only tests of value or prunes an existing suite; works in any project, katax or not), and
  `katax-security-audit` (security audit with verified findings; see below), and `scope-interview` (any project:
  before a new API or feature, an interview on idea, scope, features, data, permissions and architecture that
  ends in a spec; it loads by itself when a request leaves those decisions open).
- **Agents**: `katax-project-builder` creates projects and resources, and audits or migrates existing APIs;
  `katax-security-hunter` and `katax-security-verifier` are only started by the security audit. Agents
  don't appear in the `/` menu: call it with `@` (typeahead, or `@agent-katax-skills:katax-project-builder`), by
  name ("use the katax-project-builder agent to ..."), or with the commands below.
- **Commands**: `/katax-skills:katax-new-api` and `/katax-skills:katax-add-resource` (scope interview → spec → the
  agent builds it), `/katax-skills:katax-audit-api` (runs the agent in its own context). Security audit: `/katax-skills:katax-security-audit [diff <ref> | resource <name> | full]`
  (runs in the main conversation because it starts the hunters and verifiers).
- **Hooks** (Claude Code): after every TypeScript write and before finishing, `katax-audit` checks the code
  against the standard and blocks violations (SQL outside repositories, leaked error messages, default secrets,
  races on one-time tokens...). They do nothing in projects that don't depend on katax.

Run the audit by hand from an API's root:

```bash
node <plugin>/skills/katax-ecosystem/scripts/katax-audit.mjs .
```

## Security audit

`/katax-skills:katax-security-audit diff main` (or `resource workspace`, or `full`). Scripts build the endpoint
inventory (`katax-routes.mjs`), find coverage gaps and validate and report the findings (`katax-findings.mjs`);
agents only judge code: one read-only hunter per group of endpoints and MCP tools, and a fresh verifier that tries
to disprove each candidate. Results go to `~/.katax-audit/<repo>/run-N/` (never inside the repository). Unchanged
units are carried over to the next run. The inventory alone is useful too:

```bash
node <plugin>/skills/katax-security-audit/scripts/katax-routes.mjs . --md
```
