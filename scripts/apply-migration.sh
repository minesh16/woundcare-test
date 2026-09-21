#!/usr/bin/env bash
# Apply the Supabase schema. Run: npm run db:migrate
#
# Reads SUPABASE_DB_URL from .env.local (gitignored) so the connection string
# never lands in shell history or a transcript. Get it from:
#   Supabase dashboard → Project Settings → Database → Connection string → URI
#
# The URL is split into PG* variables by scripts/pg-env.mjs rather than handed
# to psql as a URI, because Supabase passwords commonly contain characters that
# are invalid in an unencoded URI. The migration is idempotent, so re-running
# it is safe.
set -euo pipefail

if [ ! -f .env.local ]; then
  echo "Missing .env.local — see supabase/README.md for the variables it needs." >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a; source .env.local; set +a

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  echo "SUPABASE_DB_URL is not set in .env.local." >&2
  exit 1
fi

eval "$(node scripts/pg-env.mjs)"

echo "Connecting to ${PGHOST}:${PGPORT}/${PGDATABASE} as ${PGUSER}…"
echo "Applying supabase/migrations/0001_assessments.sql…"
psql -v ON_ERROR_STOP=1 -f supabase/migrations/0001_assessments.sql
echo
echo "Tables now present:"
psql -c "\dt public.*"
echo
echo "Confirming audit_log cannot be updated or deleted by anon/authenticated:"
psql -c "select grantee, privilege_type from information_schema.role_table_grants where table_name = 'audit_log' and grantee in ('anon','authenticated') order by grantee, privilege_type;"
