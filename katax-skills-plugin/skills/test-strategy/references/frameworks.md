# Frameworks and tools

Look up what the project already uses before proposing anything. If it already has a runner, keep it: two runners
in one codebase double the configuration, the CI time and the things to learn. Only propose a change when there is
no runner, or when the existing one blocks something the user wants (and then ask).

## Detecting what the project uses

| Ecosystem | Where to look | Signals |
| --- | --- | --- |
| JavaScript / TypeScript | `package.json` (`scripts.test`, devDependencies), config files | `vitest`, `jest`, `mocha`, `node --test` in scripts, `ava`; `@playwright/test`, `cypress`; `@testing-library/*`, `msw`, `nock`, `supertest`, `testcontainers`; `vitest.config.*`, `jest.config.*`, `playwright.config.*` |
| Python | `pyproject.toml`, `setup.cfg`, `pytest.ini`, `tox.ini`, `requirements*-dev.txt` | `pytest` (+ `pytest-django`, `pytest-asyncio`), `unittest`, `hypothesis`, `testcontainers`, `respx` / `responses` |
| Go | `go.mod`, `*_test.go` | `testing` (built in), `testify`, `httptest`, `testcontainers-go` |
| Rust | `Cargo.toml`, `#[cfg(test)]`, `tests/` | built-in `cargo test`, `rstest`, `proptest`, `testcontainers` |
| JVM (Java/Kotlin) | `pom.xml`, `build.gradle(.kts)` | JUnit 5, Kotest, Mockito/MockK, Spring Boot Test / MockMvc, RestAssured, Testcontainers, WireMock |
| .NET | `*.csproj`, `*.sln` | xUnit, NUnit, MSTest, `WebApplicationFactory`, Testcontainers |
| Ruby | `Gemfile`, `spec/`, `test/` | RSpec, Minitest, Capybara |
| PHP | `composer.json`, `phpunit.xml` | PHPUnit, Pest |
| Mobile | `android/`, `ios/`, Capacitor/React Native configs | JUnit/Espresso, XCTest, Detox/Maestro; usually web-level tests cover shared logic |

Also read the CI workflow (`.github/workflows/*`, `.gitlab-ci.yml`): what runs on every push is what actually
protects the project. A suite nobody runs protects nothing.

## When there is no runner: a sensible default per stack

| Stack | Unit + integration | Real database in tests | HTTP / API level | Network fakes | UI components | End-to-end |
| --- | --- | --- | --- | --- | --- | --- |
| Node API (TS) | Vitest (or the built-in `node:test` if the project avoids dev dependencies) | Testcontainers or a `docker compose` test service | supertest against the app object | MSW / nock (other services only) | — | — |
| React / Vue / Svelte (Vite) | Vitest | — | — | MSW at the network boundary | Testing Library | Playwright |
| Next.js / Nuxt | Vitest | — | route handlers through their request objects | MSW | Testing Library | Playwright |
| Python (FastAPI / Django / Flask) | pytest | Testcontainers / a test database fixture | the framework's test client | respx / responses | — | Playwright (Python) |
| Go | `testing` + testify | testcontainers-go | `net/http/httptest` | `httptest.Server` for other services | — | Playwright |
| JVM | JUnit 5 | Testcontainers | MockMvc / RestAssured | WireMock | — | Playwright (Java) |
| .NET | xUnit | Testcontainers | `WebApplicationFactory` | WireMock.Net | — | Playwright (.NET) |

Pick one per project and write it down (README or CONTRIBUTING): runner, how to run each level, what the tests may
start (database, browser).

## Real databases in tests

In-memory fakes of a SQL database don't run your real SQL, so they don't catch the bugs that matter (missing
column, wrong constraint, transaction behavior). Prefer, in order:

1. **Testcontainers**: the test starts a throwaway container of the same database version as production, runs the
   migrations, and drops it at the end. Works locally and in CI where Docker is available.
2. **A `docker compose` test service** started before the suite (one database, a schema or a database per test
   file).
3. **A local instance** with a dedicated test database, when Docker isn't available.

Isolate data per test: wrap each test in a transaction that is rolled back, or truncate the tables it touched, or
give each test file its own schema. Run the real migrations to build the schema (that also tests the migrations).

If no real database can run in the environment, say so in the report and keep the risky SQL covered by a manual
check; don't replace it with a mock and call it tested.

## Mutation testing (measuring whether tests catch bugs)

Line coverage says what ran, not what was checked. A mutation tool changes the code in small ways (flips `>` to
`>=`, removes a call, returns early) and reruns the tests: a change no test notices is a missing assertion.

| Ecosystem | Tool |
| --- | --- |
| JS / TS | StrykerJS (`@stryker-mutator/core` with the runner plugin for Vitest, Jest or Mocha) |
| Python | mutmut, cosmic-ray |
| JVM | PIT (pitest) |
| .NET | Stryker.NET |
| Rust | cargo-mutants |
| Go | gremlins, go-mutesting |
| PHP | Infection |
| Ruby | mutant |

Use it on purpose, not as a gate on everything: run it on the modules where a silent mistake is expensive
(permissions, money, rules, parsers), read the surviving mutants, add the missing assertions or accept them.
It is slow; keep it out of the per-push pipeline (nightly, or by hand during an optimize pass), and use the tool's
incremental mode if it has one.

## Running only what changed

Most runners can run the tests related to changed files (`vitest --changed`, `jest --onlyChanged`,
`pytest --lf` / plugins, `go test ./pkg/...`). Use that while working; the full suite runs in CI.
