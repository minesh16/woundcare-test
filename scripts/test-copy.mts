/**
 * Terminology guard for user-facing copy.
 * Run: npm run test:copy
 *
 * Two things this protects:
 *
 *  1. The manufacturer's name does not belong on a patient's screen. The
 *     Mölnlycke protocol is the provenance of the referral logic and stays
 *     cited in the engine, its types and the docs — but the app shows the
 *     Australian Government CWCS citation, which is the regulatory labelling,
 *     and nothing else.
 *
 *  2. Clinical jargon keeps creeping back into rendered strings. The engine's
 *     own vocabulary is the clinical record and is shown in the clinician view;
 *     it should not be the default reading experience.
 *
 * This is a lint over source text, not a runtime test: it scans the screens and
 * components for banned terms inside quoted strings.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error('FAIL', name, detail !== undefined ? JSON.stringify(detail) : '');
  }
}

const SCAN_DIRS = ['src/app', 'src/components', 'src/copy'];

/** Terms that must never appear in copy the user reads. */
const BANNED: { term: RegExp; why: string }[] = [
  { term: /M[oö]lnlycke/i, why: 'manufacturer name — provenance belongs in the engine and docs, not the UI' },
  { term: /\bexudate\b/i, why: 'say "fluid from the wound"' },
  { term: /\berythema\b/i, why: 'say "redness"' },
  { term: /\bischaemi/i, why: 'say "reduced blood flow"' },
  { term: /\bosteomyelitis\b/i, why: 'say "a bone infection"' },
  { term: /\bdebridement\b/i, why: 'say "having dead tissue removed by a clinician"' },
  { term: /\bLOPS\b/, why: 'say "reduced feeling"' },
  { term: /\bmultidisciplinary\b/i, why: 'say "a specialist wound care team"' },
  { term: /\bmacerat/i, why: 'say "waterlogged skin"' },
];

/**
 * Some copy is *supposed* to use the clinical vocabulary: the clinician view
 * renders it on purpose, and a translation map has to name the term it is
 * translating. Those regions opt out with a `clinician-copy` marker comment,
 * which applies until the enclosing block closes (a line starting with `}` or
 * `)` at the same indentation as the marker's opening construct).
 *
 * The marker is deliberately explicit rather than inferred: an exemption
 * someone has to write down is one a reviewer can see.
 */
const ALLOW_MARKER = /clinician-copy/;

/** Line numbers (1-based) inside an opted-out region. */
function allowedRegions(lines: string[]): Set<number> {
  const allowed = new Set<number>();
  lines.forEach((line, index) => {
    if (!ALLOW_MARKER.test(line)) return;
    const indent = (line.match(/^\s*/) ?? [''])[0].length;
    for (let i = index + 1; i < lines.length; i += 1) {
      allowed.add(i + 1);
      const current = lines[i];
      if (current.trim() === '') continue;
      const currentIndent = (current.match(/^\s*/) ?? [''])[0].length;
      // Region ends at the first closing line back at (or left of) the marker's indent.
      if (currentIndent <= indent && /^\s*[})\];]/.test(current)) break;
    }
  });
  return allowed;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

/** Quoted string literals and JSX text, minus comments. */
function renderedText(source: string): { line: number; text: string }[] {
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const out: { line: number; text: string }[] = [];
  withoutBlockComments.split('\n').forEach((line, index) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    const withoutLineComment = line.replace(/\/\/.*$/, '');
    // Quoted strings, plus JSX text between tags.
    const quoted = withoutLineComment.match(/'[^']*'|"[^"]*"|>[^<>{}]+</g) ?? [];
    for (const match of quoted) out.push({ line: index + 1, text: match });
  });
  return out;
}

const offences: string[] = [];

for (const dir of SCAN_DIRS) {
  for (const file of sourceFiles(dir)) {
    const source = readFileSync(file, 'utf8');
    const lines = source.split('\n');
    const allowed = allowedRegions(lines);
    for (const { line, text } of renderedText(source)) {
      if (allowed.has(line)) continue;
      for (const { term, why } of BANNED) {
        if (term.test(text)) {
          offences.push(`${file}:${line} — ${text.trim()} (${why})`);
        }
      }
    }
  }
}

check('no banned clinical term appears in rendered copy', offences.length === 0, offences);

// The government guideline citation is the regulatory labelling; losing it
// would be a different kind of failure, so assert it is still there.
const resultPanel = readFileSync('src/components/ResultPanel.tsx', 'utf8');
check('the CWCS guideline citation is still shown to the user', /Australian Government wound care guide/.test(resultPanel));
check('the clinician view is still available', /Clinician view/.test(resultPanel));

// The engine keeps its provenance — this guard must not have been "fixed" by
// stripping the citation out of the clinical record.
const engine = readFileSync('src/decision/engine.ts', 'utf8');
check('the engine still cites its source guides', /M[oö]lnlycke/.test(engine));

console.log(`\n${passed} passed, ${failed} failed (of ${passed + failed}).`);
if (failed > 0) process.exit(1);
console.log('All copy checks passed.');
