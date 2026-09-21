/**
 * Guards against an import that builds clean, typechecks clean, works in the
 * app — and throws at module load in the deployed Vercel function.
 * Run: npm run test:imports
 *
 * Vercel's function bundler does not read tsconfig `paths`, so any `src/`
 * module reachable from `api/` must use RELATIVE imports. Metro (the Expo
 * bundler) resolves `@/` happily, so nothing local catches this: it typechecks,
 * the app runs, the unit tests pass, and the endpoint 500s in production. It
 * cost one bad prod deploy to find, which is exactly the kind of thing worth a
 * cheap permanent check.
 *
 * `import type` is fine — TypeScript erases it before the bundler sees it.
 * Only value imports matter.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error('FAIL', name, detail !== undefined ? JSON.stringify(detail, null, 2) : '');
  }
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

/** Value imports only — `import type ...` is erased before bundling. */
function valueImports(source: string): string[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const specifiers: string[] = [];
  const re = /import\s+(type\s+)?([\s\S]*?)from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(withoutComments)) !== null) {
    const isTypeOnly = Boolean(match[1]);
    if (isTypeOnly) continue;
    specifiers.push(match[3]);
  }
  return specifiers;
}

function resolveLocal(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    try {
      if (statSync(candidate).isFile()) {
        // Normalise to a cwd-relative path: filesUnder() yields relative paths,
        // and mixing the two silently breaks both the visited-set and the
        // src/ counter that proves this scan is not vacuous.
        return relative(process.cwd(), candidate);
      }
    } catch {
      /* not this one */
    }
  }
  return null;
}

// Walk out from every api/ entry point and collect the src/ modules it pulls in.
const reachable = new Set<string>();
const offences: { file: string; specifier: string; reachedFrom: string }[] = [];

function walk(file: string, origin: string): void {
  if (reachable.has(file)) return;
  reachable.add(file);

  const source = readFileSync(file, 'utf8');
  for (const specifier of valueImports(source)) {
    if (specifier.startsWith('@/')) {
      offences.push({ file, specifier, reachedFrom: origin });
      continue;
    }
    const next = resolveLocal(file, specifier);
    if (next) walk(next, origin);
  }
}

for (const entry of filesUnder('api')) walk(entry, entry);

check(
  'no src/ module reachable from api/ uses a @/ path alias in a value import',
  offences.length === 0,
  offences,
);

const srcReached = [...reachable].filter((f) => f.startsWith('src/'));
check('the scan actually traversed into src/ (guard is not vacuous)', srcReached.length > 0, srcReached.length);

console.log(`\nScanned ${reachable.size} modules reachable from api/ (${srcReached.length} under src/).`);
console.log(`${passed} passed, ${failed} failed (of ${passed + failed}).`);
if (failed > 0) {
  console.error('\nVercel does not resolve tsconfig "paths" in functions. Use a relative import.');
  process.exit(1);
}
console.log('All import checks passed.');
