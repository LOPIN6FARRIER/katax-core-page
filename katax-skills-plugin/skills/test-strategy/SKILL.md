---
name: test-strategy
description: 'Decide which tests are worth writing, keeping, merging or deleting, in any project and any test framework: investigate the stack and the existing suite first, ask how far to go, then write only tests that protect a real risk at the cheapest level that catches it. Use when writing tests for a feature or fix, setting up testing in a project, reviewing or cleaning up a test suite, when tests feel redundant, slow or brittle, or when the user asks to optimize, reduce or improve tests, even if they only say "add tests".'
argument-hint: 'What are you testing? (a change / a whole project / clean up the existing suite)'
---

# Test strategy

Tests cost something every day: writing them, running them, keeping them green when the code changes, and
reading false failures. A test earns its place only if it **fails when something that matters breaks** and
**nothing cheaper already catches it**. Everything here follows from that.

This skill works for any language and framework. It never assumes one: the first step is always to find out what
the project uses.

## Step 1: investigate before writing anything

Look, don't guess (details and commands per ecosystem in `references/frameworks.md`):

1. **Stack and framework.** Manifests and configs: `package.json` (vitest, jest, mocha, `node --test`, playwright,
   cypress, @testing-library, msw, supertest, testcontainers), `pyproject.toml` / `pytest.ini`, `go.mod`,
   `Cargo.toml`, `pom.xml` / `build.gradle`, `*.csproj`, `Gemfile`, `composer.json`. Also the CI workflow: what
   actually runs on every push.
2. **The existing suite.** Count tests per area and per level (unit, integration, E2E), how long the suite takes,
   which tests are flaky or skipped, what they mock. Note duplicated coverage: the same rule asserted at two levels.
3. **Static checks already in place.** Type checker, linter, schema validation, custom audit scripts. What they
   guarantee doesn't need a test.
4. **Where the risk is.** Authorization and ownership, money, data writes and deletes, concurrency (one-time values,
   limits, double submits), parsing untrusted input, integrations with other services, migrations, complex branching
   logic. Read recent fixes (`git log --grep fix`, the issue tracker): a bug that already happened is the strongest
   signal of where tests are missing.
5. **Infrastructure available.** Can the tests start a real database (Docker / Testcontainers / a local instance)?
   A browser (Playwright)? If not, say what that rules out instead of faking it with mocks.

## Step 2: ask how to work (unless the user already said)

Ask these together, once, with the findings from step 1 as context:

- **Framework.** If the project has one, use it and say so; don't introduce a second runner. If it has none, or
  two competing ones, propose one that fits the stack (`references/frameworks.md`) and let the user choose.
- **Scope.**
  - *Necessary*: only the tests the current change needs (its risks, its regression test). Fast; the default for a
    feature or a fix.
  - *Optimize*: review the whole suite too: classify every existing test (keep, merge, rewrite, delete), fill the
    risk gaps, and optionally measure test strength with mutation testing. Slower; for a cleanup.
- **Real dependencies.** May the tests use a real database / browser (and is Docker allowed locally and in CI)?

If the user isn't there to answer, take *Necessary* with the project's existing framework, and say so at the top of
the report.

## Step 3: decide which tests are worth it

A test must pass at least one of these filters:

1. **Authorization / security**: who can do what; lookups scoped to the right parent; tokens; input that must be
   rejected.
2. **Data integrity**: transactions, deletes and restores, compensation when a later step fails, migrations.
3. **Concurrency**: one-time values, limits, counters, double submits, overlapping saves.
4. **Contract**: what clients rely on — status codes, error shape, pagination, event payloads.
5. **Logic with branches**: pure rules, calculations, parsers, state machines.
6. **Regression**: a bug that happened. Name it in the test (`regression: duplicate charge on retry`).

And also:

- **It fails when the behavior breaks.** Mentally (or with a mutation tool) break the code: flip a condition, drop
  a `WHERE`, return early. If the test still passes, it protects nothing.
