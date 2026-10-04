/**
 * Fetch the Medetec Wound Database (https://www.medetec.co.uk/files/medetec-image-databases.html)
 * into $EVAL_DATA_DIR/medetec/: images/<category>/<file>.jpg plus metadata.csv (category, caption).
 *
 * Why a fetcher and not a download: Medetec publishes its "free stock images" as per-category HTML
 * pages, not an archive. No form, login or request is involved (spec §2.7); robots.txt (brotli-encoded)
 * reads "User-agent: * / Disallow:". Polite: 1 request/s, an honest User-Agent, resumable (existing
 * files are skipped), index pages only plus the full-size image each thumbnail names.
 *
 *   npx tsx eval/datasets/medetec/fetch.mts
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const BASE = 'https://www.medetec.co.uk/slide%20scans';
const CATEGORIES = [
  'abdominal-wounds',
  'burns',
  'epidermolysis-bullosa',
  'extravasation-wound-images',
  'foot-ulcers',
  'haemangioma',
  'leg-ulcer-images',
  'leg-ulcer-images-2',
  'malignant-wound-images',
  'meningitis',
  'miscellaneous',
  'orthopaedic%20wounds',
  'pilonidal-sinus',
  'pressure-ulcer-images-a',
  'pressure-ulcer-images-b',
  'toes',
];
// Short and honest. (The longer descriptive UA we tried first is answered with HTTP 465 by the host's filter.)
const UA = 'MendWise-eval/1.0';
const root = resolve((process.env.EVAL_DATA_DIR || join(homedir(), 'MendWiseEval/data')).replace(/^~/, homedir()), 'medetec');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    await sleep(1000);
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.ok || attempt >= 3 || res.status < 500) return res;
    await sleep(5000 * attempt);
  }
}

const unescape = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

const rows: string[][] = [['file', 'category', 'caption', 'source_url']];
let fetched = 0;
let skipped = 0;
for (const cat of CATEGORIES) {
  const res = await get(`${BASE}/${cat}/index.html`);
  if (!res.ok) {
    console.warn(`  ${cat}: index HTTP ${res.status} — skipped`);
    continue;
  }
  const html = await res.text();
  const thumbs = [...html.matchAll(/<img[^>]*src="thumbnails\/([^"]+)"[^>]*>/gi)].map((m) => {
    const title = m[0].match(/title="([^"]*)"/i)?.[1] ?? '';
    return { file: m[1], caption: unescape(title) };
  });
  const catName = decodeURIComponent(cat);
  const dir = join(root, 'images', catName);
  mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const t of thumbs) {
    if (/intro/i.test(t.file)) continue; // the category's title slide, not a wound
    const dest = join(dir, t.file);
    const url = `${BASE}/${cat}/images/${encodeURIComponent(t.file)}`;
    if (!existsSync(dest)) {
      const img = await get(url);
      if (!img.ok || !/image\//.test(img.headers.get('content-type') ?? '')) {
        console.warn(`  ${catName}/${t.file}: HTTP ${img.status} — skipped`);
        continue;
      }
      writeFileSync(dest, Buffer.from(await img.arrayBuffer()));
      fetched += 1;
    } else skipped += 1;
    rows.push([`images/${catName}/${t.file}`, catName, t.caption, url]);
    n += 1;
  }
  console.log(`  ${catName}: ${n} image(s)`);
}
mkdirSync(root, { recursive: true });
writeFileSync(join(root, 'metadata.csv'), rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n');
writeFileSync(join(root, 'SOURCE.txt'), `Fetched ${new Date().toISOString()} from ${BASE} by eval/datasets/medetec/fetch.mts\n`);
console.log(`medetec: ${rows.length - 1} image(s) listed (${fetched} downloaded, ${skipped} already present) → ${root}`);
