/**
 * AI Gateway smoke check. Run: npm run check:gateway
 *
 * Reports which model each role will actually use. The gateway's model listing
 * says nothing about whether *your account* can call a model — a free tier
 * lists 342 models and can call a fraction of them — so this probes each
 * candidate with one tiny request rather than trusting the listing.
 *
 * Costs a fraction of a cent. Worth it: the alternative is discovering a
 * restricted model mid-demo.
 *
 * Needs AI_GATEWAY_API_KEY (or a Vercel OIDC token) in the environment —
 * `.env.local` is read automatically if present.
 */
import { readFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
}

const { gateway, generateText } = await import('ai');
const jpeg = (await import('jpeg-js')).default;
const { resolveModelCandidates, isGatewayConfigured } = await import('../api/v1/assessments/_gateway.ts');

if (!isGatewayConfigured()) {
  console.error('AI Gateway is not configured. Set AI_GATEWAY_API_KEY in .env.local (or run on Vercel with OIDC).');
  process.exit(1);
}

/**
 * A real 32x32 JPEG, encoded here rather than pasted as base64 — a hand-written
 * "tiny JPEG" is easy to get subtly wrong, and a malformed image makes a
 * perfectly good model look unavailable.
 */
function probeImage(): string {
  const size = 32;
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    data[i * 4] = 200;
    data[i * 4 + 1] = 60;
    data[i * 4 + 2] = 60;
    data[i * 4 + 3] = 255;
  }
  const encoded = jpeg.encode({ data: Buffer.from(data), width: size, height: size }, 70);
  return `data:image/jpeg;base64,${Buffer.from(encoded.data).toString('base64')}`;
}

const TINY_JPEG = probeImage();

async function probe(model: string, withImage: boolean): Promise<string | null> {
  try {
    await generateText({
      model,
      // 16 is the floor some providers enforce; asking for less is rejected as
      // an invalid request and reads as "model unavailable" if you're not careful.
      maxOutputTokens: 16,
      messages: [
        {
          role: 'user',
          content: withImage
            ? [{ type: 'text', text: 'Reply with the word ok.' }, { type: 'image', image: TINY_JPEG }]
            : 'Reply with the word ok.',
        },
      ],
    });
    return null;
  } catch (error) {
    const raw = String(
      (error as { cause?: { responseBody?: string } })?.cause?.responseBody ??
        (error instanceof Error ? error.message : error),
    );
    if (/Free tier|credits|RestrictedModels/i.test(raw)) return 'restricted on this account (needs credits)';
    if (/no_providers_available/i.test(raw)) return 'no provider available';
    return raw.replace(/\s+/g, ' ').slice(0, 90);
  }
}

try {
  const available = await gateway.getAvailableModels();
  const language = available.models.filter((m) => m.modelType == null || m.modelType === 'language');
  console.log(`Gateway reachable — ${available.models.length} models listed (${language.length} language).`);
  console.log('Note: the listing is the catalogue, not your entitlements. Probing each candidate.\n');

  let anyFailed = false;

  for (const role of ['vlm', 'llm'] as const) {
    const candidates = await resolveModelCandidates(role);
    const label = role === 'vlm' ? 'VLM (image → enums)' : 'Report (facts → prose)';
    console.log(`${label} — ${candidates.length} candidate(s) in preference order:`);

    if (candidates.length === 0) {
      console.log('  none. Pin one with MENDWISE_VLM_MODEL / MENDWISE_LLM_MODEL.\n');
      anyFailed = true;
      continue;
    }

    let chosen: string | null = null;
    for (const model of candidates) {
      const failure = await probe(model, role === 'vlm');
      if (failure === null) {
        console.log(`  ✓ ${model}${chosen === null ? '   ← will be used' : ''}`);
        if (chosen === null) chosen = model;
      } else {
        console.log(`  ✗ ${model} — ${failure}`);
      }
    }

    if (!chosen) {
      console.log(`  NO USABLE MODEL for the ${role} role.`);
      anyFailed = true;
    }
    console.log('');
  }

  if (anyFailed) {
    console.log('At least one role has no usable model. That role degrades to "unavailable":');
    console.log('  - VLM unavailable → the engine runs without the image-review axis and says so.');
    console.log('  - Report unavailable → the deterministic template writes both documents.');
    console.log('Neither breaks the pipeline, but the demo is weaker. Add gateway credits or pin a model.');
    process.exit(1);
  }

  console.log('Both roles have a usable model.');
} catch (error) {
  console.error('Gateway check failed:', error instanceof Error ? error.message : error);
  process.exit(1);
}
