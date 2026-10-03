# MendWise — Application Security Audit

**Scope:** full repository (`api/`, `src/`, `middleware.ts`, `supabase/`, `vercel.json`, `docs-site/`) and deployed architecture (Vercel Functions + Supabase + Vercel AI Gateway + Replicate).
**Reviewed:** 26 Sep 2026, against commit `31fec6d` (branch `main`, clean tree).
**Posture reviewed as:** pre-revenue MVP with a pitch on 13 Oct 2026, **no real patient data in the system yet** (La Trobe HREC clearance outstanding; `supabase/README.md` restricts input to consented or public images).
**Standards applied:** OWASP Top 10 (2021), OWASP ASVS L2 (target), Australian Privacy Principles (Privacy Act 1988, incl. the 2024 amendments), Notifiable Data Breaches scheme, HIPAA Security Rule §164.308/312 (contingent on any US deployment), TGA SaMD framework (contextual).

---

## 0. Executive summary

MendWise has an unusually strong **clinical-integrity** security story and an unusually weak **platform** security story. The two are independent, and they should be pitched as such.

What is genuinely well engineered, and defensible in front of a technical investor or a clinical assessor:

- **De-identification by construction.** There is no column, type field or API parameter anywhere in the system that can hold a name, DOB or record number. This is enforced in three places at once (`supabase/migrations/0001_assessments.sql`, `src/assessment/state.ts`, `supabase/README.md`) rather than by policy.
- **The AI cage is a real security control, not just a safety one.** Because the VLM is driven through `generateObject` + a Zod enum-only schema, an attacker-supplied image has **no free-text channel** into the decision path. Prompt injection via image cannot produce a dressing recommendation — the worst it can do is set an enum that the deterministic engine then reconciles under fixed rules. The report LLM is separately constrained to a whitelist of already-decided facts and its output is re-checked (`src/decision/reportCage.ts`). Most health-AI MVPs cannot say this.
- **Credential hygiene is correct and verified.** The Supabase service-role key is server-side only, the `EXPO_PUBLIC_` inlining hazard is documented and observed, and a full git-history scan found **no committed secrets**.
- **RLS is deny-by-default and the team found the `TRUNCATE` gap** that RLS does not mediate — a subtlety most teams ship past.

What is missing is the entire perimeter:

- **There is no authentication or authorisation anywhere in the product.** All eleven API routes are public. Anyone with the URL can run the pipeline, write database records, and write permanent rows into the append-only audit log.
- **There is no rate limiting of any kind**, in front of endpoints that spend real money per call on frontier models and GPU inference.
- The **audit log's integrity anchor is broken** — `hashInputs` silently hashes almost none of the inputs (proven below).

**The single most important framing for the pitch:** the clinical decision path is already designed to a standard that survives audit; the access-control layer is deliberately absent because there are no users yet. That is a defensible MVP position — *provided you say it out loud and show the plan*, rather than being asked about it.

**Non-negotiable before any real patient image touches this system:** MW-01, MW-02, MW-03, MW-04, MW-07, MW-10.

---

## 1. Current posture analysis

### 1.1 Authentication

| Surface | Mechanism today | Assessment |
|---|---|---|
| Expo app → `/api/v1/*` (7 routes) | **None.** No token, no device identity, no API key. | Fully public |
| Legacy `/api/analyze`, `/api/segment` | **None.** | Fully public |
| `GET /api/v1/assessments/health` | **None.** Returns capability + env-var-presence booleans. | Public reconnaissance surface (names only, no values — deliberate) |
| `/docs` (Starlight docs site) | HMAC-SHA256 passphrase gate. `middleware.ts` → `api/docs-unlock.ts`, HttpOnly + SameSite=Lax cookie, constant-time compare. | The only auth control in the product. Shared secret, no identity, no expiry, no lockout |
| Vercel Preview deployments | **None configured.** Preview carries `SUPABASE_*` and `DOCS_PASSPHRASE` per `docs/HANDOFF.md`. | Second production-equivalent public surface |
| Supabase | Service-role key, server-side only, `persistSession: false`. | Correct — but the key bypasses RLS entirely |

