# Supabase — MendWise V2

Apply `migrations/0001_assessments.sql` to the project, then set these in Vercel
(Production and Preview), **server-side only**:

```
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service role key>
```

Do **not** prefix these with `EXPO_PUBLIC_`. Expo inlines every `EXPO_PUBLIC_*`
value into the client bundle at build time — including the web bundle — so a
service-role key there would be public. The client only ever talks to
`/api/v1/*`; only the Vercel functions talk to Supabase.

With these unset the app still works end to end: `api/v1/assessments/_store.ts`
degrades to no-ops and the audit record goes to stdout, which Vercel retains. A
database outage cannot block a clinical result.

## Data posture

De-identified by construction — there is no column here for a name, date of
birth or record number, and none should be added. `wound_id` groups one wound
across visits and is generated on the client.

Consented or public images only until La Trobe ethics clearance is in place.