- **Nothing else covers it.** Not the type checker, not a schema validator, not a test at another level.
- **One rule, one level.** The full matrix of a rule lives where it is cheapest (a pure-function test); the layer
  above proves only the wiring (one allowed case, one denied case). Never the whole matrix twice.

### Don't write

- Tests of shapes the type system already guarantees (DTO/mapper field by field), getters/setters, constants.
- Tests of the framework or a library (that the router routes, that the ORM saves, that a UI kit button renders).
- Snapshot tests of large output (they get re-approved without being read).
- Assertions on internals: call counts on mocks, private state, the order of internal calls, "the validated object
  keeps field X for the controller".
- One test per input variant when a table of cases says it in one.
- Tests that only re-run the mock you configured.

## Step 4: pick the level (cheapest one that catches the risk)

Weight the suite toward integration, on a base of static checks; few unit tests (pure logic only) and very few
end-to-end tests:

| Level | Put here | Real vs fake |
| --- | --- | --- |
| Static | types, lint, schema/contract validation, project audit scripts | — |
| Unit | pure functions with branches: rules, calculators, parsers, reducers | no I/O at all |
| Integration (most tests) | an endpoint or service with its real database, real validation, real wiring; a UI component with its real children and state | real database (throwaway); fake only what you don't own: other services' HTTP, clock, randomness, email |
| End-to-end | 3–5 critical journeys (sign in, the core create/edit flow, payment or upload) | real app, staging-like data |

Why integration first: tests that mock internals break on every refactor while the behavior is fine, and miss the
bugs that live in the wiring (a query on a column that doesn't exist, a permission check that a library silently
skips). A test against the real database would have caught both; a mocked repository caught neither.

## Step 5: write them well

- Test observable behavior through the public surface (HTTP response, return value, rendered text, rows in the
  database), not how it's done inside.
- Mock only at boundaries you don't own (network to other services, time, randomness, third-party SDKs). Mocking
  your own modules is a smell: test them together.
- Variations as a table of cases; one idea per test; names that state the behavior ("a read-only member can't
  delete", not "test delete 3").
- Deterministic: fake clocks, seeded random, no `sleep`; every test sets up and cleans its own data (transaction
  rollback, a fresh schema, unique ids).
- Fast enough to run on every save for unit/integration; E2E in CI.
- Every fixed bug gets a regression test at the cheapest level that would have caught it.

## Optimize mode: cleaning up an existing suite

1. **Inventory**: every test file → area, level, number of cases, runtime, what it mocks.
2. **Classify** each test with the filters above: *keep*, *merge* (duplicate of a test at another level, or variants
   that belong in one table), *rewrite* (tests implementation details; would survive a refactor only by luck),
   *delete* (protects nothing). Give the reason per test.
3. **Find gaps**: risky areas from step 1 with no test, ordered by risk.
4. **Measure** (optional, for critical modules only): run a mutation tool (`references/frameworks.md`) on the
   rules/permission/money modules. Surviving mutants show which assertions are missing; untouched files show dead
   coverage. Don't chase a global score; use it to decide.
5. **Apply** in small steps, running the suite after each; deleting tests is a change like any other — list them.
6. **Report** (format below). Coverage percentages are not the goal; say which risks are now protected.

Deletions of end-to-end or integration tests that guard a critical journey are confirmed with the user first.

## Report

```
## Tests: <project or change> (<framework>, mode: necessary | optimize)
Before: <n> tests, <runtime>; after: <n> tests, <runtime>

Added (risk → test → level)
Kept / merged / rewritten / deleted (test → reason)       # optimize mode
Gaps left (risk → why not covered: no DB in CI, needs a browser, out of scope)
How to run: <commands>
```

## References

| Need | Read |
| --- | --- |
| Detecting the framework, recommended stack per ecosystem, run commands, real databases in tests, mutation tools | `references/frameworks.md` |
| Before/after examples: duplicated levels, mapper tests, implementation details, tables of cases, a real-database integration test | `references/examples.md` |