There are no user accounts, no sessions, no device registration and no Supabase Auth integration. Consent is a client-side boolean in Zustand (`src/store/sessionStore.ts`) that is never transmitted to the server and never recorded.

### 1.2 Authorization

**There is no authorization model.** No tenancy, no ownership, no roles. The only resource handle is `assessment_id`, and it is generated as:

```ts
// src/assessment/state.ts:74
return `asmt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
```

`Math.random()` is not a CSPRNG and the timestamp component is externally observable, so the id space is materially smaller than its length suggests. Today no endpoint *returns* a stored record, so this is not yet a read-IDOR — but two endpoints accept a caller-chosen id and **write** to it:

- `api/v1/assessments/evaluate.ts:32-42` — loads the stored state for any supplied `assessment_id`, layers the caller's `body.state` over it, and upserts.
- `api/v1/assessments/run.ts:47` — takes `body.state` wholesale, including `id`, and upserts plus writes an audit row.

Because `audit_log` is append-only by design, a forged audit row **cannot be removed**. The property that makes the audit trail valuable is the same property that makes poisoning it unrecoverable.

### 1.3 API rate limiting

**None.** No application limiter, no Vercel WAF rate rule, no BotID, no Upstash/Redis counter — confirmed by repository-wide grep. The exposure is not primarily availability, it is **cost and abuse**:

| Endpoint | Per-call cost driver | `maxDuration` |
|---|---|---|
| `POST /api/v1/assessments/baseline` | One unguided frontier VLM call on a caller-supplied image | 60s |
| `POST /api/v1/assessments/vlm-features` | One frontier VLM call (`generateObject`) | 60s |
| `POST /api/v1/assessments/run` | SAM 2 GPU (Replicate, billed per second) **+** VLM **+** report LLM, chained | **300s** |
| `POST /api/v1/assessments/tissue` | OpenCV WASM decode, `maxMemoryUsageInMB: 512` | 60s |
| `POST /api/analyze` | OpenCV WASM decode + Hough transform | 30s |

`/api/v1/assessments/baseline` is the sharpest edge: it is a free, unauthenticated, general-purpose frontier vision endpoint. It accepts any image and returns free-form model output. Beyond burning the gateway budget, that is an open proxy to a paid LLM that will be found by scanners.

The only limits in place are incidental: Vercel's 4.5 MB request-body cap, the 45s `GATEWAY_TIMEOUT_MS` ceiling, and per-function `maxDuration`.

### 1.4 Encryption

**In transit:** TLS throughout — Vercel edge → function, function → Supabase, function → `api.replicate.com`, function → AI Gateway. Vercel serves HSTS on `*.vercel.app` by default, but the application declares no transport policy of its own (no `headers` block in `vercel.json`), so this is inherited rather than owned. No certificate pinning in the Expo client.

**At rest — server:** Supabase platform-level AES-256 disk encryption. No column-level encryption, no `pgsodium`/Vault usage, no customer-managed keys. The `assessments.state` `jsonb` column is typed to accept the entire `AssessmentState`. In the current client flow (`src/app/compare.tsx:58-77`) no image bytes are sent in `state`, so **the database holds no imagery today** — but nothing in the contract or the handler prevents it, and `CvResult.overlayBase64` is a JPEG of the wound that would serialise straight into that column if a future client passed `state` through.

**At rest — device:** `src/store/sessionStore.ts` persists `savedReports` (up to 10 full sessions) to **AsyncStorage**, which is unencrypted on both platforms. Each saved session carries `imageUri` *and* `cv.overlayBase64` — a base64 wound photograph. There is no `expo-secure-store` usage, no purge, no TTL, and no `isExcludedFromBackup` on iOS, so wound imagery is included in unencrypted iCloud/iTunes backups.

**At rest — logs:** when Supabase is unreachable, audit records are written to stdout (`_store.ts:184`) and retained only by Vercel's log retention, which is short and is not a compliant audit store.

### 1.5 Data flow and third-party disclosure

A wound photograph leaves the device and reaches, in one request:

1. **Vercel Functions** — default region `iad1` (Washington DC). `vercel.json` declares no `regions` key, so an Australian health application processes in the United States.
2. **Replicate** (`api/_sam2.ts`) — full image as a data URL, US GPU infrastructure.
3. **Vercel AI Gateway → OpenAI / Google / Anthropic** (`_gateway.ts`) — full image, plus optional wound and periwound crops.

No zero-data-retention setting is configured on the gateway, no BAA or DPA is recorded for any of these processors, and the user is told none of this. The in-app consent text (`src/constants/disclaimers.ts`) covers *research use and non-reliance*; it says nothing about collection, disclosure, or overseas transfer.

### 1.6 Audit and logging

The audit design is the strongest part of the compliance story and is let down by one bug. Each completed assessment writes an immutable row carrying the derived axes, pathway, gate codes, referral codes, confidence, rules version, model identifiers, and per-step outcomes. `UPDATE`, `DELETE`, `TRUNCATE` and `TRIGGER` are revoked from `anon`/`authenticated`.

The intended integrity anchor is `inputs_hash` — "these inputs, under this rules version, produced this pathway". It does not work:

```ts
// api/v1/assessments/_store.ts:142
const canonical = JSON.stringify(inputs, Object.keys(inputs).sort());
```

The second argument to `JSON.stringify` in array form is a **property allowlist applied at every nesting level**, not a key sort. Executed against a realistic `EngineInputs`:

```
input:     { tissue:{necrosis:10,slough:20,granulation:70}, exudate:'high',
             infection:'yes', vlm:{periwound:'red'} }
