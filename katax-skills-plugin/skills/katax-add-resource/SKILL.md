---
name: katax-add-resource
description: Add a resource, endpoint or feature to an existing katax API - a short scope interview when decisions are open (flows, acceptance criteria, data, permissions), then the katax-project-builder agent builds it to the katax standard. Slash command only.
argument-hint: '<feature or resource> [fields / rules / methods]'
disable-model-invocation: true
---

New resource or feature in the katax API in the current directory:

$ARGUMENTS

1. Read the project first (existing resources, roles, migrations). If the request leaves open decisions that change
   what gets built (who can do what, fields and rules, edge cases, relation to existing resources), run the
   `scope-interview` skill at feature depth and get the user's go on the spec. A request that already answers all
   of that goes straight to step 2.
2. Start the `katax-skills:katax-project-builder` agent in Mode 2 with the spec (path or text) as the contract: it
   generates with katax-cli, fills in the real rules, scopes writes by owner and by the URL parent, adds negative
   authorization tests, writes the migration (asking first if the project has no `migrations/` yet) and doesn't
   run it against a database it wasn't given.
3. Relay its report: what was built, deviations from the spec, and the next steps.
