/**
 * Live segmentation probe. Run: npm run check:segmentation
 *
 * Answers one question per backend: *does the real endpoint speak the contract
 * this app assumes?* The offline suite (`npm run test:segmentation`) proves the
 * request we build and the responses we can parse; only a real call proves that
 * fal's SAM 3 and the deployed FUSegNet handler agree with it.
 *
 * Probed in chain order: SAM 3 first, then FUSegNet.
 *
 * It sends the request assembled by the shared builders in
 * `api/_segmentationParse.ts` — the same ones the adapters use — so a pass here
 * means the pipeline's request works, not a lookalike's. On a response we cannot
 * read, it prints the endpoint's actual top-level keys and the first part of the
 * body, which turns a contract mismatch into a one-line env fix
 * (`FUSEGNET_MASK_FIELD`) instead of a debugging session.
 *
 * Needs the provider env vars in the environment; `.env.local` is read
 * automatically. Costs one GPU inference per configured provider.
 *
 * Flags:
 *   --image=path   probe with a real wound photo instead of the synthetic one
 *                  (strongly preferred: a flat synthetic image is a fine test of
 *                  the wire format and a meaningless test of the model)
 */
import { existsSync, readFileSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
}

const {
  dataUrlToBytes,
  fusegnetHealthUrl,
  fusegnetRequest,
  imageSize,
  maskPlausibility,
  parseFusegnetResponse,
  parseProviderOrder,
  parseSam3Response,
  sam3Request,
} = await import('../api/_segmentationParse.ts');

const jpeg = (await import('jpeg-js')).default;

// --- the probe image --------------------------------------------------------

const imageArg = process.argv.find((a) => a.startsWith('--image='))?.slice('--image='.length);

/**
 * A synthetic 256×256 JPEG: skin-toned field with a darker red ellipse in the
 * middle. Not a wound, and not expected to be segmented as one — it exists so
 * the wire format can be checked without a clinical image on disk. Use
 * `--image=` for anything you want to judge the model by.
 */
function syntheticImage(): string {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const dx = (x - size / 2) / (size * 0.18);
      const dy = (y - size / 2) / (size * 0.22);
      const inside = dx * dx + dy * dy < 1;
      data[i] = inside ? 150 : 222;
      data[i + 1] = inside ? 40 : 170;
      data[i + 2] = inside ? 45 : 150;
      data[i + 3] = 255;
    }
  }
  const encoded = jpeg.encode({ data: Buffer.from(data), width: size, height: size }, 80);
  return `data:image/jpeg;base64,${Buffer.from(encoded.data).toString('base64')}`;
}

function loadImage(path: string): string {
  const bytes = readFileSync(path);
  const ext = path.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
  return `data:image/${ext};base64,${bytes.toString('base64')}`;
}

const imageDataUrl = imageArg ? loadImage(imageArg) : syntheticImage();
const bytes = dataUrlToBytes(imageDataUrl);
const size = bytes ? imageSize(bytes) : null;
// Centre of the frame: the stand-in for the HSV centroid the app would send.
const point = { xPct: 0.5, yPct: 0.5 };

console.log(`Probe image: ${imageArg ?? 'synthetic 256×256'}${size ? ` (${size.width}×${size.height})` : ''}`);
console.log(`Provider order: ${parseProviderOrder(process.env.SEGMENTATION_PROVIDERS).join(' → ')}\n`);

let failures = 0;

/** Fetch a mask and report its real pixel area, which is the only honest check. */
async function measureMask(ref: string): Promise<string> {
  try {
    const { PNG } = await import('pngjs');
    const buffer = ref.startsWith('data:')
      ? Buffer.from(ref.replace(/^data:[^;,]*;base64,/, ''), 'base64')
      : Buffer.from(await (await fetch(ref)).arrayBuffer());
    const png = PNG.sync.read(buffer);
    const total = png.width * png.height;
    let area = 0;
    for (let i = 0; i < total; i += 1) {
      const idx = i * 4;
      if (png.data[idx + 3] > 127 && (png.data[idx] + png.data[idx + 1] + png.data[idx + 2]) / 3 > 127) area += 1;
    }
    const verdict = maskPlausibility(area, total);
    return `${png.width}×${png.height}, ${area.toLocaleString()} px set (${((area / total) * 100).toFixed(2)}% of frame) → ${verdict}`;
  } catch (error) {
    return `could not decode the mask (${error instanceof Error ? error.message : 'unknown'})`;
  }
}

async function send(request: { url: string; method: 'POST'; headers: Record<string, string>; body: string; timeoutMs: number }) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// --- SAM 3 (fal.ai) --------------------------------------------------------