canonical: {"exudate":"high","infection":"yes","tissue":{},"vlm":{}}
```

The tissue percentages, the VLM features, the periwound metrics and the Mölnlycke inputs are **all erased before hashing**. Separately, FNV-1a truncated to 32 bits (8 hex characters) is non-cryptographic and trivially collided. The audit trail therefore records a hash that neither covers the inputs nor resists forgery — which is precisely the claim it exists to support.

---

## 2. Gap analysis

Severity is assessed against the **production** target, with an MVP note where the current absence of patient data lowers present-day risk.

### 2.1 Critical

| ID | Finding | Evidence | Impact | OWASP / APP |
|---|---|---|---|---|
| MW-01 | No authentication or authorisation on any API route. All 11 endpoints are fully public. | `api/**/*.ts` — no handler reads an `Authorization` header | Anyone can run the pipeline, persist records, and write permanent audit rows. Blocks any clinical pilot outright. | A01, A07 / APP 11 |
| MW-02 | Record overwrite and audit-log poisoning via client-supplied `id`. | `run.ts:47`, `evaluate.ts:32-42`, `_store.ts:78` (`upsert`) | An attacker can overwrite any assessment whose id they guess, and append forged, **unremovable** audit rows. Destroys the evidentiary value of the audit trail. | A01, A08 / APP 11 |
| MW-03 | Unmetered spend: unauthenticated endpoints that invoke billed frontier models and GPU inference, with no rate limit. | `baseline.ts`, `vlm-features.ts`, `run.ts` (300s), no limiter anywhere | Financial DoS; `/baseline` is an open proxy to a paid LLM. A single script can exhaust the gateway and Replicate budgets before the pitch. | A04 / — |

### 2.2 High

| ID | Finding | Evidence | Impact | OWASP / APP |
|---|---|---|---|---|
| MW-04 | **SSRF** — the server fetches an arbitrary caller-supplied URL. | `api/v1/assessments/tissue.ts:47-57` (`loadMaskPng` → `fetch(source)`), reachable via `body.mask` | Internal/private-network probing, use of the platform as a request proxy, DNS-based exfiltration. Semi-blind (PNG decode failure is observable via `maskSource`). | A10 |
| MW-05 | Audit `inputs_hash` covers almost none of the inputs and is non-cryptographic. | `_store.ts:141-149`, demonstrated above | The regulatory asset cannot substantiate the claim it is built to make. Worst finding for a clinical-assurance reviewer. | A02, A08 / APP 11 |
| MW-06 | Assessment IDs are non-cryptographic and partly predictable. | `src/assessment/state.ts:74` (`Date.now()` + `Math.random()`) | Enables MW-02 enumeration; becomes a direct read-IDOR the moment a fetch-report endpoint is added. | A01, A02 |
| MW-07 | Wound imagery disclosed to US processors with no contractual or technical control; functions default to `iad1`. | `_sam2.ts`, `_gateway.ts`, `vercel.json` (no `regions`), no ZDR config | Cross-border disclosure of health information without APP 8 assurance; no BAA where HIPAA applies. Blocks ethics clearance. | A04 / **APP 6, APP 8** |
| MW-08 | No security response headers at all. | `vercel.json` has no `headers` block | No CSP, no declared HSTS, no `frame-ancestors`, no `X-Content-Type-Options`, no `Referrer-Policy`. The `/docs` passphrase form is framable (clickjacking). | A05 |
| MW-09 | `/docs` gate is brute-forceable and the cookie is a non-expiring bearer token. | `api/docs-unlock.ts` — no rate limit, no lockout; token is HMAC over a constant message; `Secure` is conditional on `x-forwarded-proto` | Unlimited online guessing of the passphrase. A stolen cookie grants access until the passphrase is rotated. | A07 |
| MW-10 | Wound imagery persisted unencrypted on device, with no purge. | `sessionStore.ts:77-86` — `savedReports` holds `imageUri` + `cv.overlayBase64` in AsyncStorage | Health information readable from a lost/jailbroken device and from unencrypted iOS backups. | A02 / **APP 11** |
| MW-11 | No CI security gate. | No `.github/` workflows; `opencv-js-wasm@5.0.0-alpha` parses untrusted images in production | No SCA, no secret scanning, no dependency review. An alpha WASM decoder is the parser for attacker-controlled input. | A06, A08 |

### 2.3 Medium

| ID | Finding | Evidence | Impact | OWASP / APP |
|---|---|---|---|---|
| MW-12 | No request-body validation on ingress; `zod` is a dependency but is used only on model *output*. | All handlers; `JSON.parse` uncaught in `create.ts:23`, `run.ts:32`, `evaluate.ts:25`, `segment.ts:59` | Unbounded `wound_id` (storage abuse), unbounded base64, 500s on malformed bodies. | A03, A04 |
| MW-13 | Upstream error text propagated to clients, the SSE stream, and audit rows. | `_sam2.ts:71,121` (Replicate body, 200 chars); `analyze.ts:201`, `tissue.ts` (raw `error.message`) | Internal detail and potentially signed-URL/token fragments reach clients and permanent storage. | A05, A09 |
| MW-14 | Consent is a client-side boolean; no privacy collection notice exists. | `sessionStore.ts:34`, `src/constants/disclaimers.ts` | Consent is never transmitted, recorded, timestamped or versioned — unprovable. Disclaimer ≠ collection notice. | **APP 1, 3, 5** |
| MW-15 | No retention, deletion, access or correction mechanism. | No TTL, no delete route, no subject-access path | APP 11.2 requires destruction or de-identification when no longer needed; APP 12/13 require access and correction. | **APP 11.2, 12, 13** |
| MW-16 | Preview deployments are an unprotected second production surface. | `docs/HANDOFF.md` (Preview carries `SUPABASE_*`, `DOCS_PASSPHRASE`); no Deployment Protection configured | Every PR publishes a public, credentialed, unauthenticated copy of the API. | A05 |
| MW-17 | EXIF (incl. GPS) not stripped before third-party transmission. | `src/app/capture.tsx:37-58` — no `ImageManipulator` pass; `expo-image-manipulator` is installed but unused here | Location metadata in a wound photo sent to US processors. Directly identifying. | A05 / APP 6, 8, 11 |
| MW-18 | Service-role key is the sole blast-radius control. | `_store.ts:52-57` | Full RLS bypass. Any SSRF, log leak or function compromise yields total read/write. No rotation runbook, no scoped key. | A01, A02 |
| MW-19 | No security monitoring, alerting or incident response plan. | Audit falls back to stdout; no alerting configured | Breach detection is absent. The NDB scheme requires assessment within 30 days of becoming aware — awareness is not currently possible. | A09 / **NDB scheme** |

### 2.4 Low

| ID | Finding | Evidence | Impact |
|---|---|---|---|
| MW-20 | Docs cookie has no nonce, expiry or user binding; rotating `DOCS_PASSPHRASE` is the only revocation. | `docs-unlock.ts:15-17` | No per-user revocation. |
| MW-21 | No CORS policy declared; currently relies on browser same-origin defaults. | No `Access-Control-*` anywhere | Becomes permissive-by-omission the moment the API and app are split across domains. |
| MW-22 | Repo-local scripts execute automatically on developer machines. | `package.json` `simple-git-hooks` post-commit; `.cursor/hooks.json` `afterShellExecution` | Developer supply-chain surface; a malicious PR can gain code execution on review. |
| MW-23 | No TLS pinning in the mobile client. | `src/assessment/client.ts` uses bare `fetch` | MitM on a compromised device/network CA. |

### 2.5 OWASP Top 10 (2021) summary

| Category | Status | Notes |
|---|---|---|
| A01 Broken Access Control | 🔴 **Critical** | MW-01, MW-02, MW-06. No authn/authz model exists. |
| A02 Cryptographic Failures | 🟠 High | MW-05, MW-06, MW-10. Transit encryption is fine; integrity and at-rest-on-device are not. |
| A03 Injection | 🟢 **Strong** | No SQLi (parameterised via supabase-js), no XSS surface of note. **Prompt injection is structurally mitigated** by the enum-only Zod cage and the report fact-whitelist — the standout control in this codebase. Residual: MW-13. |
| A04 Insecure Design | 🟠 High | MW-03, MW-07. No threat model, no abuse cases, no tenancy, no cost controls. |
| A05 Security Misconfiguration | 🟠 High | MW-08, MW-13, MW-16, MW-17. |
| A06 Vulnerable & Outdated Components | 🟡 Medium | MW-11. Alpha WASM parser on untrusted input; no SCA. |
| A07 Identification & Authentication Failures | 🔴 **Critical** | MW-01, MW-09. |
| A08 Software & Data Integrity Failures | 🟠 High | MW-02, MW-05, MW-11, MW-22. |
| A09 Logging & Monitoring Failures | 🟠 High | MW-19, MW-13. Audit *content* is excellent; audit *integrity* and *monitoring* are not. |
| A10 SSRF | 🟠 High | MW-04, confirmed. |

### 2.6 Healthcare compliance summary

**Australian Privacy Principles** — wound photographs collected in the course of providing a health service are *health information*, therefore *sensitive information*, attracting the highest protection. "De-identified by construction" is a strong and honest engineering stance, but de-identification is **contextual** under OAIC guidance: an image plus a timestamp plus `wound_id` linkage across visits is re-identifiable in many settings. Treat the data as personal information and let de-identification reduce, not eliminate, the obligation.

| APP | Requirement | Status | Gap |
|---|---|---|---|
| APP 1 | Open and transparent management; privacy policy | ❌ | No privacy policy exists (MW-14) |
| APP 3 | Consent required for sensitive information | ⚠️ | Consent is client-side only, unrecorded, unversioned (MW-14) |
| APP 5 | Notification of collection | ❌ | Research disclaimer only; no collection notice (MW-14) |
| APP 6 | Use and disclosure | ❌ | Disclosure to Replicate/OpenAI/Google/Anthropic is never disclosed to the user (MW-07) |
| APP 8 | Cross-border disclosure | ❌ | US processors, no contractual assurance, `iad1` default region (MW-07) |
| APP 11.1 | Reasonable security steps | ❌ | MW-01 through MW-11 |
| APP 11.2 | Destroy or de-identify when no longer needed | ❌ | No retention or deletion mechanism (MW-15) |
| APP 12 / 13 | Access and correction | ❌ | No mechanism (MW-15) |
| NDB scheme | Assess suspected breach within 30 days; notify | ❌ | No detection, no IR plan (MW-19) |

**HIPAA Security Rule** (applicable only if a US deployment or US-covered-entity customer is pursued):

| §164.312 control | Status |
|---|---|
| (a)(1) Access control / (a)(2)(i) unique user identification | ❌ No user identity exists |
| (b) Audit controls | ⚠️ Content excellent; integrity anchor broken (MW-05); no actor recorded |
| (c) Integrity | ❌ Records overwritable by anonymous callers (MW-02) |
| (e)(1) Transmission security | ✅ TLS throughout |
| (a)(2)(iv) Encryption at rest (addressable) | ⚠️ Platform-level only; device storage unencrypted (MW-10) |
| §164.308(b) Business Associate Agreements | ❌ None recorded with Vercel, Supabase, Replicate, or any model provider |

**TGA (contextual, not a current gap):** the product is consistently and correctly labelled a research prototype and not a medical device, in-app and in the rules file. Note for the roadmap: software that recommends a dressing or triggers a referral is likely to fall inside the SaMD definition once the research framing is dropped, plausibly Class IIa. The "research prototype" labelling is currently functioning as a *regulatory control* — treat any change to that wording as a regulated change, not a copy edit.

---

## 3. Remediation plan

### P0 — before the pitch (≈ half a day, high demo value)

These are the items that turn "we have no security" into "we have a perimeter and a plan", and they protect the demo itself from being taken down or drained.

- **MW-03 / MW-01 — put a shared secret in front of `/api/v1/*` and the legacy routes.** Not a user system; a gate. Create `api/_auth.ts`:

  ```ts
  import { timingSafeEqual } from 'node:crypto';
  import type { VercelRequest, VercelResponse } from '@vercel/node';

  /** MVP gate: a shared client token, not an identity. Replace with per-device
   *  credentials in P1 — this exists so the demo surface is not world-writable. */
  export function requireClient(req: VercelRequest, res: VercelResponse): boolean {
    const expected = process.env.MENDWISE_CLIENT_TOKEN ?? '';
    if (!expected) return true; // unconfigured → open, matches existing degrade-don't-block posture
    const given = String(req.headers['x-mendwise-key'] ?? '');
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || a.length === 0 || !timingSafeEqual(a, b)) {
      res.status(401).json({ error: 'Unauthorized' });
      return false;
    }
    return true;
  }
  ```

  Call it as the first line of every handler; set `EXPO_PUBLIC_CLIENT_TOKEN` on the client and send it in `postJson`/`runAssessmentStream`. **Be explicit in the pitch that this is a demo gate, not an auth system** — a token in an Expo bundle is public by definition. It raises the cost of drive-by abuse to near-certainty-of-detection, which is all it is for.

- **MW-03 — enable Vercel WAF rate limiting and BotID** on `/api/*`. Platform-level, no code, minutes to configure. Suggested starting rule: 20 requests/minute per IP on `/api/v1/*`, 5/minute on `/api/v1/assessments/baseline` and `/api/docs-unlock`. This is the single highest-ROI control available before 13 Oct.

- **MW-04 — close the SSRF.** In [tissue.ts](api/v1/assessments/tissue.ts):

  ```ts
  const MASK_HOSTS = new Set(['replicate.delivery', 'pbxt.replicate.delivery']);

  async function loadMaskPng(source: string): Promise<PNG | null> {
    if (source.startsWith('data:')) { /* decode inline, unchanged */ }
    let url: URL;
    try { url = new URL(source); } catch { return null; }
    if (url.protocol !== 'https:' || !MASK_HOSTS.has(url.hostname)) {
      console.warn('Refusing to fetch a mask from an unapproved host.');
      return null;                       // degrades to the HSV mask — existing behaviour
    }
    // …existing fetch + PNG.sync.read
  }
  ```

  It degrades into the path the code already has, so it cannot break the demo.

- **MW-05 — fix the audit hash.** This is a ten-line change to the document that is your regulatory asset, and it is the finding a technical diligence reviewer is most likely to find impressive that you found yourself:

  ```ts
  import { createHash } from 'node:crypto';

  /** Deterministic serialisation: keys sorted at EVERY level, then SHA-256. */
  function canonicalise(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',')}}`;
  }

  export function hashInputs(inputs: EngineInputs): string {
    return createHash('sha256').update(canonicalise(inputs)).digest('hex');
  }
  ```

  Note the migration consequence honestly: existing `inputs_hash` values are not comparable with new ones. Record the change in `rules_version` notes rather than rewriting history.

