/**
 * Turn SUPABASE_DB_URL into PG* environment assignments for psql.
 *
 * We deliberately do NOT hand the URL to psql directly: Supabase passwords
 * routinely contain `%`, `*` and other characters that are invalid in a URI
 * unless percent-encoded, and psql rejects the whole string ("invalid
 * percent-encoded token"). Rather than making the user encode their password —
 * and risk double-encoding a literal `%` — we split the string ourselves and
 * pass the password through PGPASSWORD verbatim.
 *
 * Prints shell `export` lines. The password is written to stdout by necessity,
 * so callers must eval it, never log it.
 */
const raw = process.env.SUPABASE_DB_URL;
if (!raw) {
  console.error('SUPABASE_DB_URL is not set.');
  process.exit(1);
}

const withoutScheme = raw.replace(/^postgres(?:ql)?:\/\//, '');
// The password may contain '@', so split at the LAST '@' — everything after it
// is the host part, everything before it is the credentials.
const at = withoutScheme.lastIndexOf('@');
if (at === -1) {
  console.error('SUPABASE_DB_URL does not look like a connection URI (no "@").');
  process.exit(1);
}

const credentials = withoutScheme.slice(0, at);
const hostPart = withoutScheme.slice(at + 1);

// The user cannot contain ':', so split at the FIRST one.
const colon = credentials.indexOf(':');
const user = colon === -1 ? credentials : credentials.slice(0, colon);
const password = colon === -1 ? '' : credentials.slice(colon + 1);

const [hostPort, pathAndQuery = ''] = [hostPart.split('/')[0], hostPart.split('/').slice(1).join('/')];
const [host, port = '5432'] = hostPort.split(':');
const database = (pathAndQuery.split('?')[0] || 'postgres');

const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;

console.log(`export PGHOST=${quote(host)}`);
console.log(`export PGPORT=${quote(port)}`);
console.log(`export PGUSER=${quote(decodeURIComponent(user))}`);
console.log(`export PGPASSWORD=${quote(password)}`);
console.log(`export PGDATABASE=${quote(database)}`);
console.log(`export PGSSLMODE='require'`);
