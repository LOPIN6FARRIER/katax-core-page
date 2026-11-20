#!/usr/bin/env node
/**
 * katax-findings: deterministic checks for a katax security audit run. No dependencies.
 *
 *   node katax-findings.mjs ledger <ledger.json> [--complete]
 *       Ledger shape; with --complete every unit must be checked/skipped/carried (end of hunting).
 *   node katax-findings.mjs findings <findings.json> --ledger <ledger.json> [--root <project>]
 *       Findings shape, per-status required fields, unit ids exist, file:line locations exist.
 *   node katax-findings.mjs carry <previous-ledger.json> <new-ledger.json> [--out <file>]
 *       Copies status and checks of units whose files are unchanged (same hash) from a previous run,
 *       so the next run only hunts what changed or was never covered.
 *   node katax-findings.mjs gaps <ledger.json>
 *       Coverage critic without a model: lists units missing a check class their hints require
 *       (e.g. an id in the path needs idor-parent-scope, an upload needs upload). A check with
 *       result "n/a" counts. Exit 1 when gaps remain.
 *   node katax-findings.mjs report <findings.json> --ledger <ledger.json> [--out report.md]
 *       Markdown report built only from validated records (no model writing involved).
 *
 * Exit code 0 = valid, 1 = problems found (listed), 2 = usage error.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const UNIT_STATUSES = ['planned', 'in_progress', 'checked', 'skipped', 'carried'];
export const CHECK_RESULTS = ['ok', 'candidate', 'n/a'];
export const FINDING_STATUSES = ['confirmed', 'needs_validation', 'rejected', 'hardening'];
export const SEVERITIES = ['critical', 'high', 'medium', 'low'];
export const CLASSES = [
  'authn', 'authz-membership', 'idor-parent-scope', 'scope-capability', 'mcp-parity', 'mass-assignment',
  'sql-injection', 'race-condition', 'upload', 'info-leak', 'secrets-config', 'rate-limit', 'csrf-cookie',
  'token-confusion', 'ssrf', 'path-traversal', 'resource-exhaustion', 'tenant-isolation', 'business-logic',
  'migration', 'other'
];

const [, , cmd, ...rest] = process.argv;
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) {
    const key = rest[i].slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i++; }
  } else positional.push(rest[i]);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.error(`katax-findings: can't read ${path}: ${error.message}`);
    process.exit(2);
  }
}
const problems = [];
const problem = (where, message) => problems.push(`${where}: ${message}`);
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;

function checkLedger(ledger, { complete }) {
  if (!Array.isArray(ledger.units)) return problem('ledger', '`units` must be an array');
  const ids = new Set();
  for (const [i, u] of ledger.units.entries()) {
    const where = `units[${i}] ${u.id ?? '?'}`;
    if (!isStr(u.id)) problem(where, 'missing id');
    if (ids.has(u.id)) problem(where, 'duplicate id');
    ids.add(u.id);
    if (!UNIT_STATUSES.includes(u.status)) problem(where, `status must be one of ${UNIT_STATUSES.join('|')}`);
    if (complete && ['planned', 'in_progress'].includes(u.status)) problem(where, `still ${u.status} (every unit must be checked, skipped with a reason, or carried)`);
    if (u.status === 'skipped' && !isStr(u.skipReason)) problem(where, 'skipped needs skipReason');
    if (!Array.isArray(u.checks)) problem(where, '`checks` must be an array');
    for (const [j, c] of (u.checks ?? []).entries()) {
      const w = `${where} checks[${j}]`;
      if (!CLASSES.includes(c.class)) problem(w, `class must be one of ${CLASSES.join('|')}`);
      if (!CHECK_RESULTS.includes(c.result)) problem(w, `result must be one of ${CHECK_RESULTS.join('|')}`);
      if (c.result !== 'n/a' && !isStr(c.evidence)) problem(w, 'evidence (file:line and what it shows) is required');
    }
    if (u.status === 'checked' && (u.checks ?? []).length === 0) problem(where, 'checked without any check recorded');
  }
  return ids;
}

function checkLocation(where, loc, root) {
  if (!isStr(loc?.file)) return problem(where, 'location needs file');
  if (!Number.isInteger(loc.line) || loc.line < 1) return problem(where, 'location needs a positive integer line');
  if (!root) return;
  const abs = resolve(root, loc.file);
  if (!existsSync(abs)) return problem(where, `${loc.file} does not exist`);
  const lines = readFileSync(abs, 'utf8').split('\n').length;
  if (loc.line > lines) problem(where, `${loc.file} has ${lines} lines, not ${loc.line}`);
}

function checkFindings(doc, unitIds, root) {
  if (!Array.isArray(doc.findings)) return problem('findings', '`findings` must be an array');
  const ids = new Set();
  const prints = new Set();
  for (const [i, f] of doc.findings.entries()) {
    const where = `findings[${i}] ${f.id ?? '?'}`;
    if (!/^F-\d{3,}$/.test(f.id ?? '')) problem(where, 'id must look like F-001');
    if (ids.has(f.id)) problem(where, 'duplicate id');
    ids.add(f.id);
    if (!isStr(f.fingerprint)) problem(where, 'fingerprint required (unit + class + root cause, stable across runs)');
    else if (prints.has(f.fingerprint)) problem(where, 'duplicate fingerprint: merge the records');
    prints.add(f.fingerprint);
    if (!FINDING_STATUSES.includes(f.status)) problem(where, `status must be one of ${FINDING_STATUSES.join('|')}`);
    if (!CLASSES.includes(f.class)) problem(where, `class must be one of ${CLASSES.join('|')}`);
    if (!isStr(f.title)) problem(where, 'title required');
    const units = Array.isArray(f.units) ? f.units : [];
    if (units.length === 0) problem(where, 'units (ledger ids) required');
    for (const u of units) if (unitIds && !unitIds.has(u)) problem(where, `unit "${u}" is not in the ledger`);
    const locations = Array.isArray(f.locations) ? f.locations : [];
    if (locations.length === 0) problem(where, 'at least one location {file, line}');
    for (const [j, loc] of locations.entries()) checkLocation(`${where} locations[${j}]`, loc, root);
    if (!isStr(f.evidence)) problem(where, 'evidence required (what the code does, quoted minimally)');

    if (f.status === 'confirmed') {
      if (!SEVERITIES.includes(f.severity)) problem(where, `confirmed needs severity ${SEVERITIES.join('|')}`);
      if (!isStr(f.attack)) problem(where, 'confirmed needs attack (caller, request, precondition, result)');
      if (!isStr(f.impact)) problem(where, 'confirmed needs impact');
      if (!isStr(f.fix)) problem(where, 'confirmed needs fix');
      if (f.verification?.verdict !== 'survived') problem(where, 'confirmed needs verification.verdict = "survived" from a fresh verifier');
    } else if (f.severity !== undefined && f.severity !== null) {
      problem(where, `${f.status} must not carry a severity`);
    }
    if (f.status === 'needs_validation' && !isStr(f.openQuestion)) problem(where, 'needs_validation needs openQuestion (what would settle it)');
    if (f.status === 'rejected' && !isStr(f.rejectionReason)) problem(where, 'rejected needs rejectionReason (which layer blocks it)');
    if (f.status === 'hardening' && !isStr(f.fix)) problem(where, 'hardening needs fix');
    if (['confirmed', 'rejected'].includes(f.status) && !isStr(f.verification?.reasoning)) problem(where, 'verification.reasoning required');
  }
}

/** Check classes each unit must have recorded before hunting is considered done. */
export function requiredClasses(u) {
  const need = new Set();
  const hints = new Set(u.hints ?? []);
  const kinds = new Set((u.middleware ?? []).map((m) => m.kind));
  if (u.type === 'endpoint') {
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(u.method);
    if (kinds.has('auth') || hints.has('auth-in-handler') || hints.has('optional-auth')) need.add('authz-membership');
    if (hints.has('public') || hints.has('public-write') || hints.has('optional-auth')) need.add('authn');
    if (hints.has('id-in-path')) need.add('idor-parent-scope');
    if (hints.has('public-write') || hints.has('public-write-without-limiter')) need.add('rate-limit');
    if (hints.has('upload')) { need.add('upload'); need.add('resource-exhaustion'); }
    if (write && ['POST', 'PUT', 'PATCH'].includes(u.method)) need.add('mass-assignment');
  } else if (u.type === 'mcp-tool') {
    need.add('mcp-parity');
    need.add('authz-membership');
  } else if (u.type === 'socket-event') {
    need.add('authz-membership');
  } else if (u.type === 'migration') {
    need.add('migration');
  }
  return [...need];
}

