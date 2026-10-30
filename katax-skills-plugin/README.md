# katax-skills

The katax standard for Node.js/TypeScript APIs built with katax-core, katax-service-manager and katax-cli,
packaged for Claude.

- **Skills**: `katax-ecosystem` (the standard: layers, null handling, repositories and transactions, race
  conditions, errors, sessions, security, Redis rate limiting, cron, plus copy-ready templates and the audit
  script), `katax-cli` (1.7.1), `katax-core`, `katax-service-manager`, `katax-mcp-server`.
- **Agent**: `katax-project-builder` creates projects and resources, and audits or migrates existing APIs.
- **Hooks** (Claude Code): after every TypeScript write and before finishing, `katax-audit` checks the code
  against the standard and blocks violations (SQL outside repositories, leaked error messages, default secrets,
  races on one-time tokens...). They do nothing in projects that don't depend on katax.

Run the audit by hand from an API's root:

```bash
node <plugin>/skills/katax-ecosystem/scripts/katax-audit.mjs .
```
