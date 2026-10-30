#!/usr/bin/env node
/**
 * katax-audit: checks a katax API (katax-core / katax-service-manager) against
 * the house standard in the katax-skills plugin.
 *
 * Modes
 *   node katax-audit.mjs <dir|file> [--json] [--errors-only]   audit a project or one file
 *   node katax-audit.mjs --hook post                           Claude Code PostToolUse hook (reads stdin)
 *   node katax-audit.mjs --hook stop                           Claude Code Stop hook (reads stdin)
 *
 * Findings are "error" (breaks the standard: the hook blocks) or "warn"
 * (needs a look: reported, not blocking). Silence one occurrence with a
 * comment on the same or the previous line, saying why:
 *   // katax-audit-ignore <rule-id>: <reason>
 * or a whole file with `// katax-audit-ignore-file <rule-id>: <reason>`.
 *
 * No dependencies: Node >= 18 only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';

// ---------------------------------------------------------------- helpers

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', 'migrations', '.katax']);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Nearest package.json that depends on katax; null when the file is not in a katax project. */
export function findKataxRoot(start) {
  let dir = fs.existsSync(start) && fs.statSync(start).isDirectory() ? start : path.dirname(start);
  for (;;) {
    const pkg = readJson(path.join(dir, 'package.json'));
    if (pkg) {
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps['katax-core'] || deps['katax-service-manager']) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (/\.ts$/.test(entry.name) && !/\.(test|spec)\.ts$|\.d\.ts$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function kindOf(rel) {
  const base = path.basename(rel);
  const m = /\.(controller|handler|repository|queries|validator|routes|types|service|tools|worker|job|scheduler|calculator|rules)\.ts$/.exec(base);
  if (m) return m[1];
  if (/\/workers\//.test(rel) || /\/jobs\//.test(rel)) return 'worker';
  if (/\/middleware\//.test(rel)) return 'middleware';
  return 'other';
}

const lineOf = (src, index) => src.slice(0, index).split('\n').length;

/** Text of a call starting at `openIndex` (the "(") up to its matching ")". */
function callText(src, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < src.length && i < openIndex + 4000; i++) {
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return src.slice(openIndex, i + 1);
    }
  }
  return src.slice(openIndex, openIndex + 400);
}


/** Same text with comments replaced by spaces (newlines kept), so rules never match inside comments. */
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += src[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    out += ch;
    i++;
  }
  return out;
}

function ignored(lines, line, rule, fileIgnores) {
  if (fileIgnores.has(rule)) return true;
  const here = lines[line - 1] ?? '';
  const prev = lines[line - 2] ?? '';
  const re = new RegExp(`katax-audit-ignore\\s+${rule}\\b`);
  return re.test(here) || re.test(prev);
}

// String literals that contain SQL. Template literals and quotes, multi-line.
const SQL_IN_STRING = /(['"`])(?:(?!\1)[\s\S])*?\b(SELECT\s+[\w*(]|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b[\s\S]*?\1/gi;

// ---------------------------------------------------------------- rules

/**
 * Each rule: id, level, applies(kind, rel), check(src, ctx) -> [{ index, message }]
 * `fix` is the one-line remedy shown with the finding.
 */
const RULES = [
  {
    id: 'sql-outside-repository',
    level: 'error',
    fix: 'Move the query into <resource>.repository.ts (services, workers and controllers call repository functions).',
    applies: (kind, rel) =>
      !['repository', 'queries'].includes(kind) &&
      !/(^|\/)shared\/(db|job-lock\.utils)\.ts$/.test(rel) &&
      !/\/(scripts|seeds?)\//.test(rel),
    check(src) {
      const out = [];
      for (const m of src.matchAll(SQL_IN_STRING)) out.push({ index: m.index, message: 'SQL outside a repository' });
      return out.slice(0, 3);
    }
  },
  {
    id: 'begin-on-pool',
    level: 'error',
    fix: 'Use withTransaction() from shared/db.ts: BEGIN on the pool may run each statement on a different connection.',
    applies: (kind, rel) => !/(^|\/)shared\/db\.ts$/.test(rel),
    check(src) {
      const out = [];
      for (const m of src.matchAll(/(db\(\)|\bdb|this\.db|getDb\(\)|pool)\s*\.query\(\s*['"`]\s*(BEGIN|START TRANSACTION)/gi)) {
        out.push({ index: m.index, message: 'BEGIN sent through the connection pool' });
      }
      return out;
    }
  },
  {
    id: 'fallback-secret',
    level: 'error',
    fix: 'Read the secret from the environment and throw when it is missing; never ship a default value.',
    applies: () => true,
    check(src) {
      const out = [];
      const re = /\b\w*(SECRET|PRIVATE_KEY|API_KEY|PASSWORD|TOKEN)\w*['"]?\s*\]?\)?\s*(\|\||\?\?)\s*(['"`])([^'"`\n]{4,})\3/g;
      for (const m of src.matchAll(re)) out.push({ index: m.index, message: `default secret value "${m[4].slice(0, 24)}"` });
      return out;
    }
  },
  {
    id: 'secret-at-module-scope',
    level: 'warn',
    fix: 'Read secrets inside the function that uses them: a module-level constant can freeze undefined before .env loads.',
    applies: () => true,
    check(src) {
      const out = [];
      for (const m of src.matchAll(/^(export\s+)?const\s+\w*(SECRET|PRIVATE_KEY)\w*\s*=\s*process\.env/gm)) {
        out.push({ index: m.index, message: 'secret read into a module-level constant' });
      }
      return out;
    }
  },
  {
    id: 'jwt-verify-algorithms',
    level: 'error',
    fix: "Pin the algorithm: jwt.verify(token, secret, { algorithms: ['HS256'] }).",
    applies: () => true,
    check(src) {
      const out = [];
      for (const m of src.matchAll(/\bjwt\.verify\s*\(/g)) {
        const call = callText(src, m.index + m[0].length - 1);
        if (!/algorithms\s*:/.test(call)) out.push({ index: m.index, message: 'jwt.verify without algorithms' });
      }
      return out;
    }
  },
  {
    id: 'error-message-leak',
    level: 'error',
    fix: 'Return toSafeErrorResult(error, { context }) (logs the real error, answers a generic message); throw an AppError for expected failures.',
    applies: (kind, rel) => ['controller', 'handler', 'middleware', 'service'].includes(kind) || /api\.utils\.ts$/.test(rel),
    check(src) {
      const out = [];
      const lines = src.split('\n');
      lines.forEach((text, i) => {
        if (!/\b(error|err|e)\.message\b|\(error as Error\)\.message/.test(text)) return;
        if (/logger|console\.|log\(/.test(text)) return;
        if (!/createResponse|createErrorResult|res\.(json|status|send)|return\s*\{|message\s*:/.test(text)) return;
        // Inside a multi-line logger call (`logger.error({ ..., message: err.message })`): logging is fine.
        const prev = lines.slice(Math.max(0, i - 10), i);
        const loggerAt = prev.map((l) => /logger\.|console\./.test(l)).lastIndexOf(true);
        if (loggerAt !== -1 && !/\)\s*;?\s*$/.test(prev[loggerAt]) && !prev.slice(loggerAt + 1).some((l) => /\)\s*;?\s*$/.test(l) && /^\s*\}\s*\)/.test(l))) return;
        const before = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
        if (/isAppError|instanceof\s+AppError|isKataxError|instanceof\s+\w*ValidationError/.test(before)) return;
        out.push({ index: lines.slice(0, i).join('\n').length + 1, message: 'error.message sent to the client' });
      });
      return out;
    }
  },
  {
    id: 'error-message-matching',
    level: 'warn',
    fix: 'Throw a typed AppError where the failure happens instead of comparing message text.',
    applies: (kind) => ['controller', 'handler', 'service'].includes(kind),
    check(src) {
      const out = [];
      for (const m of src.matchAll(/\b(error|err|e)\.message\s*(===|!==|\?*\.includes\()/g)) out.push({ index: m.index, message: 'status decided by comparing error.message' });
      return out;
    }
  },
  {
    id: 'cors-open-with-credentials',
    level: 'error',
    fix: 'With credentials use the ALLOWED_ORIGINS allow-list; open origins (MCP/OAuth) must use credentials: false.',
    applies: () => true,
    check(src) {
      const out = [];
      for (const m of src.matchAll(/origin\s*:\s*(true|['"]\*['"])/g)) {
        const around = src.slice(Math.max(0, m.index - 250), m.index + 250);
        if (/credentials\s*:\s*true/.test(around)) out.push({ index: m.index, message: 'open CORS origin with credentials: true' });
      }
      return out;
    }
  },
  {
    id: 'db-in-controller',
    level: 'error',
    fix: 'Controllers and handlers call repository functions; only repositories import db() / katax.db(). Importing withTransaction / lockKey / SqlExecutor is fine.',
    applies: (kind) => ['controller', 'handler'].includes(kind),
    check(src) {
      const out = [];
      for (const m of src.matchAll(/katax\.db\(|\bdb\(\)\.query|getDb\(\)\.query/g)) out.push({ index: m.index, message: 'database access from a controller/handler' });
      for (const m of src.matchAll(/import\s+([^;]*?)\s+from\s+['"][./]+(shared|database)\/(db|connection)(\.utils)?\.js['"]/g)) {
        const names = m[1].replace(/^type\s+/, '');
        const allowed = /^\{[\s\w,]*\}$/.test(names.trim()) && names.replace(/[{}\s]/g, '').split(',').filter(Boolean).every((n) => /^(type)?(withTransaction|lockKey|SqlExecutor|Tx)$/.test(n.replace(/^type/, '')));
        if (!allowed) out.push({ index: m.index, message: 'controller/handler imports the database accessor' });
      }
      return out;
    }
  },
  {
    id: 'req-res-in-controller',
    level: 'error',
    fix: 'Controllers take (userId, input) and return ControllerResult; cookies go in result.cookies.',
    // mcp/oauth.controller.ts is an Express handler by design (redirects, HTML login form).
    applies: (kind, rel) => kind === 'controller' && !/(^|\/)mcp\/.*oauth/.test(rel),
    check(src) {
      const out = [];
      for (const m of src.matchAll(/\b(req|res)\.(body|params|query|headers|cookies?|status|json|send|user|setHeader|clearCookie)\b/g)) {
        out.push({ index: m.index, message: `${m[1]}.${m[2]} used in a controller` });
      }
      return out.slice(0, 3);
    }
  },
  {
    id: 'query-param-coerce',
    level: 'error',
    fix: 'Query strings are strings: use k.coerce.number() / k.coerce.boolean().',
    applies: (kind) => kind === 'validator',
    check(src) {
      const out = [];
      for (const m of src.matchAll(/\w*[Qq]uery\w*Schema\s*=\s*k\.object\(\s*\{/g)) {
        const body = callText(src, src.indexOf('(', m.index));
        for (const n of body.matchAll(/(?<!coerce)\.?\bk\.(number|boolean)\(\)/g)) {
          out.push({ index: m.index + body.indexOf(n[0]), message: `k.${n[1]}() in a query schema` });
        }
      }
      return out;
    }
  },
  {
    id: 'user-id-in-schema',
    level: 'warn',
    fix: 'The caller comes from req.user / the MCP identity, never from the body. A field for ANOTHER user (invite, transfer) is fine: name it member_id / target_user_id.',
    applies: (kind) => kind === 'validator',
    check(src) {
      const out = [];
      for (const m of src.matchAll(/(\w+)\s*=\s*k\s*\.object\(/g)) {
        if (/Response|Row|View|Output/i.test(m[1])) continue;
        const body = callText(src, src.indexOf('(', m.index + m[0].length - 1));
        for (const n of body.matchAll(/\b(user_id|userId|owner_id|ownerId)\s*:\s*k\./g)) {
          out.push({ index: m.index + body.indexOf(n[0]), message: `${n[1]} accepted as input in ${m[1]}` });
        }
      }
      return out;
    }
  },
  {
    id: 'single-use-get-then-del',
    level: 'error',
    fix: 'Consume one-time codes atomically: GETDEL (Redis) or UPDATE ... WHERE used_at IS NULL RETURNING (SQL).',
    applies: () => true,
    check(src) {
      if (/GETDEL|getDel/.test(src)) return [];
      const get = /redis\(\s*['"]GET['"]|\.get\(\s*\w*(KEY|key|Prefix|PREFIX)/.exec(src);
      const del = /redis\(\s*['"]DEL['"]|\.del\(/.exec(src);
      if (get && del && /code|token|state|nonce|challenge/i.test(src)) {
        return [{ index: del.index, message: 'one-time value read with GET and removed with a separate DEL' }];
      }
      return [];
    }
  },
  {
    id: 'unconditional-revoke',
    level: 'warn',
    fix: 'Claim the session atomically: UPDATE ... SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id; continue only if a row came back.',
    applies: () => true,
    check(src) {
      const out = [];
      for (const m of src.matchAll(/UPDATE\s+\w+\s+SET\s+revoked_at\s*=\s*(now\(\)|NOW\(\)|CURRENT_TIMESTAMP)[^'"`;]*/gi)) {
        if (!/revoked_at\s+IS\s+NULL/i.test(m[0])) out.push({ index: m.index, message: 'revocation without "revoked_at IS NULL" (a race if used to rotate a refresh token)' });
      }
      return out;
    }
  },
  {
    id: 'incr-then-expire',
    level: 'error',
    fix: 'Increment and set the TTL in one Lua script (skill katax-ecosystem: assets/templates/shared/rate-limit.store.ts).',
    applies: () => true,
    check(src) {
      const incr = /redis\(\s*['"]INCR['"]|\.incr\(/.exec(src);
      const exp = /redis\(\s*['"]P?EXPIRE['"]|\.p?expire\(/.exec(src);
      return incr && exp ? [{ index: incr.index, message: 'INCR and EXPIRE sent as separate commands' }] : [];
    }
  },
  {
    id: 'inline-types',
    level: 'warn',
    fix: 'Views and params go in <resource>.types.ts, rows in types/db.types.ts, inputs are inferred in the validator.',
    applies: (kind) => ['controller', 'handler'].includes(kind),
    check(src) {
      const out = [];
      for (const m of src.matchAll(/^\s*(export\s+)?(interface\s+\w+|type\s+\w+\s*(<[^>]*>)?\s*=)/gm)) out.push({ index: m.index, message: `type declared in a ${'controller/handler'}` });
      for (const m of src.matchAll(/\(\s*\w+\s*:\s*\{\s*\w+\??\s*:/g)) out.push({ index: m.index, message: 'inline object type in a parameter' });
      return out.slice(0, 4);
    }
  },
  {
    id: 'inline-query-generic',
    level: 'warn',
    fix: 'Use a row type: CountRow / IdRow / <Table>Row from types/db.types.ts (or a Pick of one).',
    applies: () => true,
    check(src) {
      const out = [];
      for (const m of src.matchAll(/\.query<\s*(Array<\s*)?\{/g)) out.push({ index: m.index, message: 'inline type as query generic' });
      return out.slice(0, 3);
    }
  },
  {
    id: 'any-in-repository',
    level: 'warn',
    fix: 'Type every query with a row type.',
    applies: (kind) => kind === 'repository',
    check(src) {
      const out = [];
      for (const m of src.matchAll(/(:\s*any\b|<any>|\bas any\b|any\[\])/g)) out.push({ index: m.index, message: '`any` in a repository' });
      return out.slice(0, 3);
    }
  },
  {
    id: 'select-star',
    level: 'warn',
    fix: 'List the columns in a constant (dates with ::text).',
    applies: (kind) => ['repository', 'queries'].includes(kind),
    check(src) {
      const out = [];
      for (const m of src.matchAll(/SELECT\s+\*/gi)) out.push({ index: m.index, message: 'SELECT *' });
      return out.slice(0, 3);
    }
  },
  {
    id: 'write-without-owner',
    level: 'warn',
    fix: 'Put the owner in the write itself (WHERE id = $1 AND user_id = $2) so a check-then-write cannot race.',
    applies: (kind) => ['repository', 'queries'].includes(kind),
    check(src) {
      if (!/\buser_id\b/.test(src)) return [];
      const out = [];
      for (const m of src.matchAll(/(UPDATE\s+\w+\s+SET[\s\S]{0,400}?|DELETE\s+FROM\s+\w+\s+)WHERE\s+id\s*=\s*\$\d+(?![\s\S]{0,40}user_id)/gi)) {
        out.push({ index: m.index, message: 'UPDATE/DELETE by id only on a table that has user_id' });
      }
      return out.slice(0, 3);
    }
  },
  {
    id: 'limit-checked-in-js',
    level: 'warn',
    fix: 'Put the limit in the write (WHERE use_count < max_uses RETURNING) or take lockKey() inside withTransaction.',
    applies: (kind) => ['controller', 'repository', 'service'].includes(kind),
    check(src) {
      const out = [];
      for (const m of src.matchAll(/(\.length|count|use_count|uses|total)\w*\s*(>=|>|<)\s*\w*(max|limit|MAX|LIMIT)\w*/g)) {
        const after = src.slice(m.index, m.index + 1500);
        if (/INSERT|UPDATE|insert\w*\(|create\w*\(|increment\w*\(/.test(after) && !/lockKey|pg_advisory_xact_lock|FOR UPDATE/.test(src)) {
          out.push({ index: m.index, message: 'limit checked in code before a separate write' });
        }
      }
      return out.slice(0, 2);
    }
  },
  {
    id: 'ownership-in-validator',
    level: 'warn',
    fix: 'Validators check shape; ownership goes in the controller and in the write (AND user_id = $n).',
    applies: (kind) => kind === 'validator',
    check(src) {
      const out = [];
      for (const m of src.matchAll(/asyncRefine\s*\(/g)) {
        const body = callText(src, m.index + 'asyncRefine'.length);
        if (/user_?[iI]d|owner/.test(body)) out.push({ index: m.index, message: 'ownership checked inside a validator' });
      }
      return out.slice(0, 2);
    }
  },
  {
    id: 'cron-without-lock',
    level: 'warn',
    fix: 'Wrap the task in runExclusive(name, fn) (skill katax-ecosystem: assets/templates/shared/job-lock.utils.ts) so two instances never run it at once.',
    applies: () => true,
    check(src) {
      if (!/katax\.cron\(/.test(src) || /runExclusive|pg_try_advisory_lock/.test(src)) return [];
      return [...src.matchAll(/katax\.cron\(/g)].map((m) => ({ index: m.index, message: 'cron job without a lock' })).slice(0, 2);
    }
  },
  {
    id: 'timing-unsafe-compare',
    level: 'warn',
    fix: 'Compare secrets with safeTokenEquals() (crypto.timingSafeEqual).',
    applies: (kind) => ['middleware', 'controller', 'service', 'other'].includes(kind),
    check(src) {
      const out = [];
      for (const m of src.matchAll(/(===|!==)\s*(process\.env\.\w*(KEY|TOKEN|SECRET)\w*|\w*(apiKey|ApiKey|secret|Secret|expectedToken|socketToken)\b)/g)) {
        out.push({ index: m.index, message: 'secret compared with ===' });
      }
      return out.slice(0, 2);
    }
  },
  {
    id: 'weak-bcrypt-cost',
    level: 'warn',
    fix: 'Use a bcrypt cost of at least 12.',
    applies: () => true,
    check(src) {
      const out = [];
      for (const m of src.matchAll(/\b(SALT_ROUNDS|saltRounds|BCRYPT_ROUNDS|COST)\s*[:=]\s*(\d+)/g)) {
        if (Number(m[2]) < 12) out.push({ index: m.index, message: `bcrypt cost ${m[2]}` });
      }
      return out;
    }
  },
  {
    id: 'memory-rate-limit',
    level: 'warn',
    fix: 'Give every limiter a store: new RedisFallbackStore("<name>") (skill katax-ecosystem: assets/templates/shared/rate-limit.store.ts).',
    applies: () => true,
    check(src) {
      const out = [];
      for (const m of src.matchAll(/\brateLimit\(\s*\{/g)) {
        if (!/store\s*:/.test(callText(src, m.index + 'rateLimit'.length))) out.push({ index: m.index, message: 'rate limiter with the in-memory store' });
      }
      return out.slice(0, 3);
    }
  },
  {
    id: 'missing-describe',
    level: 'warn',
    fix: 'Add .describe() to every field: it feeds OpenAPI and the MCP tool schemas.',
    applies: (kind) => kind === 'validator',
    check(src) {
      const fields = [...src.matchAll(/^\s*\w+\s*:\s*k\./gm)].length;
      const described = (src.match(/\.describe\(/g) || []).length;
      return fields > described + 1 ? [{ index: 0, message: `${fields - described} fields without .describe()` }] : [];
    }
  }
];

// Project-level checks (full audit only).
function projectChecks(root) {
  const out = [];
  const pkg = readJson(path.join(root, 'package.json')) || {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const add = (rule, level, file, message, fix) => out.push({ rule, level, file, line: 1, message, fix });
  if (deps['express-session'] || deps['connect-redis']) {
    add('express-session', 'warn', 'package.json', 'express-session / connect-redis installed', 'Sessions live in Postgres (refresh-token table), not in express-session.');
  }
  if (fs.existsSync(path.join(root, 'src', 'openapi.json'))) {
    add('static-openapi', 'warn', 'src/openapi.json', 'static OpenAPI file', 'Build OpenAPI 3.1 at runtime from docs() + toJsonSchema().');
  }
  const core = deps['katax-core'];
  if (core && /^\^?1\.(?:[0-5]\.|6\.[0-5]\b)/.test(core)) {
    add('katax-core-version', 'warn', 'package.json', `katax-core ${core}`, 'Use ^1.6.6: older versions mark .nullish() fields as required in toJsonSchema().');
  }
  const index = path.join(root, 'src', 'index.ts');
  if (fs.existsSync(index)) {
    const firstImport = fs.readFileSync(index, 'utf8').split('\n').find((l) => /^\s*import\s/.test(l)) || '';
    if (!/dotenv\/config/.test(firstImport)) {
      add('dotenv-first', 'warn', 'src/index.ts', "first import is not 'dotenv/config'", "Make `import 'dotenv/config';` the first line so LOG_LEVEL and every module see .env.");
    }
  }
  const example = path.join(root, '.env.example');
  if (fs.existsSync(example)) {
    for (const line of fs.readFileSync(example, 'utf8').split('\n')) {
      const m = /^\s*(\w*(SECRET|PASSWORD|TOKEN|API_KEY)\w*)\s*=\s*(.+)$/.exec(line);
      if (m && m[3].trim().length >= 16 && !/change|your|example|placeholder|xxx|<|\$\{/i.test(m[3])) {
        add('real-secret-in-example', 'error', '.env.example', `${m[1]} looks like a real value`, 'Use placeholders in .env.example; real values only in .env (git-ignored).');
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- audit

export function auditFile(file, root) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const kind = kindOf(rel);
  const lines = src.split('\n');
  const code = stripComments(src);
  const fileIgnores = new Set([...src.matchAll(/katax-audit-ignore-file\s+([\w-]+)/g)].map((m) => m[1]));
  const findings = [];
  for (const rule of RULES) {
    if (!rule.applies(kind, rel)) continue;
    for (const hit of rule.check(code)) {
      const line = lineOf(code, hit.index);
      if (ignored(lines, line, rule.id, fileIgnores)) continue;
      findings.push({ rule: rule.id, level: rule.level, file: rel, line, message: hit.message, fix: rule.fix });
    }
  }
  return findings;
}

export function auditProject(root) {
  const src = path.join(root, 'src');
  const files = fs.existsSync(src) ? walk(src) : [];
  return [...projectChecks(root), ...files.flatMap((f) => auditFile(f, root))];
}

function format(findings) {
  return findings.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.message}\n    -> ${f.fix}`).join('\n');
}

// ---------------------------------------------------------------- hooks

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function hookPost() {
  const input = readStdin();
  const file = input.tool_input?.file_path || input.tool_input?.path;
  if (!file || !/\.ts$/.test(file) || /\.(test|spec)\.ts$|\.d\.ts$/.test(file) || !fs.existsSync(file)) return 0;
  const root = findKataxRoot(file);
  if (!root) return 0;
  const findings = auditFile(file, root);
  const errors = findings.filter((f) => f.level === 'error');
  const warns = findings.filter((f) => f.level === 'warn');
  if (errors.length) {
    process.stderr.write(
      `katax-audit: ${errors.length} problem(s) against the katax standard in the file you just wrote. Fix them now:\n${format(errors)}` +
        (warns.length ? `\n\nAlso review:\n${format(warns)}` : '') +
        `\n\nIf one is a deliberate, documented exception, add "// katax-audit-ignore <rule>: <reason>" on that line.\n`
    );
    return 2;
  }
  if (warns.length) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: `katax-audit warnings for ${path.relative(root, file)} (review, fix or justify):\n${format(warns)}`
        }
      })
    );
  }
  return 0;
}

function changedTsFiles(root) {
  try {
    const opts = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    const tracked = execSync('git diff --name-only HEAD --', opts);
    const untracked = execSync('git ls-files --others --exclude-standard', opts);
    const top = execSync('git rev-parse --show-toplevel', opts).trim();
    return [...new Set(`${tracked}\n${untracked}`.split('\n').filter(Boolean))]
      .map((f) => path.join(top, f))
      .filter((f) => f.startsWith(root) && /\.ts$/.test(f) && !/\.(test|spec)\.ts$|\.d\.ts$/.test(f) && fs.existsSync(f));
  } catch {
    return [];
  }
}

function hookStop() {
  const input = readStdin();
  // Second pass after we already blocked once: let Claude finish (it was told what is wrong).
  if (input.stop_hook_active) return 0;
  const root = findKataxRoot(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!root) return 0;
  const files = changedTsFiles(root);
  if (!files.length) return 0;

  const problems = [];
  const errors = files.flatMap((f) => auditFile(f, root)).filter((f) => f.level === 'error');
  if (errors.length) problems.push(`Standard violations in changed files:\n${format(errors)}`);

  if (fs.existsSync(path.join(root, 'tsconfig.json')) && fs.existsSync(path.join(root, 'node_modules', 'typescript'))) {
    const tsc = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsc', '--noEmit'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 180_000,
      shell: process.platform === 'win32'
    });
    if (tsc.status !== 0) problems.push(`npx tsc --noEmit failed:\n${(tsc.stdout || tsc.stderr || '').split('\n').slice(0, 30).join('\n')}`);
  }

  if (!problems.length) return 0;
  process.stderr.write(`katax-audit (before finishing):\n\n${problems.join('\n\n')}\n\nFix these before reporting the task as done.\n`);
  return 2;
}

// ---------------------------------------------------------------- cli

function main(argv) {
  const hook = argv.indexOf('--hook');
  if (hook !== -1) return argv[hook + 1] === 'stop' ? hookStop() : hookPost();

  const target = path.resolve(argv.find((a) => !a.startsWith('--')) || '.');
  const root = findKataxRoot(target);
  if (!root) {
    console.error(`katax-audit: no katax project (package.json with katax-core or katax-service-manager) at or above ${target}`);
    return 1;
  }
  let findings = fs.statSync(target).isDirectory() ? auditProject(root) : auditFile(target, root);
  if (argv.includes('--errors-only')) findings = findings.filter((f) => f.level === 'error');

  if (argv.includes('--json')) {
    console.log(JSON.stringify(findings, null, 2));
  } else {
    const byRule = {};
    for (const f of findings) byRule[f.rule] = (byRule[f.rule] || 0) + 1;
    const errors = findings.filter((f) => f.level === 'error');
    const warns = findings.filter((f) => f.level === 'warn');
    console.log(`katax-audit ${path.basename(root)}: ${errors.length} error(s), ${warns.length} warning(s)\n`);
    if (errors.length) console.log(`ERRORS\n${format(errors)}\n`);
    if (warns.length) console.log(`WARNINGS\n${format(warns)}\n`);
    console.log('By rule: ' + Object.entries(byRule).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}=${n}`).join(', '));
  }
  return findings.some((f) => f.level === 'error') ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