function gaps(ledger) {
  const out = [];
  for (const u of ledger.units) {
    if (['skipped'].includes(u.status)) continue;
    const have = new Set((u.checks ?? []).map((c) => c.class));
    const missing = requiredClasses(u).filter((c) => !have.has(c));
    if ((u.checks ?? []).length === 0) out.push({ id: u.id, resource: u.resource, missing: missing.length ? missing : ['any'] });
    else if (missing.length) out.push({ id: u.id, resource: u.resource, missing });
  }
  return out;
}

function carry(prev, next) {
  const before = new Map(prev.units.map((u) => [u.id, u]));
  let carried = 0;
  for (const u of next.units) {
    const p = before.get(u.id);
    if (!p || !p.hash || p.hash !== u.hash) continue;
    if (!['checked', 'carried'].includes(p.status)) continue;
    u.status = 'carried';
    u.checks = p.checks ?? [];
    u.carriedFrom = prev.generatedAt ?? 'previous run';
    carried++;
  }
  return carried;
}

function report(doc, ledger) {
  const by = (s) => doc.findings.filter((f) => f.status === s);
  const order = (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity);
  const loc = (f) => f.locations.map((l) => `\`${l.file}:${l.line}\``).join(', ');
  const units = ledger?.units ?? [];
  const count = (s) => units.filter((u) => u.status === s).length;
  const lines = [
    `# Security audit — ${ledger?.project ?? doc.project ?? ''}`,
    '',
    `Commit ${ledger?.commit ?? 'unknown'} · scope ${ledger?.scope?.mode ?? 'full'} · ${units.length} units ` +
      `(${count('checked')} checked, ${count('carried')} carried from a previous run, ${count('skipped')} skipped)`,
    '',
    `| Confirmed | Needs validation | Hardening | Rejected |`,
    `|---|---|---|---|`,
    `| ${by('confirmed').length} | ${by('needs_validation').length} | ${by('hardening').length} | ${by('rejected').length} |`,
    ''
  ];
  if (by('confirmed').length) {
    lines.push('## Confirmed', '');
    for (const f of by('confirmed').sort(order)) {
      lines.push(`### ${f.id} · ${f.severity} · ${f.title}`, '', `- Class: ${f.class} · Units: ${f.units.join(', ')}`, `- Where: ${loc(f)}`,
        `- Attack: ${f.attack}`, `- Impact: ${f.impact}`, `- Fix: ${f.fix}`);
      if (f.test) lines.push(`- Test to add: ${f.test}`);
      lines.push('');
    }
  }
  if (by('needs_validation').length) {
    lines.push('## Needs validation', '');
    for (const f of by('needs_validation')) lines.push(`- **${f.id}** ${f.title} (${loc(f)}). Open question: ${f.openQuestion}`);
    lines.push('');
  }
  if (by('hardening').length) {
    lines.push('## Hardening (another layer already blocks the attack)', '');
    for (const f of by('hardening')) lines.push(`- **${f.id}** ${f.title} (${loc(f)}): ${f.fix}`);
    lines.push('');
  }
  if (by('rejected').length) {
    lines.push('## Rejected candidates', '');
    for (const f of by('rejected')) lines.push(`- ${f.id} ${f.title}: ${f.rejectionReason}`);
    lines.push('');
  }
  const skipped = units.filter((u) => u.status === 'skipped');
  if (skipped.length) {
    lines.push('## Not covered', '');
    for (const u of skipped) lines.push(`- ${u.id}: ${u.skipReason}`);
    lines.push('');
  }
  return lines.join('\n');
}

