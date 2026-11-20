---
name: katax-security-audit
description: Security audit of a katax (Express + katax-core) API with evidence-backed, independently verified findings - deterministic endpoint inventory, read-only hunters per resource, a fresh verifier that tries to disprove each candidate, validated findings.json and report. Scoped by git diff, resource or full codebase, and incremental across runs to keep token use low. Use when the user asks for a security audit, security review, pentest-style review or vulnerability hunt of a katax API, or runs /katax-skills:katax-security-audit.
argument-hint: '[diff <git-ref> | resource <name,...> | full] [path]'
---

# katax security audit

Find real boundary failures in a katax API (who can read or change what), prove each one, and spend tokens only
where a script can't do the work. Method adapted from Cloudflare's open-source `security-audit-skill`: a coverage
ledger, isolated hunters, a separate agent that tries to disprove every candidate, findings checked against a
schema by a script. The difference: katax code has a known shape, so the inventory, the coverage critic, the
record validation and the report are scripts, not agents.

Scripts (Node, no dependencies), in `scripts/` next to this file:
- `katax-routes.mjs`: endpoint / MCP tool / socket / cron inventory → `ledger.json`, with hunting groups.
- `katax-findings.mjs`: `ledger`, `gaps`, `findings`, `carry`, `report` (see its header).

References: `references/checklist.md` (what to check per class), `references/records.md` (run folder, units,
hunter output, findings, severities).

Agents (this plugin): `katax-skills:katax-security-hunter` (read-only, one per group) and
`katax-skills:katax-security-verifier` (read-only, fresh per candidate). You are the orchestrator: run this in the
main conversation, not inside another subagent (subagents can't start subagents).

## 0. Scope and budget (ask once, then go)

Read `$ARGUMENTS`. If the scope isn't given, ask one question with these options, recommending the first that
applies:

1. **diff** against the default branch or a ref the user names (`main`, `origin/main`, a tag): only units touched
   by changed files, plus changed shared files (middleware, auth, db helpers) and migrations. The everyday choice.
2. **resource**: one or more resources (`workspace`, `node,share`).
3. **full**: everything. Before starting, tell the user how many hunters it means (`ledger.groups.length`) and
   that a previous run's unchanged units will be carried over.

Unattended: diff against the default branch if there are changes, otherwise full with carry-over.

Never run the target's code against production, never send requests to deployed URLs, and don't read `.env*`
values (names only). Running tests or a throwaway database is allowed only if the user said so.

## 1. Inventory (scripts, no model)

```bash
RUN=~/.katax-audit/<repo-name>/run-<N>        # outside the repo; N = last run + 1
mkdir -p "$RUN"
node <this skill>/scripts/katax-routes.mjs <path> --out "$RUN/ledger.json" [--diff <ref>]
node <this skill>/scripts/katax-findings.mjs carry <previous run>/ledger.json "$RUN/ledger.json"   # if a previous run exists
node <plugin>/skills/katax-ecosystem/scripts/katax-audit.mjs <path> > "$RUN/static-audit.txt"
```

For `resource`, keep only those groups (edit the ledger or pass the group list to the hunters). Check the
inventory against reality once: if the summary shows 0 endpoints or a resource you know exists is missing, the
entry point wasn't found (`--entry src/app.ts`). Read `summary.hints` and `globalMiddleware`.

Then write `architecture.md` (≤ 60 lines) from a small, fixed reading list, not from the whole repo: the global
middleware, the auth middleware(s) the ledger names (`authenticate`, `requireJwt`, API key, MCP), the error
middleware, the session / token helpers, and the membership model (the table or helper that decides roles).
Content: token types and what each can do, roles and tenant model, public surfaces, storage and external calls,
known invariants (from the project's CLAUDE.md / README if present). Hunters get this instead of re-reading it.

## 2. Hunt (one hunter per group, in parallel)

For each group with units still `planned`, start `katax-skills:katax-security-hunter` with:
- the path, the run folder, the group id, and its units copied from the ledger (only that group's JSON);
- `architecture.md`, `references/checklist.md`, and the line "static rules already covered: see static-audit.txt";
- the output file: `$RUN/hunt-<group>.json` in the `records.md` hunter format.

Run up to 6 hunters at a time. Merge each hunter's `units` into the ledger (status, checks, skipReason), then:

```bash
node <this skill>/scripts/katax-findings.mjs ledger "$RUN/ledger.json"
node <this skill>/scripts/katax-findings.mjs gaps "$RUN/ledger.json"
```

`gaps` is the coverage critic: units missing a required class. Send only those units back to a hunter, once,
with the missing classes named. Whatever is still uncovered gets `skipped` with a reason and appears in the report.

## 3. Verify (fresh verifier per candidate)

Collect candidates from all hunter files; merge duplicates by fingerprint (same root cause in several units = one
candidate listing every unit). For each unique candidate start a new `katax-skills:katax-security-verifier` with:
the candidate, `architecture.md`, the path, and nothing from the hunter's reasoning beyond the candidate record.
Its job is to disprove it. Verdicts: `survived` → `confirmed` (the verifier assigns severity), `refuted` →
`rejected` or `hardening` (another layer blocks it but this one is worth adding), `inconclusive` →
`needs_validation` with the open question.

Several low-impact candidates of the same group (rate limits, info leaks) may share one verifier, at most 3 per
verifier. Anything that could be `critical` or `high` gets its own.

## 4. Record

Write `$RUN/findings.json` (format in `records.md`), ids `F-001`... in severity order, and validate:

```bash
node <this skill>/scripts/katax-findings.mjs findings "$RUN/findings.json" --ledger "$RUN/ledger.json" --root <path>
```

Fix every problem it lists (missing fields, unknown units, lines that don't exist) before going on.

## 5. Second look at what matters

For each `confirmed` finding rated `critical` or `high`, one more fresh verifier checks the final record against
the code (location, attack, fix). If it disagrees, re-verify and update the record; re-run the validator.

## 6. Report

```bash
node <this skill>/scripts/katax-findings.mjs report "$RUN/findings.json" --ledger "$RUN/ledger.json" --out "$RUN/report.md"
```

Reply with: the counts, each confirmed finding in one line (severity, title, where), what wasn't covered, and the
run folder. Don't paste the report. Offer next steps, without doing them unasked:
- fix the confirmed findings (the `katax-project-builder` agent, `katax-ecosystem` standard);
- add the regression test each finding names (`test` field), chosen with the `test-strategy` skill (a negative
  authorization test per confirmed authz/IDOR finding);
- run again later: unchanged units are carried, so the next run costs only what changed.

## Keeping token use down

- Scripts do inventory, coverage critic, validation and reporting; agents only judge code.
- Default to `diff`; `full` runs are incremental (`carry`).
- Hunters read only the files listed in their units plus what those call (repository, shared helper), never the
  whole repo, and stop at the first proof per check; no repo-wide sweeps.
- `architecture.md` is written once and passed to every agent.
- Verifiers get one candidate (or ≤ 3 small ones), not the hunt transcript.
- Mechanical rules come from `katax-audit.mjs`, not from agents.