const sam3Req = sam3Request(process.env, { imageDataUrl, point, imageBytes: bytes });
if (!sam3Req) {
  console.log('sam3 — SKIPPED: FAL_KEY is unset.\n');
} else {
  const sent = JSON.parse(sam3Req.body) as { prompt: string; point_prompts?: unknown[] };
  console.log(
    `sam3 → ${sam3Req.url}\n  prompt: "${sent.prompt}", point prompt: ${
      sent.point_prompts ? JSON.stringify(sent.point_prompts) : 'none (dimensions unreadable)'
    }`,
  );
  try {
    const { ok, status, text, ms } = await send(sam3Req);
    if (!ok) {
      failures += 1;
      console.error(`  FAIL ${status} after ${ms}ms: ${text.slice(0, 300)}`);
      if (status === 401 || status === 403) console.error('  → check FAL_KEY (scheme is `Authorization: Key <key>`).');
      if (status === 422) console.error('  → fal rejected the input schema; the model may have changed.');
    } else {
      const parsed = parseSam3Response(JSON.parse(text) as unknown);
      console.log(`  ${ms}ms, keys: [${parsed.keys.join(', ')}]`);
      if (parsed.masks.length === 0) {
        // Not necessarily a failure on the synthetic image — an ellipse is not a
        // wound. It IS a failure on a real photo.
        console.log(`  no "${sent.prompt}" found. Expected on the synthetic image; a real wound photo should match.`);
        if (imageArg) failures += 1;
      } else {
        console.log(`  OK ${parsed.masks.length} mask(s), scores: ${parsed.scores ? parsed.scores.join(', ') : 'not reported'}`);
        console.log(`  best mask: ${await measureMask(parsed.masks[0])}`);
      }
    }
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log('');
}

// --- FUSegNet (Modal) ------------------------------------------------------

const fusegReq = fusegnetRequest(process.env, imageDataUrl);
if (!fusegReq) {
  console.log('fusegnet — SKIPPED: FUSEGNET_MODAL_URL is unset.\n');
} else {
  // Hit /health first. It is free, it says which weights are loaded and at what
  // input size, and it warms a cold container — otherwise the first real call
  // absorbs a ~15 s model load and a timeout reads as a broken endpoint.
  const healthUrl = fusegnetHealthUrl(process.env);
  if (healthUrl) {
    try {
      const started = Date.now();
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(fusegReq.timeoutMs) });
      const text = await response.text();
      console.log(`fusegnet /health → ${response.status} in ${Date.now() - started}ms: ${text.slice(0, 200)}`);
    } catch (error) {
      console.error(`fusegnet /health → unreachable (${error instanceof Error ? error.message : 'failed'})`);
    }
  }
  const authUsed = fusegReq.headers['Modal-Key']
    ? 'Modal-Key/Modal-Secret'
    : fusegReq.headers.Authorization
      ? 'Authorization: Bearer'
      : 'none (public endpoint)';
  console.log(`fusegnet → ${fusegReq.url}\n  auth: ${authUsed}, request field: ${Object.keys(JSON.parse(fusegReq.body))[0]}`);
  try {
    const { ok, status, text, ms } = await send(fusegReq);
    if (!ok) {
      failures += 1;
      console.error(`  FAIL ${status} after ${ms}ms: ${text.slice(0, 300)}`);
      if (status === 401 || status === 403) {
        // The deployed handler declares its own optional `authorization` header
        // (see its openapi.json), and answers `{"detail":"unauthorised"}` — which
        // is its own check, not Modal's proxy. So the bearer token is the likely
        // fix; the Modal pair only applies if the endpoint uses proxy auth.
        console.error('  → set FUSEGNET_AUTH_TOKEN to the token the handler expects');
        console.error('    (or MODAL_KEY + MODAL_SECRET if the endpoint uses Modal proxy auth).');
      }
    } else {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        failures += 1;
        console.error(`  FAIL response is not JSON: ${text.slice(0, 200)}`);
        json = null;
      }
      if (json) {
        const parsed = parseFusegnetResponse(json, process.env.FUSEGNET_MASK_FIELD);
        console.log(`  ${ms}ms, keys: [${parsed.keys.join(', ')}]`);
        if (!parsed.mask) {
          failures += 1;
          console.error('  FAIL no recognisable mask in the response.');
          console.error(`  → set FUSEGNET_MASK_FIELD to whichever of [${parsed.keys.join(', ')}] holds the mask`);
          console.error(`  → body starts: ${text.slice(0, 300)}`);
        } else {
          console.log(`  OK mask: ${await measureMask(parsed.mask)}`);
          console.log(`  score: ${parsed.score ?? 'not reported'}, area_px: ${parsed.areaPx ?? 'not reported'}`);
        }
      }
    }
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log('');
}

if (failures > 0) {
  console.error(`${failures} provider check(s) failed.`);
  process.exit(1);
}
console.log('Segmentation probe complete.');