function finish(okMessage) {
  if (problems.length) {
    console.log(problems.map((p) => `✗ ${p}`).join('\n'));
    console.log(`\n${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log(`✓ ${okMessage}`);
}

switch (cmd) {
  case 'ledger': {
    if (!positional[0]) break;
    const ledger = readJson(positional[0]);
    checkLedger(ledger, { complete: Boolean(flags.complete) });
    finish(`ledger valid (${ledger.units.length} units)`);
    process.exit(0);
  }
  case 'findings': {
    if (!positional[0]) break;
    const doc = readJson(positional[0]);
    const ledger = flags.ledger ? readJson(flags.ledger) : null;
    const ids = ledger ? checkLedger(ledger, { complete: false }) : null;
    checkFindings(doc, ids, flags.root ? resolve(flags.root) : null);
    finish(`findings valid (${doc.findings.length} records)`);
    process.exit(0);
  }
  case 'carry': {
    if (positional.length < 2) break;
    const prev = readJson(positional[0]);
    const next = readJson(positional[1]);
    const n = carry(prev, next);
    writeFileSync(flags.out || positional[1], JSON.stringify(next, null, 2) + '\n');
    console.log(`✓ carried ${n} unchanged unit(s); ${next.units.filter((u) => u.status === 'planned').length} left to hunt`);
    process.exit(0);
  }
  case 'gaps': {
    if (!positional[0]) break;
    const ledger = readJson(positional[0]);
    const list = gaps(ledger);
    if (flags.json) console.log(JSON.stringify(list, null, 2));
    else for (const g of list) console.log(`✗ ${g.id} [${g.resource}] missing: ${g.missing.join(', ')}`);
    console.log(list.length ? `\n${list.length} unit(s) with coverage gaps` : '✓ no coverage gaps');
    process.exit(list.length ? 1 : 0);
  }
  case 'report': {
    if (!positional[0]) break;
    const doc = readJson(positional[0]);
    const ledger = flags.ledger ? readJson(flags.ledger) : null;
    checkFindings(doc, ledger ? new Set(ledger.units.map((u) => u.id)) : null, null);
    if (problems.length) finish('');
    const md = report(doc, ledger);
    if (flags.out) { writeFileSync(flags.out, md + '\n'); console.log(`✓ report -> ${flags.out}`); }
    else console.log(md);
    process.exit(0);
  }
  default:
}
console.error(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
process.exit(2);
