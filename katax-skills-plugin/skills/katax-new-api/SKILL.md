---
name: katax-new-api
description: Create a new katax API - first a scope interview (idea, scope, features, data, permissions, architecture) that ends in a spec, then the katax-project-builder agent builds it to the katax standard. Slash command only.
argument-hint: '<name or idea> [postgres] [redis] [jwt] [websocket] [mcp] [pnpm|npm]'
disable-model-invocation: true
---

New katax API from this request:

$ARGUMENTS

1. Unless the request already points to an agreed spec, run the `scope-interview` skill at full depth (it loads
   with the Skill tool). Defaults for a katax project: PostgreSQL, Redis for rate limits, JWT with refresh-token
   sessions, pnpm; ask only about the forks. Get the user's go on the spec.
2. Start the `katax-skills:katax-project-builder` agent in Mode 1 with: the spec path (or the spec text if it isn't
   saved in a file), the name, and the infrastructure choices from the spec. Tell it the spec is the contract.
3. When it reports back, relay the result: what was built, deviations from the spec, and the next steps it lists.
