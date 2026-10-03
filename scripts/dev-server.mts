/**
 * Local API server for the `api/` functions. Run: npm run dev:api
 *
 * Why this exists: `npm run web` serves the Expo app with **no** `/api` routes,
 * and `vercel dev` needs the Vercel CLI. Without either, the deployed handlers'
 * request/response wrappers were only ever covered by `typecheck` — the gap
 * `docs/HANDOFF.md` records as "smoke:live exercises everything they delegate to
 * but not the handlers themselves. Hit them once deployed." This closes it
 * locally: it imports the real handler modules and serves them over HTTP, so a
 * broken wrapper fails here instead of in production.
 *
 * It deliberately mirrors Vercel's filesystem routing, including the quirk that
 * cost a bad deploy: a nested `api/**\/index.ts` is NOT routed to its directory
 * path. If a route 404s here it will 404 there.
 *
 * It does NOT serve the Expo app — this is the API surface only. Point the app
 * at it with `EXPO_PUBLIC_API_BASE=http://localhost:3000`.
 *
 * `.env.local` is loaded the same way the other scripts load it.
 *
 *   PORT=3000 npm run dev:api
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    // `in`, not truthiness: an explicitly empty var (FAL_KEY= npm run dev:api)
    // stays empty, so a degraded mode can be run on purpose.
    if (match && !(match[1] in process.env)) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
}

const PORT = Number(process.env.PORT ?? 3000);
const ROOT = process.cwd();

/**
 * Map a request path to a handler file, the way Vercel does.
 *
 * Rejects `_`-prefixed modules (shared libraries, not routes) and does NOT fall
 * back to `index.ts` for a directory — both match the platform, and the second
 * one is why the create route is an explicit `create.ts`.
 */
function resolveHandlerPath(pathname: string): string | null {
  const clean = pathname.replace(/\/+$/, '').replace(/^\/+/, '');
  if (!clean.startsWith('api/') || clean.includes('..')) return null;
  const segments = clean.split('/');
  if (segments.some((s) => s.startsWith('_'))) return null;
  const candidate = resolve(ROOT, `${clean}.ts`);
  return existsSync(candidate) ? candidate : null;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Handlers already tolerate a string body (`typeof req.body === 'string'`),
    // so hand it over rather than failing the request here.
    return raw;
  }
}

/**
 * Adapt Node's ServerResponse to the slice of the Vercel response the handlers
 * use. `write`/`writeHead`/`setHeader`/`end` are already native, so only
 * `status()` and `json()` are added — which is also why `run.ts`'s SSE streaming
 * works here unchanged.
 */
function augment(res: ServerResponse) {
  const augmented = res as ServerResponse & {
    status: (code: number) => typeof augmented;
    json: (body: unknown) => void;
  };
  augmented.status = (code: number) => {
    augmented.statusCode = code;
    return augmented;
  };
  augmented.json = (body: unknown) => {
    if (!augmented.headersSent) augmented.setHeader('Content-Type', 'application/json');
    augmented.end(JSON.stringify(body));
  };
  return augmented;
}

const server = createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const handlerPath = resolveHandlerPath(url.pathname);

  const log = (status: number, note = '') =>
    console.log(`${req.method} ${url.pathname} → ${status} ${Date.now() - started}ms ${note}`.trimEnd());

  if (!handlerPath) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: `No API route for ${url.pathname}` }));
    log(404);
    return;
  }

  try {
    const module = (await import(pathToFileURL(handlerPath).href)) as {
      default?: (req: unknown, res: unknown) => unknown;
    };
    if (typeof module.default !== 'function') {
      // A library under api/ with no default export — same as Vercel, not a route.
      res.statusCode = 404;
      res.end(JSON.stringify({ error: `${url.pathname} is not a route (no default export)` }));
      log(404, '(no default export)');
      return;
    }

    const augmentedReq = Object.assign(req, {
      body: await readBody(req),
      query: Object.fromEntries(url.searchParams),
    });

    await module.default(augmentedReq, augment(res));
    log(res.statusCode);
  } catch (error) {
    // A handler that throws is the bug this server exists to catch, so the stack
    // goes to the console in full rather than being summarised away.
    console.error(`\n✖ ${req.method} ${url.pathname} threw:\n`, error, '\n');
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Handler threw.' }));
    } else {
      res.end();
    }
    log(500, '(threw — see stack above)');
  }
});

server.listen(PORT, () => {
  console.log(`API dev server on http://localhost:${PORT}`);
  console.log('Routes are the files under api/ (no app, no static assets). Try:');
  console.log(`  curl http://localhost:${PORT}/api/v1/assessments/health`);
});
