---
name: scope-interview
description: Structured interview that defines what to build before building it - idea and problem, scope (in / out / later), features with acceptance criteria, data, permissions, architecture, non-functional needs, risks - and writes a spec the build follows. Use before creating a new API, app or service, before adding a feature, resource or integration that touches more than one or two files, and whenever the request leaves decisions open that would change what gets built, even if the user only says "add X" or "make a new API for Y". Skip it for bug fixes, small edits and requests that already come with a spec.
argument-hint: '[new-project | feature] <idea in a sentence>'
---

# Scope interview

Turn an idea into decisions before code exists. Wrong guesses here cost a rewrite later; questions that change
nothing cost the user's patience. So: ask only what changes what gets built, propose a default for every question,
and stop as soon as the spec is buildable.

Talk to the user in their language. Write the spec in the language the project's docs use (English if none).

## 0. Decide the depth, then read before asking

| Request | Depth | Rounds |
| --- | --- | --- |
| New project / API / app / service | full | up to 5 |
| New feature, resource, integration, or a change across several modules | feature | 2-3 |
| Small, clear change | none: skip this skill and build | 0 |

Before the first question, gather what can be known without asking, quietly:
- the repository: README, CLAUDE.md / AGENTS.md, `package.json` (stack, versions), existing resources and how
  they are structured, auth and roles, the migrations folder, tests, deploy files;
- the conversation and anything the user attached or linked;
- for a katax project, the `katax-ecosystem` standard (it already decides layers, errors, auth, rate limits).

Never ask something the code or the conversation already answers. State it as an assumption instead
("Uses the existing workspace roles: owner / editor / viewer").

## 1. Run the rounds

One round = one message with at most 4 questions (use the multiple-choice question tool when available; put the
recommended option first and say why in one line). After each round, write a 3-5 line summary of what is now
decided, then the next round. Skip any round whose answers are already known.

**Round 1: idea and problem**
- What problem, for whom (users, roles, other systems or agents calling it)?
- What does success look like (one measurable outcome or the moment the user says "it works")?
- Why now / what happens today without it (the workaround it replaces)?
- What it is explicitly NOT (the most likely scope creep).

**Round 2: scope**
- First version vs later: list candidate features and let the user sort them into must / later / no.
- Platforms and clients (web, mobile, desktop, MCP / agents, other services).
- Constraints: deadline, budget (paid APIs, hosting), team, data that already exists and must be migrated.

**Round 3: features in detail** (for each "must")
- The main flow in steps, and the 2-3 edge cases that matter (empty, limit reached, concurrent edit, deleted
  parent, no permission).
- Acceptance criteria as testable sentences ("A viewer gets 403 when deleting a file").
- Data: entities, the fields that matter, relations, what is soft-deleted, what must be unique, what is
  counted or limited.

**Round 4: permissions and architecture** (propose a design, ask only about the forks)
- Who can do what: a permission matrix (role × action), per-person overrides, public / shared access.
- Where it lives: new service vs module in an existing one; sync vs background job; realtime needs; files and
  storage; external integrations and their failure modes; MCP tools if agents will use it.
- For katax: the resources (validator / types / repository / controller / handler / routes), migrations,
  Redis use (rate limits, cache), cron jobs. Present it as a short diagram (Mermaid) plus the list; ask only
  about the choices that are genuinely open.

**Round 5: quality and rollout** (full depth only)
- Expected volume and the slowest acceptable response; what must never be lost.
- Security and privacy: sensitive data, who must never see what, audit trail; if the repository is public, what
  must stay out of it (schema details, seeds, keys).
- Rollout: feature flag, data backfill, migration order across services, backwards compatibility for existing
  clients.
- Tests that prove it works (chosen with the `test-strategy` skill if available).

Stop early when every "must" has a flow, acceptance criteria, its data and its permissions, and the architecture
has no open fork. Unknowns that don't block the first version go to "Open questions" instead of another round.

Unattended (nobody answers): don't block. Take the recommended option for every question, mark each one as an
assumption in the spec, and list them at the top.

## 2. Write the spec

Fill `assets/spec-template.md`. Keep it as short as the decisions allow; delete sections that don't apply instead
of writing "N/A". Every acceptance criterion must be checkable by a test or a person in one step.

Where it goes:
- default: `docs/specs/<yyyy-mm-dd>-<slug>.md` in the repository, unless the project already keeps specs elsewhere;
- if the repository is public and the spec describes security details, permissions internals or unreleased plans,
  ask before writing it there (offer: the repository, a private notes folder, or only in the conversation);
- in a chat session without a repository, deliver it as a document.

Show the user the summary (decisions, assumptions, open questions) and ask for a go / changes. Don't start building
until they say go, unless they already said to proceed without review.

## 3. Hand off

The spec becomes the input of the build:
- katax API: the `katax-project-builder` agent (Mode 1 for a new API, Mode 2 per resource) with the spec path; its
  contract (endpoints, fields, errors) comes from the spec, and deviations are reported against it;
- anything else: a task list derived from the features, in the order the spec sets (data → API → UI → rollout).

When the build changes a decision, update the spec (Decisions log) instead of letting code and spec drift.
