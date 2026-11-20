#!/usr/bin/env node
/**
 * katax-routes: deterministic inventory of a katax (Express) API's attack surface.
 * No dependencies, no network, reads source only.
 *
 * Usage:
 *   node katax-routes.mjs [projectDir] [--out ledger.json] [--md] [--diff <git-ref>] [--entry src/app.ts] [--group-size 20]
 *
 * Finds every endpoint (method, full path, middleware chain incl. inherited ones,
 * handler and the validator/controller it calls), MCP tools, socket events and
 * cron jobs, and writes them as units of a coverage ledger (status "planned").
 * --diff keeps only the units touched by files changed since <git-ref> (plus
 * working-tree changes) and lists changed shared files (middleware, auth, db)
 * as their own units. --md prints a table instead of JSON.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// ------------------------------------------------------------------ args
const argv = process.argv.slice(2);
const opt = { dir: '.', out: null, md: false, diff: null, entry: null, groupSize: 20 };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') opt.out = argv[++i];
  else if (a === '--md') opt.md = true;
  else if (a === '--diff') opt.diff = argv[++i];
  else if (a === '--entry') opt.entry = argv[++i];
  else if (a === '--group-size') opt.groupSize = Math.max(1, Number(argv[++i]) || 20);
  else if (a === '-h' || a === '--help') {
    console.log(readFileSync(new URL(import.meta.url)).toString().split('*/')[0]);
    process.exit(0);
  } else opt.dir = a;
}
const ROOT = resolve(opt.dir);
const SRC = existsSync(join(ROOT, 'src')) ? join(ROOT, 'src') : ROOT;
const rel = (p) => relative(ROOT, p).split('\\').join('/');

// ------------------------------------------------------------------ source helpers
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const raw = readFileSync(file, 'utf8');
  const code = stripComments(raw);
  const entry = { file, raw, code, lineStarts: lineStarts(raw) };
  cache.set(file, entry);
  return entry;
}
function lineStarts(text) {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') out.push(i + 1);
  return out;
}
function lineOf(entry, index) {
  let lo = 0, hi = entry.lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (entry.lineStarts[mid] <= index) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}
/** Blank out comments (keep strings, offsets and newlines). */
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && n === '*') {
      out += '  '; i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        out += src[i]; i++;
      }
      out += src[i] ?? ''; i++;
    } else { out += c; i++; }
  }
  return out;
}
/** Parse call arguments starting at the index of '('. Returns { args: [{text, start}], end }. */
function parseArgs(code, open) {
  const args = [];
  let depth = 0, start = open + 1, i = open;
  for (; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < code.length && code[i] !== q) { if (code[i] === '\\') i++; i++; }
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) { pushArg(); break; }
    } else if (c === ',' && depth === 1) { pushArg(); start = i + 1; }
  }
  return { args, end: i };
  function pushArg() {
    const text = code.slice(start, i).trim();
    if (text) args.push({ text, start: start + (code.slice(start, i).length - code.slice(start, i).trimStart().length) });
  }
}
const stringLiteral = (t) => (/^(["'`])([^"'`$]*)\1$/.exec(t) || [])[2] ?? null;
const shortText = (t) => t.replace(/\s+/g, ' ').slice(0, 80);

function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base.replace(/\.js$/, '.ts'), base, base + '.ts', join(base, 'index.ts'), base.replace(/\.js$/, '.mts')];
  return candidates.find((p) => existsSync(p) && statSync(p).isFile()) ?? null;
}
function importsOf(entry) {
  if (entry.imports) return entry.imports;
  const map = new Map();
  const re = /import\s+(?:type\s+)?([\w$]+)?\s*,?\s*(?:\{([^}]*)\})?\s*from\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(entry.code))) {
    const file = resolveImport(entry.file, m[3]);
    if (m[1]) map.set(m[1], { file, name: 'default', spec: m[3] });
    if (m[2]) for (const part of m[2].split(',')) {
      const [orig, alias] = part.replace(/\btype\b/, '').trim().split(/\s+as\s+/).map((s) => s.trim());
      if (orig) map.set(alias || orig, { file, name: orig, spec: m[3] });
    }
  }
  const ns = /import\s+\*\s+as\s+([\w$]+)\s+from\s*["']([^"']+)["']/g;
  while ((m = ns.exec(entry.code))) map.set(m[1], { file: resolveImport(entry.file, m[2]), name: '*', spec: m[2] });
  entry.imports = map;
  return map;
}

