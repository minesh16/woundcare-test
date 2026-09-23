---
title: Screens
description: Expo Router screens and the actual navigation order.
---

Path: [`src/app/`](https://github.com/minesh16/woundcare-test/tree/main/src/app) — Expo Router file-based routes. Root stack in `_layout.tsx`.

<!-- docs-hook:auto:start:files -->
| File | Route | What it does |
|---|---|---|
| `_layout.tsx` | — | Stack titles |
| `analyze.tsx` | `/analyze` | HSV analysis, optional SAM overlay, tissue bars |
| `capture.tsx` | `/capture` | Camera + gallery, 20c coin toggle |
| `compare.tsx` | `/compare` | Ungrounded baseline vs SSE `run` (V2 only) |
| `index.tsx` | `/` | Welcome, disclaimer, consent checkbox, Start |
| `location.tsx` | `/location` | Body diagram (`BodySelector`) — front/back, male/female, tappable regions + list fallback |
| `questions.tsx` | `/questions` | Duration, exudate, pain, warmth, infection, perfusion; ABPI / diabetes behind clinician toggle |
| `result.tsx` | `/result` | `assess(session)` + `ResultPanel`; save JSON; link to compare if V2 |
<!-- docs-hook:auto:end:files -->

Progress header numbers: capture/analyze = step 1, location = 2, questions = 3. Result uses `ResultPanel`.

Zustand: [`src/store/sessionStore.ts`](https://github.com/minesh16/woundcare-test/blob/main/src/store/sessionStore.ts) — persisted session + last 10 saved reports. `setV2Run` will not overwrite a good V2 result with `null`.

<!-- docs-hook: last auto-checked against commit 72b0cc6 on 2026-09-23 -->