- **MW-06 — use a CSPRNG for identifiers.** `src/assessment/state.ts`:

  ```ts
  export function newAssessmentId(): string {
    return `asmt-${globalThis.crypto.randomUUID()}`;
  }
  ```

  Available in Node 20+ and in Expo/Hermes via `expo-crypto` polyfill if needed.

- **MW-02 — stop trusting client-supplied ids.** In `run.ts`, ignore `body.state.id` and mint server-side; in `evaluate.ts`, only load a stored record when the caller also presents the token from P0:

  ```ts
  const state: AssessmentState = { ...(body.state ?? {}), id: newAssessmentId(), createdAt: new Date().toISOString() };
  ```

- **MW-08 — add security headers** to [vercel.json](vercel.json):

  ```json
  "headers": [
    { "source": "/(.*)", "headers": [
      { "key": "Strict-Transport-Security", "value": "max-age=63072000; includeSubDomains; preload" },
      { "key": "X-Content-Type-Options", "value": "nosniff" },
      { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
      { "key": "Permissions-Policy", "value": "camera=(self), geolocation=(), microphone=(), interest-cohort=()" },
      { "key": "Content-Security-Policy", "value": "default-src 'self'; img-src 'self' data: blob: https://replicate.delivery; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'" }
    ]}
  ]
  ```

  Verify the Expo web bundle against the CSP before shipping — Expo's static export may need `'unsafe-inline'` for styles. Start in `Content-Security-Policy-Report-Only` if time is short.

