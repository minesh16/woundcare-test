#!/usr/bin/env node
/**
 * Production web build: Expo static export + Starlight docs copied to dist/docs.
 * Docs are NOT a second Vercel project. Root vercel.json stays the single config.
 */
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const docsSite = join(root, 'docs-site');
const docsDist = join(docsSite, 'dist');
const nested = join(root, 'dist', 'docs');

function run(cmd, cwd) {
  console.log(`\n$ ${cmd}\n`);
  execSync(cmd, { cwd, stdio: 'inherit', env: process.env });
}

if (!existsSync(join(docsSite, 'package.json'))) {
  throw new Error('docs-site/package.json missing — cannot attach /docs to this build.');
}

run('npm ci', docsSite);
run('npm run build', docsSite);
run('npx expo export -p web', root);

if (!existsSync(docsDist)) {
  throw new Error('docs-site/dist missing after astro build.');
}

if (existsSync(nested)) rmSync(nested, { recursive: true });
mkdirSync(nested, { recursive: true });
cpSync(docsDist, nested, { recursive: true });
console.log('Copied docs-site/dist → dist/docs (served at /docs).');
