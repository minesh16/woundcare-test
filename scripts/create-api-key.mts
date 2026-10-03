/**
 * Mint a module-API key (segmentation spec §6A.2). Prints the key ONCE; only
 * its SHA-256 is stored.
 *
 *   npm run api:key -- --org=acme-health --name="Acme sandbox" --scopes=segment,approve,measure
 *   npm run api:key -- --org=acme-health --name="Acme" --scopes='*' --limit=120
 *
 * Production keys (`--env=production`) can be minted but are refused by every
 * endpoint until ARTG inclusion.
 */
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

import { generateKey, hashKey, keyPrefix, SCOPES } from '../api/_apiCore.ts';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.join('=')];
  }),
);

const org = args.org;
const name = args.name ?? `${org} key`;
const environment = args.env === 'production' ? 'production' : 'sandbox';
const scopes = (args.scopes ?? '*').split(',').map((s) => s.trim()).filter(Boolean);
const limit = Number(args.limit ?? 60);

if (!org) {
  console.error('Usage: npm run api:key -- --org=<org-id> [--name=..] [--scopes=a,b|*] [--limit=60] [--env=sandbox|production]');
  process.exit(1);
}
const unknown = scopes.filter((s) => s !== '*' && !(SCOPES as readonly string[]).includes(s));
if (unknown.length) {
  console.error(`Unknown scope(s): ${unknown.join(', ')}. Known: ${SCOPES.join(', ')}, *`);
  process.exit(1);
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (e.g. set -a; . ./.env.local; set +a).');
  process.exit(1);
}

const key = generateKey(environment, randomBytes(32));
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { error } = await db.from('api_keys').insert({
  org_id: org,
  name,
  key_prefix: keyPrefix(key),
  key_hash: hashKey(key),
  scopes,
  environment,
  rate_limit_per_min: limit,
});
if (error) {
  console.error('Could not store the key:', error.message);
  process.exit(1);
}
console.log(`Created ${environment} key for ${org} (${scopes.join(', ')}, ${limit}/min):\n\n  ${key}\n\nShown once — store it now.`);
