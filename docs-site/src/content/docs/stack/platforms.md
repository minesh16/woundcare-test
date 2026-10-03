---
title: Platforms & versions
description: iOS, Android, and web support matrix. There is no desktop app.
---

MendWise ships **three** surfaces, all from the same Expo project. There is **no** native desktop or Electron build. Using a laptop means opening the **web** build in a browser.

<!-- docs-hook:auto:start:app -->
From [`app.json`](https://github.com/minesh16/woundcare-test/blob/main/app.json):

| Field | Value |
|---|---|
| Expo name | WoundCare Demo |
| slug | `woundcare-test` |
| version | `1.0.0` |
| iOS bundle id | `edu.latrobe.woundcaredemo` |
| Android package | `edu.latrobe.woundcaredemo` |
| Orientation | portrait |
| Web output | `static` |
| Scheme | `woundcaretest` |
<!-- docs-hook:auto:end:app -->

## Support matrix

| | iOS | Android | Web (mobile or desktop browser) |
|---|---|---|---|
| How to run | `npx expo run:ios` (dev client) | `npx expo run:android` | `npm run web` (UI only) or `npx vercel dev` (UI + `/api`) |
| Production | Not store-listed (research demo). EAS profiles exist | Same | [mendwise.vercel.app](https://mendwise.vercel.app) |
| Camera | `NSCameraUsageDescription` | `CAMERA` permission | `getUserMedia`, **HTTPS** |
| Gallery | Photo library usage string | via image-picker | File picker |
| OpenCV | On-device `react-native-fast-opencv` | On-device | Server `api/analyze.ts` (`opencv-js-wasm`) |
| Expo Go | **Not supported** (native OpenCV) | **Not supported** | N/A |
| Boundary / VLM / report | Via `EXPO_PUBLIC_API_BASE` → Vercel | Same | Same-origin `/api/v1/*` |
| Depth | Not measured (2D photo, all platforms) | Same | Same |
| Coin scale | Hough on-device | Hough on-device | Hough in `api/analyze.ts` |

Minimum OS versions are **not overridden** in `app.json`. They inherit Expo SDK 57 defaults ([Expo SDK 57 reference](https://docs.expo.dev/versions/v57.0.0/)):

| | Minimum |
|---|---|
| iOS | **16.4+** |
| Android | **7.0+ (API 24)**; compile/target SDK 36 |
| Xcode for local iOS builds | **26.4+** (SDK 57 table) |
| Web browsers | Modern evergreen (static Expo web). Camera requires a secure context |

:::note
`app.json` does not set `ios.deploymentTarget` or Android `minSdkVersion`. If those ever diverge from SDK 57 defaults, update this table from the native projects / `expo-build-properties`, not from memory.
:::

## Where the heavy compute runs

Nothing in the list below runs on the device, which is the build spec's parity rule (§2.4): one implementation, identical on native and web.

| Workload | Host | Reached via |
|---|---|---|
| Wound boundary — FUSegNet | **Modal** (GPU web endpoint) | `FUSEGNET_MODAL_URL` |
| Wound boundary — SAM 3 | **fal.ai** `fal-ai/sam-3/image` | `FAL_KEY` |
| Wound boundary — SAM 2 (fallback) | **Replicate** `meta/sam-2` | `REPLICATE_API_TOKEN` |
| Caged VLM + report LLM | **Vercel AI Gateway** | `AI_GATEWAY_API_KEY` / OIDC |
| HSI tissue %, periwound, coin scale | Vercel Functions (OpenCV.js) — or on-device OpenCV on native | `/api/analyze`, `/api/v1/assessments/tissue` |
| Deterministic engine | Anywhere — pure TypeScript, no network | `src/decision/engine.ts` |

Segmentation is deliberately **not** on the AI Gateway: the gateway serves text / image-gen / video / speech / embedding / reranking models, and none of these three is one of those.

## What works where in practice

**Native dev client** is the right path for full-feature MVP testing: on-device OpenCV, camera quality, and the same V2 endpoints as web once `EXPO_PUBLIC_API_BASE` points at the deployment.

**Web** is the pitch / Assessment 3 surface. `npm run web` (plain Metro) has **no `/api` route** — analysis falls back to the deterministic demo engine. To exercise real web analysis locally, run `npx vercel dev` so functions exist.

**Desktop** = Chrome/Safari/Firefox on a laptop viewing the web build. Not a separately packaged app.

<!-- docs-hook: last auto-checked against commit e8cef6a on 2026-10-03 -->