// ------------------------------------------------------------------ routers
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all', 'head', 'options'];

/** Router/app variables of a file and their calls, in source order. */
function routersOf(entry) {
  if (entry.routers) return entry.routers;
  const vars = new Set();
  const decl = /(?:const|let|var)\s+([\w$]+)\s*(?::\s*[\w.<>]+)?\s*=\s*(?:express\.)?(?:Router|express)\s*\(/g;
  let m;
  while ((m = decl.exec(entry.code))) vars.add(m[1]);
  const calls = [];
  if (vars.size) {
    const names = [...vars].map((v) => v.replace(/\$/g, '\\$')).join('|');
    const callRe = new RegExp(`\\b(${names})\\s*\\.\\s*(use|route|${METHODS.join('|')})\\s*\\(`, 'g');
    while ((m = callRe.exec(entry.code))) {
      const open = m.index + m[0].length - 1;
      const { args, end } = parseArgs(entry.code, open);
      if (m[2] === 'route') {
        const base = stringLiteral(args[0]?.text ?? '') ?? '';
        let pos = end + 1;
        const chain = /^\s*\.\s*(\w+)\s*\(/;
        for (;;) {
          const cm = chain.exec(entry.code.slice(pos));
          if (!cm || !METHODS.includes(cm[1])) break;
          const o = pos + cm[0].length - 1;
          const r = parseArgs(entry.code, o);
          calls.push({ router: m[1], kind: cm[1], path: base, args: r.args, index: pos });
          pos = r.end + 1;
        }
        callRe.lastIndex = pos;
        continue;
      }
      const first = args[0] ? stringLiteral(args[0].text) : null;
      const rest = first !== null ? args.slice(1) : args;
      calls.push({ router: m[1], kind: m[2], path: first, args: rest, index: m.index });
    }
  }
  const def = /export\s+default\s+([\w$]+)/.exec(entry.code)?.[1] ?? null;
  entry.routers = { vars, calls, defaultExport: def };
  return entry.routers;
}

function joinPath(a, b) {
  const p = `${a}/${b ?? ''}`.replace(/\/+/g, '/');
  return p.length > 1 ? p.replace(/\/$/, '') : p;
}

/** Locate a mounted router expression: local var or imported router file. */
function routerTarget(entry, expr) {
  const id = /^[\w$]+$/.test(expr) ? expr : null;
  if (!id) return null;
  const r = routersOf(entry);
  if (r.vars.has(id)) return { entry, router: id };
  const imp = importsOf(entry).get(id);
  if (imp?.file && /\.(m?ts|js)$/.test(imp.file)) {
    const target = load(imp.file);
    const tr = routersOf(target);
    const name = imp.name === 'default' ? tr.defaultExport : imp.name;
    if (name && tr.vars.has(name)) return { entry: target, router: name };
  }
  return null;
}

const endpoints = [];
const globalMiddleware = [];
const visiting = new Set();
function walk(entry, router, prefix, inherited, mountTrail) {
  const key = `${entry.file}#${router}#${prefix}`;
  if (visiting.has(key)) return;
  visiting.add(key);
  const scoped = [...inherited];
  for (const call of routersOf(entry).calls.filter((c) => c.router === router)) {
    if (call.kind === 'use') {
      const items = call.args.map((a) => a.text);
      const last = items[items.length - 1];
      const target = last ? routerTarget(entry, last) : null;
      const mws = (target ? items.slice(0, -1) : items).map((t) => mw(t)).filter((m) => m.kind !== 'docs');
      if (target) {
        walk(target.entry, target.router, joinPath(prefix, call.path ?? ''), [...scoped, ...mws], [...mountTrail, `${rel(entry.file)}:${lineOf(entry, call.index)}`]);
      } else if (call.path === null) {
        // pathless middleware applies to everything registered after it; on the app itself only
        // security-relevant kinds are kept per endpoint, the rest (helmet, cors, body parsers) go to `global`
        if (mountTrail.length === 0) {
          for (const m of mws) if (!globalMiddleware.some((g) => g.name === m.name)) globalMiddleware.push(m);
          scoped.push(...mws.filter((m) => ['auth', 'auth-optional', 'authz', 'rate-limit', 'csrf'].includes(m.kind)));
        } else scoped.push(...mws);
      } else {
        // path-scoped middleware (e.g. use('/auth', noStore)) or an unresolved sub-app
        scoped.push(...mws.map((m) => ({ ...m, onlyUnder: joinPath(prefix, call.path) })));
      }
      continue;
    }
    const items = call.args.map((a) => a.text);
    const handlerText = items[items.length - 1] ?? '';
    const full = joinPath(prefix, call.path ?? '');
    const chain = [...scoped.filter((m) => !m.onlyUnder || full === m.onlyUnder || full.startsWith(m.onlyUnder + '/')), ...items.slice(0, -1).map((t) => mw(t)).filter((m) => m.kind !== 'docs')];
    endpoints.push({
      method: call.kind.toUpperCase(),
      path: full,
      file: rel(entry.file),
      line: lineOf(entry, call.index),
      middleware: chain.map(({ name, callee, kind }) => ({ name, callee, kind })),
      handler: handlerInfo(entry, handlerText),
      mountedVia: mountTrail
    });
  }
}

function mw(text) {
  const name = shortText(text);
  if (/^(async\s*)?(\([^)]*\)|[\w$]+)\s*=>|^(async\s+)?function\b/.test(text)) return { name: shortText(text).slice(0, 60), kind: 'inline' };
  const callee = /^([\w$.]+)/.exec(text)?.[1] ?? name;
  return { name: callee === name.replace(/\(.*$/, '') ? name : name, callee, kind: classify(callee) };
}
function classify(callee) {
  if (/^docs$|openapi|swagger/i.test(callee)) return 'docs';
  if (/optional\w*auth/i.test(callee)) return 'auth-optional';
  if (/authenticat|requireJwt|requireAuth|verify\w*Token|apiKey|bearer|mcpAuth|requireSession|passport/i.test(callee)) return 'auth';
  if (/limiter|rateLimit|slowDown|throttle/i.test(callee)) return 'rate-limit';
  if (/multer|upload|\.single$|\.array$|\.fields$|cleanupUploadTemps/i.test(callee)) return 'upload';
  if (/sameSite|csrf|requireJsonBody|checkOrigin/i.test(callee)) return 'csrf';
  if (/^(require|deny)|role|permission|scope|admin|owner|isMember|^can[A-Z]/i.test(callee)) return 'authz';
  if (/valid/i.test(callee)) return 'validation';
  return 'other';
}

/** Find the handler's definition and the validator / controller it uses. */
function handlerInfo(entry, text) {
  if (!/^[\w$.]+$/.test(text)) return { name: '<inline>', file: rel(entry.file), line: null, uses: [] };
  const [id, member] = text.split('.');
  const imp = importsOf(entry).get(id);
  const target = imp?.file ? load(imp.file) : entry;
  const name = imp?.name === '*' && member ? member : imp ? (imp.name === 'default' ? id : imp.name) : id;
  const def = new RegExp(`export\\s+(?:const|async\\s+function|function)\\s+${name.replace(/\$/g, '\\$')}\\b`).exec(target.code)
    ?? new RegExp(`(?:const|async\\s+function|function)\\s+${name.replace(/\$/g, '\\$')}\\b`).exec(target.code);
  if (!def) return { name, file: imp?.file ? rel(imp.file) : rel(entry.file), line: null, uses: [] };
  const body = blockAfter(target.code, def.index);
  const uses = [];
  for (const [ident, info] of importsOf(target)) {
    if (!info.file || !new RegExp(`\\b${ident.replace(/\$/g, '\\$')}\\b`).test(body)) continue;
    const kind = /\.validator\./.test(info.file) ? 'validator' : /\.controller\./.test(info.file) ? 'controller'
      : /\.service\./.test(info.file) ? 'service' : /\.repository\./.test(info.file) ? 'repository' : null;
    if (kind) uses.push({ kind, name: ident, file: rel(info.file) });
  }
  return {
    name, file: rel(target.file), line: lineOf(target, def.index), uses,
    authInHandler: /\breq\.user\b|req\.headers\.authorization|requireAuthenticated|getUserId|verify\w*Token|currentUser/.test(body)
  };
}
function blockAfter(code, from) {
  const head = code.slice(from, from + 120);
  let open;
  if (/function/.test(head.split('(')[0])) {
    const paren = code.indexOf('(', from);
    const close = parseArgs(code, paren).end;
    open = code.indexOf('{', close);
  } else {
    const arrow = code.indexOf('=>', from);
    if (arrow < 0) return '';
    let i = arrow + 2;
    while (/\s/.test(code[i])) i++;
    if (code[i] !== '{') {
      // expression body: up to the end of the statement
      let depth = 0;
      for (let j = i; j < code.length; j++) {
        const c = code[j];
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) depth--;
        else if ((c === ';' || c === '\n') && depth <= 0 && code.slice(i, j).trim()) return code.slice(i, j);
      }
      return code.slice(i);
    }
    open = i;
  }
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return code.slice(open, i + 1);
  }
  return code.slice(open);
}

