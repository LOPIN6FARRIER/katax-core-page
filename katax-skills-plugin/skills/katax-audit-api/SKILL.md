---
name: katax-audit-api
description: Audit (and optionally fix) an existing katax API against the katax standard with the katax-project-builder agent. Slash command only.
argument-hint: '[path] [fix | report-only] [focus: security | concurrency | uploads | auth | all]'
disable-model-invocation: true
context: fork
agent: katax-skills:katax-project-builder
---

Mode 3 (audit, harden or migrate) for:

$ARGUMENTS

If no path is given, use the current directory. Run the audit script and the review checklist from `audit.md`
(including the manual items: scoped child lookups, negative authorization tests, uploads, token audiences, Redis
connections, MCP parity, real-database run of the queries). Report first in the `audit.md` format. Change code
only if the request says "fix"; otherwise stop after the report.
