---
title: Tech stack
description: Layer → technology → why, for mobile, web, backend, data, inference, and tooling.
---

<!-- docs-hook:auto:start:versions -->
Versions below are from the app `package.json` / `app.json` at last docs check.

| Package | Version in repo |
|---|---|
| `expo` | `~57.0.14` |
| `react` / `react-dom` | `19.2.3` |
| `react-native` | `0.86.2` |
| `ai` | `^6.0.286` |
| `zod` | `^4.6.5` |
| `zustand` | `^5.0.15` |
| `@supabase/supabase-js` | `^2.116.0` |
| `react-native-fast-opencv` | `^1.0.1` |
| `opencv-js-wasm` | `^5.0.0-alpha` |
| `typescript` | `~6.0.3` |
<!-- docs-hook:auto:end:versions -->

## Mobile

| Layer | Technology | Why |
|---|---|---|
| App framework | Expo SDK 57 + Expo Router | One codebase, typed routes, file-based screens in `src/app/` |
| UI | React 19.2 + React Native 0.86 | Native iOS/Android; React Compiler experiment on |
| Dev client | `expo-dev-client` | Required: `react-native-fast-opencv` is not in Expo Go |
| Capture | `expo-camera`, `expo-image-picker` | Camera + gallery; same quality path |
| On-device CV | `react-native-fast-opencv` | HSV quality gate + tissue % without a network hop |
| State | Zustand + AsyncStorage persist | Session + last-10 reports, no Redux |
| Feature flag | `EXPO_PUBLIC_ASSESSMENT_V2` | Additive V2; default off unless set |

## Web

| Layer | Technology | Why |
|---|---|---|
| Bundling | Expo for web, `web.output: "static"` | Static export to `dist/` |
| Hosting | Vercel (`mendwise.vercel.app`) | Same origin as `/api/*` functions. Starlight docs are copied into `dist/docs` and served at `/docs` (passphrase-gated) |
| Browser CV | **Not** in the browser. `opencv-js-wasm` in `api/analyze.ts` | WASM + Node function; Metro web stub throws |
| Camera | `getUserMedia` via `expo-camera` | HTTPS required |
| Native vs web | Web is not full parity | Image quality varies; depth is 2D-only on every platform |

There is **no** Electron / native desktop app. "Desktop" means the web build in a desktop browser.

## Backend / API

| Layer | Technology | Why |
|---|---|---|
| Functions | Vercel Node (`@vercel/node`) | `api/**/*.ts` filesystem routing |
| Timeouts | `vercel.json` `functions.*.maxDuration` | Not route-segment `export const config` |
| Orchestration | `_controller.ts` + SSE `run.ts` | Deterministic state machine, not an agent |
| Validation | Zod | VLM cage + report schema |

## Data

| Layer | Technology | Why |
|---|---|---|
| Database | Supabase (Postgres) | Assessments, images metadata, timeline, rules_version, audit_log |
| Access | Service role from functions only | RLS deny-by-default; no anon write path |
| Client | Never holds DB credentials | Talks only to `/api/v1/*` |

## AI / inference

| Layer | Technology | Why |
|---|---|---|
| Frontier VLM + LLM | Vercel AI SDK v6 over **AI Gateway** | OIDC / gateway key, `getAvailableModels()`, no hardcoded provider keys |
| VLM cage | `generateObject` + Zod, `temperature: 0` | Enums only; schema is the cage (temp 0 is best-effort on reasoning models) |
| Segmentation | SAM 2 on **Replicate** (`meta/sam-2`) | Not on the Gateway (no GPU SAM there). Zero-shot, boundary only |
| Report fallback | `reportTemplate.ts` | Pitch and patients survive a gateway outage |

## Dev tooling

| Layer | Technology | Why |
|---|---|---|
| Language | TypeScript strict | Shared types client ↔ api |
| Engine tests | `node --experimental-strip-types` | No build step for `engine.ts` |
| Live probes | `check-gateway.mts`, `smoke-live.mts` | Listing ≠ entitlement; smoke checks Postgres rows exist |
| Import guard | `test-imports.mts` | Catches `@/` in files reachable from `api/` |
| Copy guard | `test-copy.mts` | Bans manufacturer name + jargon in UI strings |
| Native cloud builds | EAS (`eas.json`) | development / preview / production profiles |
| This site | Astro 7 + Starlight + `astro-mermaid` | Static docs, separate Vercel project |