// ------------------------------------------------------------------ entry point
function findEntry() {
  const candidates = opt.entry ? [resolve(ROOT, opt.entry)] : ['app.ts', 'index.ts', 'server.ts', 'main.ts'].map((f) => join(SRC, f));
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const entry = load(file);
    const r = routersOf(entry);
    const app = [...r.vars].find((v) => new RegExp(`${v}\\s*=\\s*express\\s*\\(`).test(entry.code));
    if (app) return { entry, router: app };
  }
  const routes = join(SRC, 'api', 'routes.ts');
  if (existsSync(routes)) {
    const entry = load(routes);
    const r = routersOf(entry);
    return { entry, router: r.defaultExport ?? [...r.vars][0], prefix: '/api' };
  }
  return null;
}

// ------------------------------------------------------------------ other surfaces
function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walkFiles(p, out);
    else if (/\.(m?ts|js)$/.test(name) && !/\.(test|spec)\.|\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}
function depsOf(entry) {
  return [...new Set([...importsOf(entry).values()].map((i) => i.file).filter((f) => f && /\.(controller|validator|service|repository)\./.test(f)).map(rel))];
}
function otherSurfaces(files) {
  const units = [];
  for (const file of files) {
    const entry = load(file);
    const code = entry.code;
    let m;
    if (/mcp/i.test(rel(file)) && /tools?/i.test(rel(file))) {
      const re = /\bname\s*:\s*["']([a-z][\w.-]*)["']/g;
      while ((m = re.exec(code))) {
        const around = code.slice(m.index, m.index + 600);
        if (!/(handler|inputSchema|execute)\s*[:(]/.test(around)) continue;
        units.push({ id: `mcp:${m[1]}`, type: 'mcp-tool', name: m[1], file: rel(file), line: lineOf(entry, m.index), deps: depsOf(entry) });
      }
      const reg = /\.(?:registerTool|tool)\s*\(\s*["']([\w.-]+)["']/g;
      while ((m = reg.exec(code))) units.push({ id: `mcp:${m[1]}`, type: 'mcp-tool', name: m[1], file: rel(file), line: lineOf(entry, m.index) });
    }
    const sock = /\b(?:socket|client|io)\s*\.\s*on\s*\(\s*["']([\w:.-]+)["']/g;
    while ((m = sock.exec(code))) {
      if (['connection', 'disconnect', 'error', 'close'].includes(m[1])) continue;
      units.push({ id: `socket:${m[1]}`, type: 'socket-event', name: m[1], file: rel(file), line: lineOf(entry, m.index) });
    }
    const cron = /\b(?:katax\s*\.\s*cron|cron\s*\.\s*schedule)\s*\(/g;
    while ((m = cron.exec(code))) {
      const { args } = parseArgs(code, m.index + m[0].length - 1);
      const body = args.map((a) => a.text).join(' ');
      const name = /name\s*:\s*["']([\w:.-]+)["']/.exec(body)?.[1] ?? `${rel(file)}:${lineOf(entry, m.index)}`;
      units.push({ id: `cron:${name}`, type: 'cron', name, file: rel(file), line: lineOf(entry, m.index) });
    }
  }
  const seen = new Set();
  return units.filter((u) => (seen.has(u.id) ? false : seen.add(u.id)));
}

// ------------------------------------------------------------------ build
const start = findEntry();
if (!start) {
  console.error('katax-routes: no Express app or src/api/routes.ts found (use --entry <file>)');
  process.exit(2);
}
walk(start.entry, start.router, start.prefix ?? '', [], []);

const resourceOf = (file) => {
  const m = /(?:^|\/)api\/([^/]+)\//.exec(file) || /(?:^|\/)src\/([^/]+)\//.exec(file);
  return m ? m[1] : 'root';
};
function riskHints(e) {
  const kinds = new Set(e.middleware.map((m) => m.kind));
  const hints = [];
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(e.method);
  if (!kinds.has('auth') && !kinds.has('auth-optional')) {
    if (e.handler.authInHandler) hints.push('auth-in-handler');
    else hints.push(write ? 'public-write' : 'public');
    if (write && !kinds.has('rate-limit')) hints.push('public-write-without-limiter');
  }
  if (kinds.has('auth-optional')) hints.push('optional-auth');
  if (/:[\w]+/.test(e.path)) hints.push('id-in-path');
  if (kinds.has('upload')) hints.push('upload');
  if (kinds.has('upload') && !kinds.has('rate-limit')) hints.push('upload-without-route-limiter');
  if (e.handler.name === '<inline>') hints.push('inline-handler');
  if (!e.handler.uses?.some((u) => u.kind === 'validator')) hints.push('no-validator-seen');
  return hints;
}

const units = endpoints.map((e) => ({
  id: `${e.method} ${e.path}`,
  type: 'endpoint',
  resource: resourceOf(e.handler.file || e.file),
  ...e,
  hints: riskHints(e),
  status: 'planned',
  checks: []
}));
const dedup = new Map();
for (const u of units) {
  if (dedup.has(u.id)) dedup.get(u.id).aliases = [...(dedup.get(u.id).aliases ?? []), `${u.file}:${u.line}`];
  else dedup.set(u.id, u);
}
const all = [...dedup.values()];
const files = walkFiles(SRC);
for (const u of otherSurfaces(files)) {
  // an MCP tool is grouped with the REST resource whose controller it calls, so one hunter checks both (parity)
  const twin = (u.deps ?? []).find((d) => /\.controller\./.test(d));
  all.push({ ...u, resource: twin ? resourceOf(twin) : resourceOf(u.file), status: 'planned', checks: [] });
}

// ------------------------------------------------------------------ diff scope
function usedBy(file) {
  const abs = join(ROOT, file);
  if (!existsSync(abs)) return [];
  const exported = new Set([...load(abs).code.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([\w$]+)/g)].map((m) => m[1]));
  const users = all.filter((u) => u.middleware?.some((m) => exported.has((m.callee ?? '').split('.')[0])));
  return { endpoints: users.length, sample: users.slice(0, 10).map((u) => u.id), exported: [...exported].slice(0, 20) };
}
let scope = { mode: 'full' };
let selected = all;
if (opt.diff) {
  const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);
  let changed;
  try {
    changed = new Set([
      ...git(['diff', '--name-only', opt.diff]),
      ...git(['ls-files', '--others', '--exclude-standard'])
    ].map((f) => f.split('\\').join('/')));
  } catch (error) {
    console.error(`katax-routes: git diff against "${opt.diff}" failed: ${error.message}`);
    process.exit(2);
  }
  const changedDirs = new Set([...changed].map((f) => dirname(f)));
  const touched = (u) => {
    const fs = [u.file, u.handler?.file, ...(u.handler?.uses ?? []).map((x) => x.file), ...(u.deps ?? [])].filter(Boolean);
    return fs.some((f) => changed.has(f) || changedDirs.has(dirname(f)));
  };
  selected = all.filter(touched);
  const shared = [...changed].filter((f) => /\.(m?ts|js)$/.test(f) && /(^|\/)(middleware|shared|config|mcp|services|workers|repositories)\//.test(f) && !/\.(test|spec)\./.test(f));
  for (const f of shared) {
    if (selected.some((u) => u.file === f)) continue;
    selected.push({ id: `file:${f}`, type: 'shared-file', resource: resourceOf(f), file: f, line: 1, status: 'planned', checks: [],
      usedBy: usedBy(f) });
  }
  for (const f of changed) if (/^migrations\/.*\.sql$|\.sql$/.test(f)) selected.push({ id: `file:${f}`, type: 'migration', resource: 'migrations', file: f, line: 1, status: 'planned', checks: [] });
  scope = { mode: 'diff', ref: opt.diff, changedFiles: [...changed].sort() };
}

// Content hash of the files each unit depends on: a later run can carry over units whose code didn't change.
for (const u of selected) {
  const files = [...new Set([u.file, u.handler?.file, ...(u.handler?.uses ?? []).map((x) => x.file), ...(u.deps ?? [])].filter(Boolean))].sort();
  const h = createHash('sha256');
  for (const f of files) { const abs = join(ROOT, f); h.update(f); if (existsSync(abs)) h.update(readFileSync(abs)); }
  u.files = files;
  u.hash = h.digest('hex').slice(0, 16);
}

// Hunting groups: one per resource, split when larger than --group-size (one hunter each).
const groups = [];
const byRes = new Map();
for (const u of selected) byRes.set(u.resource, [...(byRes.get(u.resource) ?? []), u]);
for (const [resource, list] of [...byRes].sort((a, b) => b[1].length - a[1].length)) {
  list.sort((a, b) => (a.handler?.name ?? a.name ?? a.id).localeCompare(b.handler?.name ?? b.name ?? b.id));
  const chunks = Math.ceil(list.length / opt.groupSize);
  const size = Math.ceil(list.length / chunks);
  for (let i = 0; i < chunks; i++) {
    const id = chunks > 1 ? `${resource}#${i + 1}` : resource;
    const part = list.slice(i * size, (i + 1) * size);
    for (const u of part) u.group = id;
    groups.push({ id, resource, units: part.length });
  }
}
// Tiny groups (< 4 units) share a hunter: fewer agents, same coverage.
const tiny = groups.filter((g) => g.units < 4);
if (tiny.length > 1) {
  let n = 0, current = null;
  for (const g of tiny) {
    if (!current || current.units + g.units > opt.groupSize) {
      current = { id: `misc#${++n}`, resource: 'misc', units: 0, resources: [] };
      groups.push(current);
    }
    current.units += g.units;
    current.resources.push(g.resource);
    for (const u of selected) if (u.group === g.id) u.group = current.id;
    groups.splice(groups.indexOf(g), 1);
  }
}

const ledger = {
  version: 1,
  project: rel(ROOT) || '.',
  generatedAt: new Date().toISOString(),
  commit: (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } })(),
  entry: `${rel(start.entry.file)} (${start.router})`,
  globalMiddleware: globalMiddleware.map(({ name, kind }) => ({ name, kind })),
  scope,
  groups,
  summary: {
    units: selected.length,
    byType: selected.reduce((acc, u) => ({ ...acc, [u.type]: (acc[u.type] ?? 0) + 1 }), {}),
    byResource: selected.reduce((acc, u) => ({ ...acc, [u.resource]: (acc[u.resource] ?? 0) + 1 }), {}),
    hints: selected.flatMap((u) => u.hints ?? []).reduce((acc, h) => ({ ...acc, [h]: (acc[h] ?? 0) + 1 }), {})
  },
  units: selected
};

if (opt.md) {
  const rows = selected.map((u) => u.type === 'endpoint'
    ? `| ${u.id} | ${u.middleware.map((m) => m.kind === 'other' ? m.name : `${m.kind}:${m.name}`).join(', ') || '—'} | ${u.handler.name} | ${u.hints.join(', ')} |`
    : `| ${u.id} | ${u.type} | ${u.file}:${u.line} | |`);
  console.log(`# Surface of ${ledger.project} (${ledger.summary.units} units, ${scope.mode})\n\n| Unit | Middleware | Handler | Hints |\n|---|---|---|---|\n${rows.join('\n')}`);
} else {
  const json = JSON.stringify(ledger, null, 2);
  if (opt.out) { writeFileSync(opt.out, json + '\n'); console.log(`katax-routes: ${selected.length} units -> ${opt.out}`); }
  else console.log(json);
}