- **MW-16 — turn on Vercel Deployment Protection for Preview.** One setting; closes an entire duplicate public surface.

### P1 — before any real or identifiable patient image (pre-HREC)

- **MW-01 — replace the shared token with real identity.** Supabase Auth (already in the stack) or Clerk via the Vercel Marketplace. Clinician accounts, JWT verified in the functions, `auth.uid()` available to RLS. Then add per-row ownership to `assessments`/`wound_timeline` and write RLS policies so the service role stops being the only thing standing between a bug and the whole dataset (MW-18).
- **MW-12 — validate every request body with Zod at ingress.** You already have the dependency and the discipline; apply the same rigour inbound that you apply to model output:

  ```ts
  const runSchema = z.object({
    base64: z.string().min(100).max(8_000_000),
    inputs: engineInputsSchema,
    pxPerCm: z.number().positive().max(10_000).nullish(),
    areaCm2: z.number().nonnegative().max(10_000).nullish(),
    bodyZoneLabel: z.string().max(64).nullish(),
  }).strict();                               // .strict() is what kills the `state.id` injection
  ```

  `.strict()` also gives you MW-02 defence-in-depth for free.
- **MW-07 — data residency and processor assurance.** Set `"regions": ["syd1"]` in `vercel.json`; move the Supabase project to `ap-southeast-2`; enable zero-data-retention on the AI Gateway; obtain a DPA from Replicate or replace it with a self-hosted SAM 2 in-region. Record each in a processor register — APP 8 requires you to have taken reasonable steps, and the register is how you evidence it.
- **MW-17 — strip EXIF on-device before upload.** `expo-image-manipulator` is already a dependency; a resize/re-encode pass drops metadata and shrinks the payload:

  ```ts
  const clean = await ImageManipulator.manipulateAsync(uri, [{ resize: { width: 1600 } }],
    { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG, base64: true });
  ```
