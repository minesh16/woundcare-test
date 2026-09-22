---
title: Copy / presentation
description: Plain-language maps and referral copy. Engine strings stay untouched.
---

Path: [`src/copy/`](https://github.com/minesh16/woundcare-test/tree/main/src/copy)

The engine's own strings are the clinical record (`test:rules` asserts on them; they go into `audit_log`). This module maps stable `code`s and enums onto wording a non-clinician can act on. The Clinician view shows the originals.

:::caution
This wording has **not** been reviewed by a clinician. Plain language that is subtly wrong is worse than jargon, because it will be believed. Top non-code follow-up in `HANDOFF.md`.
:::

<!-- docs-hook:auto:start:files -->
| File | Role |
|---|---|
| `plainLanguage.ts` | Tissue / exudate / infection / confidence / gate / report term map |
| `referrals.ts` | `code → { title, whatThisMeans, whatToDo }`, `URGENCY_PLAIN`, `referralCopy()` |
<!-- docs-hook:auto:end:files -->

## Consumers

- [`ResultPanel.tsx`](https://github.com/minesh16/woundcare-test/blob/main/src/components/ResultPanel.tsx) — result screen order: what to do → what we saw → dressing (with CWCS provenance) → why → Clinician view
- [`analyze.tsx`](https://github.com/minesh16/woundcare-test/blob/main/src/app/analyze.tsx) — tissue bar labels (`TISSUE_CLASS_PLAIN`), clinical labels behind a technical toggle
- [`reportTemplate.ts`](https://github.com/minesh16/woundcare-test/blob/main/src/assessment/reportTemplate.ts) and the report LLM (`REPORT_TERM_MAP` inlined into the system prompt)

Manufacturer name is banned from `src/app`, `src/components`, `src/copy` rendered strings (`npm run test:copy`). It remains in the engine as provenance.

`referralCopy(flag)` falls back to the engine message for an unknown code so a new trigger cannot vanish from the screen.
