---
name: katax-mcp-server
description: 'Exposing a katax-based Express API as an MCP (Model Context Protocol) server for Claude/Claude.ai connectors — official @modelcontextprotocol/sdk setup, OAuth 2.1 for MCP clients (dynamic registration, PKCE), /.well-known discovery, MCP tools registry bridging katax-core schemas to JSON Schema. Use when: adding an MCP server, exposing tools via MCP, integrating with a Claude connector, implementing MCP OAuth.'
argument-hint: 'What MCP aspect? (server setup/tools registry/OAuth/well-known discovery)'
---

# katax-mcp-server — Exposing a katax API via MCP

How to expose an Express API built on `katax-core` + `katax-service-manager` as a standards-compliant **MCP (Model Context Protocol)** server, so Claude's connector (or any MCP client) can call it directly. This is an architecture layer that sits **on top of** the katax packages, not a katax package itself — it builds on:

- `katax-core` schemas' `toJsonSchema()` (see `katax-ecosystem/references/katax-core.md`) to generate MCP tool `inputSchema`s from the same validators used for REST request validation, with zero duplication.
- `katax-service-manager`'s `katax.db('redis')` for OAuth transient state, and its logger/JWT-adjacent config helpers.
- `katax-ecosystem`'s `references/production-hardening.md` for the CORS/Helmet adjustments MCP OAuth needs — **not repeated here**.

Reference architecture is drawn from two real katax apps that independently converged on the same shape (`api-property-scout`, `api-second-brain`), both using the official `@modelcontextprotocol/sdk` with a full OAuth 2.1 layer. A third real repo took a hand-rolled JSON-RPC shortcut without the SDK or OAuth — that pattern is documented too, explicitly as what **not** to do.

## Architecture in one paragraph

An Express router at `/api/mcp` wraps `@modelcontextprotocol/sdk`'s `Server` + `StreamableHTTPServerTransport`, keeping one `Server`/`transport` pair per `Mcp-Session-Id` in an in-memory map. Tools live in `src/mcp/tools/<domain>.tools.ts`, each exporting `McpTool[]` (`name`, `description`, `inputSchema`, `handler`), aggregated into one `allTools` array; a tool's `handler` re-validates arguments and **delegates to the exact same controller function the REST route uses** — REST and MCP share business logic, only the transport differs. Because MCP clients can't use your app's normal login, there's a **separate OAuth 2.1 layer** (dynamic client registration, PKCE, its own JWT secret) plus two `/.well-known/*` discovery endpoints at the domain root.

## When to use each reference

| Need | Reference |
| --- | --- |
| SDK `Server` setup, session/transport handling (and its known scaling limitation), tools registry shape, the `toPublicInputSchema()` bridge to katax-core's `toJsonSchema()` | `references/server-and-tools.md` |
| OAuth 2.1: `/register` (RFC 7591), `/authorize` with PKCE, `/token`, separate MCP JWT secrets, Redis-backed transient state | `references/oauth.md` |
| `/.well-known/oauth-protected-resource` (RFC 9728) + `/.well-known/oauth-authorization-server` (RFC 8414) exact response shapes, and the hand-rolled-JSON-RPC anti-pattern to avoid/migrate away from | `references/well-known-and-antipattern.md` |

## Common Gotchas

- The session map in `server-and-tools.md` is in-memory — doesn't survive restarts, doesn't scale across instances. Fine for a single-instance PM2 deploy; a real constraint otherwise.
- Don't reuse the app's own session JWT secret for MCP tokens — keep `MCP_JWT_SECRET`/`MCP_JWT_REFRESH_SECRET` distinct (see `oauth.md`).
- Always strip server-injected fields (e.g. `user_id`) from a tool's `inputSchema` via `toPublicInputSchema(schema, omit)` — never let an MCP client supply/spoof a field your server injects from the authenticated identity.
- The REST validator schema and the MCP tool's `inputSchema` should be the **same object** (one `toJsonSchema()` call), not two hand-maintained schemas — if you find yourself hand-writing a second JSON Schema next to an existing katax-core validator, you're duplicating the anti-pattern documented in `well-known-and-antipattern.md`.
- `/.well-known/*` routes must be registered at the domain root, not under `/api` — a common mistake that breaks discovery for compliant clients.
- Rate limiting, CORS, Helmet, cookies, sessions are **not** re-documented here — see `katax-ecosystem`'s `references/production-hardening.md`, this skill only covers what's MCP-specific.
