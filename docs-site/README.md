# MendWise documentation site

Starlight (Astro) docs for the MendWise wound-assessment prototype. Sibling of the Expo app in this repo — **not** a second GitHub repository and **not** a second Vercel project.

Live URL: **[mendwise.vercel.app/docs](https://mendwise.vercel.app/docs)** (passphrase-gated). The wound app stays public at the origin.

## Local

```bash
cd docs-site
npm install
npm run dev      # http://localhost:4321/docs/
npm run build    # static output in dist/
```

`base` is `/docs` so local and production paths match. Mermaid diagrams use [`astro-mermaid`](https://github.com/joesaby/astro-mermaid) (registered *before* Starlight in `astro.config.mjs`) plus `public/mermaid-viewer.js` for pan / zoom / fullscreen.

## Deploy (same Vercel project as the app)

Root `vercel.json` `buildCommand` is `node scripts/build-vercel.mjs`:

1. `npm ci` + `astro build` in this folder
2. `npx expo export -p web` (writes `dist/`)
3. copy `docs-site/dist` → `dist/docs`

Set **`DOCS_PASSPHRASE`** on the existing MendWise Vercel project (Production + Preview, server-side — never `EXPO_PUBLIC_`). Then redeploy; Vercel binds env at deploy time.

`middleware.ts` only matches `/docs`. `POST /api/docs-unlock` sets an HttpOnly cookie. There is no `vercel.json` in this folder on purpose — do not add one, and do not change the project's Root Directory to `docs-site/`.

## What not to do

- Do not create a second Vercel project for these docs.
- Do not copy the repo-root `vercel.json` in here — that file's `buildCommand` now builds **both** the app and this site.
- Do not add `api/**/index.ts`.
- Do not put `maxDuration` anywhere except root `vercel.json`.
- Do not invent capability on the roadmap page.
