#!/usr/bin/env node
/**
 * After a git commit (Cursor afterShellExecution, or CLI), refresh mapped
 * docs-site pages. Never writes outside docs-site/. Never commits or pushes.
 *
 * Usage: node .cursor/hooks/docs-check.mjs
 * Cursor pipes JSON on stdin; CLI mode uses HEAD directly.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  appendFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HOOKS_DIR, '..', '..');
const DOCS_SITE = join(ROOT, 'docs-site');
const MAP_PATH = join(HOOKS_DIR, 'doc-map.json');
const LOG_PATH = join(HOOKS_DIR, 'doc-update.log');
const SECRET_RE =
  /(\.env(?:\.|$)|\.pem$|credentials\.json$|service_role|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY)/i;
const SECRET_VALUE_RE =
  /(?:sk-|rk_live_|eyJ[A-Za-z0-9_-]{20,}|supabase\.co\/storage\/v1\/object\/sign)/;

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function matchGlob(file, glob) {
  const normalised = file.replaceAll('\\', '/');
  const g = glob.replaceAll('\\', '/');
  if (g.endsWith('/**')) {
    const prefix = g.slice(0, -3);
    return normalised === prefix || normalised.startsWith(`${prefix}/`);
  }
  return normalised === g;
}

function isInsideDocsSite(absPath) {
  const rel = relative(DOCS_SITE, absPath);
  return rel !== '' && !rel.startsWith(`..${sep}`) && !rel.startsWith('..');
}

function log(line) {
  mkdirSync(HOOKS_DIR, { recursive: true });
  appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
}

function replaceRegion(content, id, inner) {
  const start = `<!-- docs-hook:auto:start:${id} -->`;
  const end = `<!-- docs-hook:auto:end:${id} -->`;
  const i = content.indexOf(start);
  const j = content.indexOf(end);
  if (i === -1 || j === -1 || j < i) return { content, patched: false };
  const next = `${content.slice(0, i + start.length)}\n${inner.trim()}\n${content.slice(j)}`;
  return { content: next, patched: true };
}

function stamp(content, sha, date) {
  const marker = `<!-- docs-hook: last auto-checked against commit ${sha} on ${date} -->`;
  const stripped = content.replace(/\n?<!-- docs-hook: last auto-checked against commit [^>]+ -->\s*$/, '');
  return `${stripped.trimEnd()}\n\n${marker}\n`;
}

function looksLikeSecret(text) {
  return SECRET_VALUE_RE.test(text);
}

function engineFacts() {
  const src = readFileSync(join(ROOT, 'src/decision/engine.ts'), 'utf8');
  const version = src.match(/CWCS_RULES_VERSION = '([^']+)'/)?.[1] ?? '(unparsed)';
  const threshold = src.match(/TISSUE_PRESENCE_THRESHOLD = (\d+)/)?.[1] ?? '(unparsed)';
  const ids = [...src.matchAll(/\{ id: (\d+),/g)].map((m) => Number(m[1]));
  const unique = new Set(ids);
  return [
    '| Constant | Value |',
    '|---|---|',
    `| \`CWCS_RULES_VERSION\` | \`${version}\` |`,
    `| \`TISSUE_PRESENCE_THRESHOLD\` | \`${threshold}\` (% of wound bed) |`,
    `| Pathways | ${unique.size} (ids ${Math.min(...unique)}–${Math.max(...unique)}) |`,
    '| Offline engine tests | `npm run test:rules` — re-run; do not trust a stale count |',
  ].join('\n');
}

function packageVersions() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const pick = [
    'expo',
    'react',
    'react-dom',
    'react-native',
    'ai',
    'zod',
    'zustand',
    '@supabase/supabase-js',
    'react-native-fast-opencv',
    'opencv-js-wasm',
    'typescript',
  ];
  const rows = pick
    .map((name) => {
      const v = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
      return v ? `| \`${name}\` | \`${v}\` |` : null;
    })
    .filter(Boolean);
  return [
    'Versions below are from the app `package.json` / `app.json` at last docs check.',
    '',
    '| Package | Version in repo |',
    '|---|---|',
    ...rows,
  ].join('\n');
}

function appJsonFacts() {
  const expo = JSON.parse(readFileSync(join(ROOT, 'app.json'), 'utf8')).expo;
  return [
    'From [`app.json`](https://github.com/minesh16/woundcare-test/blob/main/app.json):',
    '',
    '| Field | Value |',
    '|---|---|',
    `| Expo name | ${expo.name} |`,
    `| slug | \`${expo.slug}\` |`,
    `| version | \`${expo.version}\` |`,
    `| iOS bundle id | \`${expo.ios?.bundleIdentifier ?? ''}\` |`,
    `| Android package | \`${expo.android?.package ?? ''}\` |`,
    `| Orientation | ${expo.orientation} |`,
    `| Web output | \`${expo.web?.output ?? ''}\` |`,
    `| Scheme | \`${expo.scheme}\` |`,
  ].join('\n');
}

function mergeFileTable(existingInner, dirRel) {
  const abs = join(ROOT, dirRel);
  if (!existsSync(abs)) return existingInner;
  const files = readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();
  const roles = new Map();
  for (const line of existingInner.split('\n')) {
    const m = line.match(/^\| `([^`]+)` \| (.+) \|$/);
    if (m) roles.set(m[1], m[2].trim());
  }
  const header = existingInner.split('\n').filter((l) => l.startsWith('| File') || l.startsWith('|---'));
  const preamble = header.length ? header : ['| File | Role |', '|---|---|'];
  const rows = files.map((f) => `| \`${f}\` | ${roles.get(f) ?? '_new file — describe this row_'} |`);
  return [...preamble, ...rows].join('\n');
}

function handoffNext() {
  const md = readFileSync(join(ROOT, 'docs/HANDOFF.md'), 'utf8');
  const start = md.indexOf('## NEXT');
  if (start === -1) return null;
  const rest = md.slice(start);
  const end = rest.search(/\n## [^N]/);
  const section = (end === -1 ? rest : rest.slice(0, end)).trim();
  return section
    .split('\n')
    .filter((l) => l && !l.startsWith('## ') && !l.startsWith('>'))
    .join('\n');
}

function patchPage(pageRel, sha, date, changedFiles) {
  const abs = join(ROOT, pageRel);
  if (!existsSync(abs)) return { skipped: `missing page ${pageRel}` };
  if (!isInsideDocsSite(abs)) return { skipped: `refused path outside docs-site: ${pageRel}` };
  let content = readFileSync(abs, 'utf8');
  const regions = [...content.matchAll(/<!-- docs-hook:auto:start:([a-z0-9-]+) -->/g)].map((m) => m[1]);
  const patched = [];
  const skippedRegions = [];

  for (const id of regions) {
    let inner = null;
    try {
      if (id === 'facts') inner = engineFacts();
      else if (id === 'versions') inner = packageVersions();
      else if (id === 'app') inner = appJsonFacts();
      else if (id === 'files') {
        const current = content.slice(
          content.indexOf(`<!-- docs-hook:auto:start:${id} -->`) + `<!-- docs-hook:auto:start:${id} -->`.length,
          content.indexOf(`<!-- docs-hook:auto:end:${id} -->`),
        );
        const dirGuess =
          pageRel.includes('/cv.md')
            ? 'src/cv'
            : pageRel.includes('/decision.md')
              ? 'src/decision'
              : pageRel.includes('/assessment.md')
                ? 'src/assessment'
                : pageRel.includes('/copy.md')
                  ? 'src/copy'
                  : pageRel.includes('/screens.md')
                    ? 'src/app'
                    : pageRel.includes('/supabase.md')
                      ? 'supabase'
                      : pageRel.includes('/api-v1.md')
                        ? 'api/v1/assessments'
                        : pageRel.includes('/api.md')
                          ? 'api'
                          : null;
        inner = dirGuess ? mergeFileTable(current, dirGuess) : null;
      } else if (id === 'next') inner = handoffNext();
      else skippedRegions.push(`${id} (no extractor)`);
    } catch (error) {
      skippedRegions.push(`${id} (${error instanceof Error ? error.message : 'extract failed'})`);
    }
    if (inner == null) continue;
    if (looksLikeSecret(inner)) {
      skippedRegions.push(`${id} (refused: looks like a secret)`);
      continue;
    }
    const result = replaceRegion(content, id, inner);
    content = result.content;
    if (result.patched) patched.push(id);
  }

  content = stamp(content, sha, date);
  writeFileSync(abs, content);
  return { patched, skippedRegions, changedFiles };
}

function mappedPages(changedFiles, mappings) {
  const pages = new Set();
  const hits = [];
  const skipped = [];
  for (const file of changedFiles) {
    if (SECRET_RE.test(file) || file.startsWith('.env')) {
      skipped.push({ file, reason: 'secret/env path ignored' });
      continue;
    }
    let matched = false;
    for (const mapping of mappings) {
      if (matchGlob(file, mapping.glob)) {
        matched = true;
        for (const page of mapping.pages) pages.add(page);
      }
    }
    if (!matched) skipped.push({ file, reason: 'no doc-map glob' });
    else hits.push(file);
  }
  return { pages: [...pages], hits, skipped };
}

function respond(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const raw = readStdin();
let hookInput = null;
if (raw.trim().startsWith('{')) {
  try {
    hookInput = JSON.parse(raw);
  } catch {
    hookInput = null;
  }
}

if (hookInput?.command) {
  const cmd = String(hookInput.command);
  if (!/\bgit\s+commit\b/.test(cmd) || /--help|--dry-run/.test(cmd)) {
    respond({});
    process.exit(0);
  }
  const out = String(hookInput.output ?? '');
  if (/nothing to commit|fatal:/.test(out) && !/\[(?:main|master|[\w./-]+)\s+[0-9a-f]/.test(out)) {
    respond({ user_message: 'Docs hook skipped: git commit did not produce a new revision.' });
    process.exit(0);
  }
}

if (!existsSync(DOCS_SITE)) {
  log('no-op: docs-site/ missing');
  respond({ user_message: 'Docs hook: docs-site/ is not present yet — no-op.' });
  process.exit(0);
}

let sha = 'unknown';
let files = [];
try {
  sha = git(['rev-parse', '--short', 'HEAD']);
  files = git(['show', '--name-only', '--pretty=format:', 'HEAD'])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
} catch (error) {
  log(`fail-open: ${error instanceof Error ? error.message : error}`);
  respond({ user_message: 'Docs hook: git show failed; commit was not blocked.' });
  process.exit(0);
}

const map = JSON.parse(readFileSync(MAP_PATH, 'utf8'));
const { pages, hits, skipped } = mappedPages(files, map.mappings);
const date = new Date().toISOString().slice(0, 10);
const touched = [];
const pageSkips = [];

for (const page of pages) {
  try {
    const result = patchPage(page, sha, date, hits);
    if (result.skipped) pageSkips.push(result.skipped);
    else touched.push({ page, regions: result.patched, regionSkips: result.skippedRegions });
  } catch (error) {
    pageSkips.push(`${page}: ${error instanceof Error ? error.message : error}`);
  }
}

log(
  JSON.stringify({
    sha,
    files,
    hits,
    skipped,
    touched,
    pageSkips,
  }),
);

if (pages.length === 0) {
  respond({
    user_message: `Docs hook: commit ${sha} had no mapped source files (${files.length} path(s) in the commit). docs-site unchanged.`,
  });
  process.exit(0);
}

const summary = touched
  .map((t) => {
    const rel = t.page.replace(/^docs-site\/src\/content\/docs\//, '');
    const regs = t.regions?.length ? ` auto-regions: ${t.regions.join(', ')}` : ' stamp only';
    return `${rel}${regs}`;
  })
  .join('; ');

respond({
  user_message: `Docs hook updated uncommitted docs for ${sha}: ${summary || 'none'}. Review the working tree — nothing was auto-committed.${pageSkips.length ? ` Skipped: ${pageSkips.join('; ')}` : ''}`,
});
