# WoundCare Demo (Expo)

Project path: `/Users/minesh/Agents/woundcare-test` (moved from OneDrive to avoid apostrophe path issues with CocoaPods).

Research prototype mobile app for the La Trobe AI Innovation Ventures Program. Implements the 4-step wound assessment demo flow:

1. Capture wound photo (optional 20c coin for scale)
2. On-device OpenCV tissue/area analysis
3. Body-map location picker
4. Diagnostic questions → transparent rule-based demo result

**This is not a medical device and is not for clinical use.**

## Requirements

- Node.js 20+
- For native OpenCV: a **custom dev client** (Expo Go is not supported for `react-native-fast-opencv`)
- Xcode (iOS) and/or Android Studio (Android) for local native builds

## Setup

```bash
npm install
```

## Run (development)

### Web (browser camera + server-side OpenCV)

```bash
npm run web
```

`npm run web` (plain Metro) serves the UI only — there is no `/api` route, so the
analyser transparently falls back to the deterministic demo engine.

To exercise the real web flow (browser camera + server OpenCV) locally, run the
static export and the serverless function together with the Vercel CLI:

```bash
npx vercel dev
```

On web the app captures via the browser camera (`getUserMedia`, HTTPS required) and
POSTs the photo to the `api/analyze.ts` serverless function, which runs OpenCV.js
(WASM) and returns the same `CvResult` shape used natively.

### Deploy the web build (new Vercel project)

1. Import this repo as a **new Vercel project**, framework preset **Other**.
2. Vercel reads [`vercel.json`](vercel.json): build `npx expo export -p web`, output
   `dist/`, and deploys `api/analyze.ts` as a Node serverless function.
3. (Optional) set `EXPO_PUBLIC_ANALYZE_URL` if the function lives on another origin;
   it defaults to the same-origin `/api/analyze`.

**Web is not full parity with native.** Browser image quality varies, depth is still
not measured (2D limitation, by design), and tissue segmentation remains demo-grade.
Native dev-client distribution stays the right path for full-feature MVP testing.

### Native dev client (recommended)

Build and install a development client once:

```bash
# Local build (Mac + simulator/device)
npx expo run:ios
# or
npx expo run:android

# Or cloud build via EAS
npx eas build --profile development --platform ios
npx eas build --profile development --platform android
```

Then start Metro:

```bash
npm start
```

Open the project in your installed dev client.

## Demo script (assessor walkthrough)

1. Open app → read disclaimer → check consent → **Start assessment**
2. **Capture** a wound image (or pick from gallery). Toggle coin reference if a 20c coin is visible.
3. Review **analysis** overlay, tissue bars, area, and depth limitation note.
4. Select **body location** on front/back map.
5. Answer **questions** (duration, exudate, pain, warmth).
6. Review **result** rationale, save JSON report, or start a new scan.

## Project structure

```
src/app/           Expo Router screens
src/cv/            OpenCV pipeline + fallback
src/decision/      Types + deterministic rules engine
src/components/    UI building blocks
src/store/         Zustand session store
```

## Testing checklist

- [ ] iOS dev client: capture → analyse → result under 2 minutes
- [ ] Android dev client: same happy path
- [ ] Gallery fallback when camera denied
- [ ] Coin toggle: cm² when detected, relative px² when not
- [ ] Result rationale lists triggered rules

## Notes

- Depth is **not** measured from a single 2D photo by design.
- OpenCV tissue colours are **demo-grade** colour segmentation, not diagnostic classification.
- Native runs OpenCV on-device (`react-native-fast-opencv`); web runs the same pipeline
  server-side via OpenCV.js in a Vercel function (`api/analyze.ts`).
- Frame this build as Assessment 3 technical feasibility for a clinician-in-the-loop repositioning — not a consumer diagnostic product.
