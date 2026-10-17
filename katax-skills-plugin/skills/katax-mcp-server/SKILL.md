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

Reference architecture is drawn from the real katax apps (`api-habit-forge` — newest, the reference —, `api-my-routine`, `api-second-brain`, `api-property-scout`), all using the official `@modelcontextprotocol/sdk` with a full OAuth 2.1 layer. `api-time-to-drama` (hand-written tool schemas that forward each call over HTTP to its own REST routes) is documented as what **not** to do.

## Architecture in one paragraph

An Express router at `/api/mcp` wraps `@modelcontextprotocol/sdk`'s `Server` + `StreamableHTTPServerTransport` in **stateless** mode (a new server per POST, no `Mcp-Session-Id`). Tools live in `src/mcp/tools/<domain>.tools.ts` (`name`, `description`, `inputSchema`, `readOnly`, `handler`); `inputSchema` is generated from the katax-core validators with `inputSchema()`, and each `handler` re-validates with the same `validate*` function and **delegates to the same controller the REST route uses**. MCP clients authenticate through a **separate OAuth 2.1 layer** (dynamic client registration, PKCE S256, MCP-only JWTs with a `typ` claim) advertised by two `/.well-known/*` endpoints at the domain root. MCP/OAuth paths get their own CORS (any origin, no cookies) and rate limiters.

## When to use each reference

| Need | Reference |
| --- | --- |
| SDK `Server` setup (instructions, readOnly annotations), stateless transport, tools registry (`tool.types.ts`, `tool.utils.ts`, a full `habits.tools.ts`), null from MCP clients | `references/server-and-tools.md` |
| OAuth 2.1: `/register` (RFC 7591), `/authorize` with PKCE, `/token`, MCP JWT secrets, stateless signed client_id/codes, limiters | `references/oauth.md` |
| `/.well-known/oauth-protected-resource` (RFC 9728) + `/.well-known/oauth-authorization-server` (RFC 8414) exact response shapes, and the proxy-the-REST-API anti-pattern to avoid/migrate away from | `references/well-known-and-antipattern.md` |

## Common Gotchas

- Use the stateless transport; the older in-memory session map doesn't survive restarts or multiple instances.
- Set `MCP_BASE_URL` (or `PRODUCTION_URL`) in production: issuer, resource and every advertised endpoint are built from it; a `localhost` issuer breaks the connector.
- Clients send `null` for optional args: `.nullish()` + `validateNormalized` (with `katax-core ^1.6.6`, so those fields aren't marked required).
- Don't reuse the app's own JWT secrets as-is for MCP tokens: set `MCP_JWT_SECRET`/`MCP_JWT_REFRESH_SECRET`, or derive them with HMAC from the app secrets, and put a `typ` claim in every token (see `oauth.md`).
- Never let a client supply the user: keep `user_id` out of request schemas and pass `identity.userId` to the controller (older APIs strip it with `toPublicInputSchema`).
- The REST validator schema and the MCP tool's `inputSchema` should be the **same object** (one `toJsonSchema()` call), not two hand-maintained schemas — if you find yourself hand-writing a second JSON Schema next to an existing katax-core validator, you're duplicating the anti-pattern documented in `well-known-and-antipattern.md`.
- `/.well-known/*` routes must be registered at the domain root, not under `/api` — a common mistake that breaks discovery for compliant clients.
- Rate limiting, CORS, Helmet, cookies, sessions are **not** re-documented here — see `katax-ecosystem`'s `references/production-hardening.md`, this skill only covers what's MCP-specific.