- **MW-10 — move device persistence to `expo-secure-store`** (or encrypt the blob with a SecureStore-held key, since SecureStore has a ~2 KB value limit — store the key there and the ciphertext in AsyncStorage/FileSystem). Add a 7-day purge and exclude the directory from iOS backup.
- **MW-13 — redact upstream errors.** Log the detail server-side with a correlation id; return the id to the client. Never place provider response bodies into `StepOutcome.summary`, which is persisted in the audit log.
- **MW-14 — make consent an artefact.** Version the consent text, record `{consentVersion, acceptedAt}` server-side on `POST /create`, and publish a privacy collection notice covering purpose, the three processor categories, overseas disclosure, retention and contact.
- **MW-09 — rate-limit and expire the docs gate.** Add attempt throttling, make `Secure` unconditional in production, and embed an issued-at timestamp in the signed token so it genuinely expires server-side rather than relying on `Max-Age`.
- **MW-11 — add a CI pipeline.** GitHub Actions running `npm audit --audit-level=high`, `npm test`, `npm run typecheck`, Dependabot, and secret scanning on every PR. Pin or replace `opencv-js-wasm@5.0.0-alpha` before it parses anything that is not your own test imagery.

### P2 — production / clinical pilot

- **MW-15 — data lifecycle.** Retention schedule (note that Australian health-record retention is typically 7 years, or to age 25 for minors — this conflicts with "delete when no longer needed" and must be reconciled deliberately, not by default). Implement deletion, subject-access export, and correction paths.
- **MW-19 — detection and response.** Ship audit and function logs to a retained SIEM, alert on 401 spikes, gateway spend anomalies, and audit-write failures. Write an incident response plan with the NDB 30-day assessment clock in it. Run a tabletop before the pilot.
- **MW-05 (extended) — make the audit trail tamper-evident**, not merely append-only: hash-chain each row to its predecessor, or sign rows with **Vercel KMS**. Add actor, source IP and request id to each record.
- **MW-18 — shrink the blast radius.** Per-user JWTs with RLS as the primary path; reserve the service role for a narrow set of administrative operations. Document key rotation and rotate on a schedule.
- **Assurance activities.** Threat model (STRIDE) on the pipeline; independent penetration test; BAAs/DPAs executed with every processor; SOC 2 readiness if pursuing enterprise or US health customers.
- **MW-23** — certificate pinning in the mobile client.
- **TGA** — regulatory pathway assessment before any change that drops the research-prototype framing.

---

## 4. What to say in the pitch

Lead with the controls that are genuinely differentiated, and be candid about the perimeter:

> "The decision path is deterministic and auditable by design. The AI is caged — the vision model can only return enumerated observations against a schema, so there is no free-text channel from an image into a clinical recommendation, and prompt injection cannot produce a dressing. Every completed assessment writes an immutable audit row tying inputs, rules version and model identity to the result. The data model has nowhere to put a patient identifier.
>
> What we have not built yet is the access layer — there are no users, so there is no authentication. That is scheduled ahead of ethics clearance, alongside data residency in Sydney and processor agreements, and none of it touches the clinical engine."

That is a stronger position than claiming completeness, and it is the answer a healthcare-experienced investor is testing for.

---

*Prepared by: Principal Application Security Architect review, 26 Sep 2026. Findings are evidence-based against the repository at `31fec6d`; no live penetration testing was performed against the deployed environment.*
