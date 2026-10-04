/** §21.12 — cost estimator and budget guard, from the committed costs.yaml. */
import { ensureFixtures, json, mockProviders } from './helpers.mts';
import type { T } from './run.mts';

export default async function (t: T) {
  const costs = await t.load<typeof import('../src/costs')>('../src/costs.ts');
  const c = costs.loadCosts();

  // The pre-filled rates (spec §13.6), exactly as committed.
  t.eq(c.providers.sam3.usd_per_request, 0.005, 'SAM 3 rate');
  t.near(costs.modalRate(c), 0.00007016, 1e-12, 'Modal container rate = 4 × core + 8 × GiB');
  t.eq([c.budget.warn_usd, c.budget.hard_stop_usd], [10, 40], 'budget thresholds');

  // Reference table: 1,000 chain items, ~500 foot second opinions + 5% fallback allowance ≈ $5.30.
  const full = costs.estimateCost(c, { sam3Calls: 1000, sam3Hits: 0, fusegnetCalls: 500 + 50, fusegnetHits: 0, vlmCalls: 0, llmCalls: 0 });
  t.near(full.rows[0].usd, 5.0, 1e-9, 'SAM 3: 1,000 × $0.005 = $5.00');
  t.ok(full.rows[1].usd >= 0.15 && full.rows[1].usd <= 0.3, 'FUSegNet ≈ $0.15–0.30', full.rows[1].usd);
  t.near(full.totalUsd, 5.3, 0.15, '1,000 chain items ≈ $5.30');
  const smoke = costs.estimateCost(c, { sam3Calls: 50, sam3Hits: 0, fusegnetCalls: 25 + 3, fusegnetHits: 0, vlmCalls: 0, llmCalls: 0 });
  t.near(smoke.totalUsd, 0.3, 0.05, '50-image smoke ≈ $0.30');
  const allTrigger = costs.estimateCost(c, { sam3Calls: 1000, sam3Hits: 0, fusegnetCalls: 1000 + 50, fusegnetHits: 0, vlmCalls: 0, llmCalls: 0 });
  // Spec: FUSegNet "~$0.25–0.60", total "~$5.60" — the top of that range.
  t.ok(allTrigger.rows[1].usd >= 0.25 && allTrigger.rows[1].usd <= 0.6, '--fusegnet-trigger=all: FUSegNet within $0.25–0.60', allTrigger.rows[1].usd);
  t.ok(allTrigger.totalUsd >= 5.25 && allTrigger.totalUsd <= 5.6, '--fusegnet-trigger=all ≈ $5.25–5.60', allTrigger.totalUsd);
  const cached = costs.estimateCost(c, { sam3Calls: 0, sam3Hits: 1000, fusegnetCalls: 0, fusegnetHits: 550, vlmCalls: 0, llmCalls: 0 });
  t.eq(cached.totalUsd, 0, 'a fully cached re-run costs $0');
  t.ok(costs.estimateCost(c, { sam3Calls: 0, sam3Hits: 0, fusegnetCalls: 0, fusegnetHits: 0, vlmCalls: 5, llmCalls: 0 }).refused?.includes('fill costs.yaml first'), 'gateway rate null → refuse');

  // Budget guard.
  t.eq(costs.budgetDecision(c, 50, null).ok, false, 'estimate above hard_stop refuses without --budget');
  t.eq(costs.budgetDecision(c, 50, 60).ok, true, '--budget=60 allows a $50 estimate');
  t.eq(costs.budgetDecision(c, 50, 45).ok, false, '--budget below the estimate still refuses');
  t.ok(costs.budgetDecision(c, 12, null).message?.startsWith('Warning'), 'above warn_usd → warning');
  t.eq(costs.budgetDecision(c, 1, null).message, null, 'small runs: no warning');

  // planCalls on fixture items: second opinions follow FUSEGNET_TRIGGER and the body zone.
  await ensureFixtures(t);
  const { loadItems } = await t.load<typeof import('../src/ingest')>('../src/ingest.ts');
  const runner = await t.load<typeof import('../src/runner')>('../src/runner.ts');
  const cache = await t.load<typeof import('../src/providerCache')>('../src/providerCache.ts');
  const folder = loadItems('fx-folder'); // bodyZone foot_left
  process.env.FAL_KEY = 'k';
  process.env.FUSEGNET_MODAL_URL = 'https://fuse.example.modal.run';
  const base = { seg: 'chain' as const, boundaries: ['auto' as const], withVlm: false, withReport: false, withBaseline: false, repeat: 0 };
  const foot = runner.planCalls(folder, { ...base, fusegnetTrigger: 'foot' }, { cacheOn: false });
  t.eq(foot.sam3Calls, folder.length, 'one SAM 3 call per chain item');
  t.eq(foot.fusegnetCalls, folder.length + Math.ceil(0.05 * folder.length), 'foot items get a second opinion, plus the 5% fallback allowance');
  const legs = loadItems('fx-class').filter((i) => i.gt.bodyZone !== 'foot_left');
  t.eq(runner.planCalls(legs, { ...base, fusegnetTrigger: 'foot' }, { cacheOn: false }).fusegnetCalls, Math.ceil(0.05 * legs.length), 'no second opinion off the foot');
  t.eq(runner.planCalls(folder, { ...base, seg: 'hsv', fusegnetTrigger: 'all' }, { cacheOn: false }).sam3Calls, 0, 'hsv costs nothing');

  // --- Mid-run: actual spend passes the budget → the run stops cleanly as `interrupted`.
  const io = await t.load<typeof import('../src/io')>('../src/io.ts');
  const { EvalSink } = await t.load<typeof import('../src/sink')>('../src/sink.ts');
  const MODAL = 'https://fuse.example.modal.run';
  const square = new Uint8Array(160 * 120);
  for (let y = 40; y < 80; y += 1) for (let x = 50; x < 110; x += 1) square[y * 160 + x] = 255;
  const net = mockProviders({ maskUri: () => io.maskDataUri(square, 160, 120), modalOrigin: MODAL });
  net.setFal(async () => json(200, { masks: [] })); // SAM 3 finds nothing → FUSegNet fallback (billed)
  cache.installProviderCache({ enabled: false, dir: `${t.tmp}/cost-cache`, realFetch: net.fetch });
  const dear = structuredClone(c);
  dear.providers.sam3.usd_per_request = 1;
  dear.providers.fusegnet.est_seconds_per_call = 1 / costs.modalRate(c); // $1 per Modal call
  dear.providers.fusegnet.cold_start_seconds = 0;
  dear.providers.fusegnet.scaledown_window_seconds = 0;
  const runCfg = {
    runId: 'run-budget-test',
    label: 'budget',
    datasets: ['fx-folder', 'fx-class'],
    seg: 'chain' as const,
    boundaries: ['auto' as const],
    policy: 'image_only' as const,
    arms: ['chain|auto|image_only'],
    seed: 1,
    sample: { total: 6, perDataset: null, splits: null, allocation: {} },
    items: [],
    concurrency: 1,
    falRpm: 0,
    modalRpm: 0,
    fusegnetTrigger: 'none',
    withVlm: false,
    withReport: false,
    withBaseline: false,
    repeat: 0,
    cache: { enabled: false, epoch: 'v1' },
    budgetUsd: 0,
    env: { segmentationProviders: null, tissueRelative: null, sam3Model: 'fal-ai/sam-3/image', fusegnetModelLabel: null },
  };
  // Estimate: 6 SAM 3 ($6) + ceil(5% × 6) = 1 Modal ($1) = $7 ≤ --budget 7.5. Actual: $2 per item (SAM 3 +
  // the FUSegNet fallback), so the 4th item's fallback takes spend to $8 > $7.5 → stop after it finishes.
  const out = await runner.executeRun(runCfg, { costs: dear, budgetFlag: 7.5, sink: new EvalSink(null), quiet: true, log: () => {} });
  t.eq(out?.status, 'interrupted', 'spend past the budget mid-run → status interrupted');
  t.eq(out?.done, 4, 'the run stopped cleanly after the in-flight item, before finishing all 6');
  t.eq(runner.loadRun('run-budget-test').status, 'interrupted', 'run.json records interrupted (resumable)');
  const strict = structuredClone(dear);
  strict.budget.hard_stop_usd = 3;
  await t.throws(
    () => runner.executeRun({ ...runCfg, runId: 'run-budget-test-2' }, { costs: strict, budgetFlag: null, sink: new EvalSink(null), quiet: true, log: () => {} }),
    'an estimate over hard_stop refuses to start without --budget',
    /over budget/,
  );

  // --- Frontier opt-in (E4): estimate printed first, then refused without --yes; null rates refuse outright.
  const priced = structuredClone(c);
  priced.providers.gateway.usd_per_vlm_call = 0.002;
  const logs: string[] = [];
  let gatewayCalls = 0;
  const offline = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    gatewayCalls += 1;
    throw new Error(`no network: ${String(input)}`);
  }) as typeof fetch;
  const vlmCfg = { ...runCfg, runId: 'run-frontier-test', seg: 'hsv' as const, policy: 'image+vlm' as const, arms: ['hsv|auto|image+vlm'], withVlm: true };
  await t.throws(() => runner.executeRun(vlmCfg, { costs: priced, sink: new EvalSink(null), quiet: true, log: (l) => logs.push(l) }), 'a VLM run without --yes is refused', /--yes/);
  t.ok(logs.some((l) => l.includes('cost estimate')) && logs.some((l) => /gateway\s+\d+/.test(l)), 'the cost estimate (with gateway calls) is printed before the refusal', logs);
  await t.throws(() => runner.executeRun({ ...vlmCfg, runId: 'run-frontier-test-2' }, { costs: c, yes: true, sink: new EvalSink(null), quiet: true, log: () => {} }), 'null gateway rate → "fill costs.yaml first"', /fill costs\.yaml first/);
  t.eq(gatewayCalls, 0, 'no frontier call was made');
  globalThis.fetch = offline;

  for (const k of ['FAL_KEY', 'FUSEGNET_MODAL_URL']) process.env[k] = '';
  delete process.env.SEGMENTATION_PROVIDERS;
}
