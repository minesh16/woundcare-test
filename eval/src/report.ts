/**
 * Findings (spec §16): findings.json, findings.md (template-filled — no LLM
 * text), items.csv, metrics.csv and confusion/*.csv, in EVAL_OUT_DIR/<runId>/.
 *
 *   npx tsx eval/cli.mts report --run=<runId> [--baseline=<runId>]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { latestResults, loadRun, runDir } from './runner';
import { FINDINGS_SCHEMA, type MetricRow } from './schema';
import { ITA_NOTE } from './score/fairness';
import type { ScoreResult } from './score/index';
import { dominantConfusion } from './score/tissue';
import { namesDressing } from './score/vlm';

const fmt = (v: number | null | undefined, digits = 3) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : Number(v.toFixed(digits)).toString());
const pct = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${(100 * v).toFixed(1)}%`);
const ci = (m: MetricRow | undefined, asPct = false) => {
  if (!m || m.value === null) return '—';
  const f = asPct ? pct : (x: number | null) => fmt(x);
  return `${f(m.value)}${m.ciLow !== null && m.ciHigh !== null ? ` [${f(m.ciLow)}, ${f(m.ciHigh)}]` : ''}`;
};

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';

function find(metrics: MetricRow[], arm: string, area: string, metric: string, scope = 'overall') {
  return metrics.find((m) => m.arm === arm && m.area === area && m.metric === metric && m.scope === scope);
}

export function writeReport(runId: string, result: ScoreResult, opts: { baselineRunId?: string } = {}): { json: string; md: string } {
  const dir = runDir(runId);
  mkdirSync(join(dir, 'confusion'), { recursive: true });
  const { run, metrics, gates, items } = result;
  const cfg = run.config;
  const counts = (run.counts ?? {}) as Record<string, unknown> & {
    ok?: number;
    failed?: number;
    fal_calls?: number;
    modal_calls?: number;
    cache_hits?: { fal?: number; modal?: number };
    est_usd?: Record<string, number>;
  };

  // --- Notes
  const notes: string[] = [];
  if (cfg.policy === 'image_only') {
    notes.push('Pathway metrics not available under image_only (engine correctly withholds without exudate/infection). See the gate behaviour section; use --with-vlm or --policy=label-axes for decision metrics.');
  }
  const inDistDatasets = cfg.datasets.filter((d) => result.manifests[d]?.known_training_use.includes('fusegnet'));
  if (inDistDatasets.length) {
    notes.push(`FUSegNet metrics on ${inDistDatasets.join('/')} are in-distribution (FUSegNet was trained on AZH-clinic data). They are tagged in_distribution and never folded into the generalisation figure (scope in_distribution=false).`);
  }
  notes.push(`Skin tone is an ITA° proxy: ${ITA_NOTE}.`);
  if (result.iouCrossCheck) notes.push(`IoU cross-check vs the app's compareMasks on ${result.iouCrossCheck.item}: harness ${fmt(result.iouCrossCheck.harness, 6)}, app ${fmt(result.iouCrossCheck.app, 6)}.`);

  // --- Baseline comparison (optional)
  let baselineComparison: Record<string, unknown> | null = null;
  if (opts.baselineRunId) {
    const texts = [...latestResults(opts.baselineRunId).values()].map((r) => r.prediction?.baseline?.text).filter((t): t is string => typeof t === 'string');
    const arm = cfg.arms[0];
    baselineComparison = {
      baselineRun: opts.baselineRunId,
      baselineAnswers: texts.length,
      baselineNamesDressingRate: texts.length ? texts.filter(namesDressing).length / texts.length : null,
      mendwiseCompletionRate: find(metrics, arm, 'engine', 'completion_rate')?.value ?? null,
      mendwiseWithheldRate: find(metrics, arm, 'engine', 'withheld_rate')?.value ?? null,
      note: 'The baseline is stored verbatim and never scored for correctness or sent to an LLM judge (spec §14.7).',
    };
  }

  // --- Datasets
  const datasets = cfg.datasets.map((d) => {
    const m = result.manifests[d];
    const c = result.coverage[d];
    return {
      id: d,
      n: items.filter((s) => s.item.datasetId === d && s.arm === cfg.arms[0]).length,
      licence: m?.licence ?? null,
      source_url: m?.source_url ?? null,
      in_distribution_for: m?.known_training_use ?? [],
      coverage: c?.fieldCoverage ?? null,
    };
  });

  // --- Failures: worst segmentation items
  const segFailures = items
    .filter((s) => typeof s.m['seg.dice'] === 'number')
    .sort((a, b) => (a.m['seg.dice'] as number) - (b.m['seg.dice'] as number))
    .slice(0, 15)
    .map((s) => ({
      item: s.item.id,
      arm: s.arm,
      dice: Number((s.m['seg.dice'] as number).toFixed(4)),
      source: s.pred?.segmentation.source ?? null,
      plausibility: s.pred?.segmentation.plausibility ?? null,
      reason: s.pred?.segmentation.attempts.filter((a) => a.status !== 'ok' && a.status !== 'skipped').map((a) => `${a.provider} ${a.status}${a.reason ? `: ${a.reason}` : ''}`).join('; ') || null,
      mask: s.pred?.maskPath ?? null,
    }));
  const failedItems = items.filter((s) => s.row.status === 'failed').slice(0, 20).map((s) => ({ item: s.item.id, arm: s.arm, error: s.row.error ?? null }));

  const findings = {
    schema: FINDINGS_SCHEMA,
    run: {
      id: run.id,
      label: run.label,
      git_sha: run.gitSha,
      git_dirty: run.gitDirty,
      rules_version: run.rulesVersion,
      model_versions: run.modelVersions,
      arms: cfg.arms,
      policy: cfg.policy,
      seed: cfg.seed,
      started: run.startedAt,
      finished: run.finishedAt,
      status: run.status,
      counts: run.counts,
    },
    datasets,
    gates,
    metrics: metrics.map((m) => ({
      area: m.area,
      metric: m.metric,
      scope: m.scope,
      arm: m.arm,
      value: m.value,
      ci_low: m.ciLow,
      ci_high: m.ciHigh,
      n: m.n,
      na_rate: m.naRate,
      in_distribution: m.inDistribution,
    })),
    failures: { seg: segFailures, items: failedItems },
    fairness: { scale: 'ita_proxy', note: ITA_NOTE, max_gap: result.fairness[cfg.arms[0]]?.maxGap ?? {}, suppressed: result.fairness[cfg.arms[0]]?.suppressed ?? {}, by_arm: result.fairness },
    notes,
    baseline_comparison: baselineComparison,
  };
  const jsonPath = join(dir, 'findings.json');
  writeFileSync(jsonPath, JSON.stringify(findings, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v), 2));

  // --- metrics.csv (long format) and items.csv
  writeFileSync(
    join(dir, 'metrics.csv'),
    csv([
      ['run_id', 'arm', 'area', 'metric', 'scope', 'value', 'ci_low', 'ci_high', 'n', 'na_rate', 'in_distribution'],
      ...metrics.map((m) => [m.runId, m.arm, m.area, m.metric, m.scope, m.value, m.ciLow, m.ciHigh, m.n, m.naRate, m.inDistribution]),
    ]),
  );
  const metricKeys = [...new Set(items.flatMap((s) => Object.keys(s.m)))].sort();
  writeFileSync(
    join(dir, 'items.csv'),
    csv([
      ['item_id', 'dataset', 'arm', 'status', 'in_distribution', 'wound_type', 'gt_woundPresent', 'seg_source', 'seg_model', 'seg_score', 'seg_confidence', 'plausibility', 'woundPresent', 'mask_path', 'tissue_pct', 'dominant_tissue', 'gt_dominant_tissue', 'engine_status', 'pathway', 'gate_codes', 'skin_tone', 'error', ...metricKeys],
      ...items.map((s) => {
        const p = s.pred;
        return [
          s.item.id,
          s.item.datasetId,
          s.arm,
          s.row.status,
          s.inDist,
          s.item.gt.woundType ?? '',
          s.item.gt.woundPresent ?? '',
          p?.segmentation.source ?? '',
          p?.segmentation.model ?? '',
          p?.segmentation.score ?? '',
          p?.segmentation.confidence ?? '',
          p?.segmentation.plausibility ?? '',
          p?.woundPresent ?? '',
          p?.maskPath ?? '',
          p?.tissuePct ?? '',
          p?.dominantTissue ?? '',
          s.item.gt.dominantTissue ?? '',
          p?.engine.status ?? '',
          p?.engine.cwcsPathwayId ?? '',
          p?.engine.gateCodes.join(';') ?? '',
          s.scopes.find((x) => x.startsWith('skinTone='))?.slice(9) ?? '',
          s.row.error ?? '',
          ...metricKeys.map((k) => s.m[k] ?? ''),
        ];
      }),
    ]),
  );

  // --- Confusion matrices
  for (const arm of cfg.arms) {
    const conf = dominantConfusion(items.filter((s) => s.arm === arm));
    const total = Object.values(conf.matrix).reduce((a, r) => a + Object.values(r).reduce((x, y) => x + y, 0), 0);
    if (total) {
      writeFileSync(
        join(dir, 'confusion', `dominant_tissue${cfg.arms.length > 1 ? `__${arm.replace(/[|+]/g, '_')}` : ''}.csv`),
        csv([['gt \\ predicted', ...conf.labels], ...Object.entries(conf.matrix).map(([g, r]) => [g, ...conf.labels.map((l) => r[l])])]),
      );
    }
    for (const axis of ['exudate', 'infection'] as const) {
      const pairs = items.filter((s) => s.arm === arm && s.item.gt[axis] && s.pred);
      if (!pairs.length || cfg.policy === 'image_only') continue;
      const labels = [...new Set([...pairs.map((s) => String(s.item.gt[axis])), ...pairs.map((s) => String(s.pred![axis] ?? 'null'))])].sort();
      const matrix = labels.map((g) => [g, ...labels.map((p) => pairs.filter((s) => String(s.item.gt[axis]) === g && String(s.pred![axis] ?? 'null') === p).length)]);
      writeFileSync(join(dir, 'confusion', `${axis}${cfg.arms.length > 1 ? `__${arm.replace(/[|+]/g, '_')}` : ''}.csv`), csv([['gt \\ predicted', ...labels], ...matrix]));
    }
  }

  // --- findings.md
  const L: string[] = [];
  const est = Object.values(counts.est_usd ?? {}).reduce((a, b) => a + (b ?? 0), 0);
  L.push(`# MendWise evaluation findings — ${run.id}`, '');
  L.push('Generated by the eval harness from template (no LLM-written text). Research prototype — not a medical device.', '');
  L.push('## 1. Run summary', '');
  L.push(`| | |`, `|---|---|`);
  L.push(`| run | \`${run.id}\` (${run.status}) |`);
  L.push(`| label | ${run.label ?? '—'} |`);
  L.push(`| git | \`${run.gitSha?.slice(0, 12) ?? '—'}\`${run.gitDirty ? ' (dirty)' : ''} |`);
  L.push(`| rules version | ${run.rulesVersion} |`);
  L.push(`| models | ${Object.entries(run.modelVersions).map(([k, v]) => `${k}: ${v ?? '—'}`).join(' · ')} |`);
  L.push(`| arms | ${cfg.arms.map((a) => `\`${a}\``).join(', ')} |`);
  L.push(`| datasets | ${Object.entries(cfg.sample.allocation).map(([d, a]) => `${d} ${a.chosen}/${a.available}`).join(', ') || cfg.datasets.join(', ')} |`);
  L.push(`| items | ${cfg.items.length} (seed ${cfg.seed}) — ok ${counts.ok ?? '—'}, failed ${counts.failed ?? '—'} |`);
  L.push(`| started / finished | ${run.startedAt} / ${run.finishedAt ?? '—'} |`, '');
  L.push('## 2. Gates', '', '| gate | arm | status | value [95% CI] | n | target |', '|---|---|---|---|---|---|');
  for (const g of gates) L.push(`| ${g.id} | \`${g.arm}\` | **${g.status}** | ${fmt(g.value)}${g.ci[0] !== null ? ` [${fmt(g.ci[0])}, ${fmt(g.ci[1])}]` : ''} | ${g.n} | ${g.target} |`);
  L.push('', 'Gates are team-agreed starting points (eval/thresholds.yaml); INSUFFICIENT_N means n < min_n, NOT_RUN means this policy does not produce the metric.', '');

  for (const arm of cfg.arms) {
    const isAuto = arm.split('|')[1] === 'auto';
    L.push(`## 3. Segmentation — \`${arm}\``, '');
    if (!isAuto) L.push('Ground-truth boundary arm: segmentation is not scored here (the boundary IS the ground truth).', '');
    else {
      L.push('| scope | n | Dice mean [CI] | IoU mean [CI] | HD95 % diag (median) | boundary F1 | fallback | implausible | in-dist |', '|---|---|---|---|---|---|---|---|---|');
      const scopes = [...new Set(metrics.filter((m) => m.arm === arm && m.area === 'seg' && m.metric === 'dice.mean').map((m) => m.scope))].sort((a, b) => (a === 'overall' ? -1 : b === 'overall' ? 1 : a.localeCompare(b)));
      for (const sc of scopes) {
        const d = find(metrics, arm, 'seg', 'dice.mean', sc);
        L.push(
          `| ${sc} | ${d?.n ?? '—'} | ${ci(d)} | ${ci(find(metrics, arm, 'seg', 'iou.mean', sc))} | ${fmt(find(metrics, arm, 'seg', 'hd95_pct_diag.median', sc)?.value, 2)} | ${fmt(find(metrics, arm, 'seg', 'boundary_f1.mean', sc)?.value)} | ${pct(find(metrics, arm, 'seg', 'fallback_rate', sc)?.value)} | ${pct(find(metrics, arm, 'seg', 'implausible_rate', sc)?.value)} | ${d?.inDistribution ? '⚠ yes' : 'no'} |`,
        );
      }
      L.push('');
      const gen = find(metrics, arm, 'seg', 'dice.mean', 'in_distribution=false');
      L.push(`**Generalisation figure** (scope \`in_distribution=false\`): Dice ${ci(gen)}, n = ${gen?.n ?? 0}. Rows marked ⚠ include FUSegNet boundaries on data FUSegNet was trained on and must not be quoted as generalisation.`, '');
      const neg = find(metrics, arm, 'seg', 'negatives_fp_rate');
      L.push(`Negatives false-positive rate (plausible mask on a non-wound image): ${ci(neg, true)}, n = ${neg?.n ?? 0}. FUSegNet has no abstain.`);
      const conf = ['high', 'medium', 'low'].map((c) => `${c}: IoU ${fmt(find(metrics, arm, 'seg', 'iou.mean', `confidence=${c}`)?.value)} (n=${find(metrics, arm, 'seg', 'iou.mean', `confidence=${c}`)?.n ?? 0})`);
      L.push(`Calibration — mean IoU by confidence band: ${conf.join(' · ')}.`);
      const t7 = find(metrics, arm, 'seg', 'calib.advisory_threshold_iou_0_7');
      if (t7) L.push(`Advisory only (the app is not changed): a SAM 3 score threshold of ${fmt(t7.value)} best separates IoU ≥ 0.7 (spec ${fmt(t7.ciLow)}, sens ${fmt(t7.ciHigh)}), vs the app's placeholder 0.80/0.50 bands.`);
      const so = find(metrics, arm, 'seg', 'second_opinion.spearman');
      if (so) L.push(`Second opinion: Spearman(agreement IoU, true IoU) = ${fmt(so.value)}, AUROC for IoU < 0.5 = ${fmt(find(metrics, arm, 'seg', 'second_opinion.auroc_iou_lt_0_5')?.value)} (n=${so.n}).`);
      L.push('');
    }

    L.push(`## 4. Tissue — \`${arm}\``, '');
    const mae = find(metrics, arm, 'tissue', 'absolute.mae_mean.mean');
    const rel = find(metrics, arm, 'tissue', 'relative.mae_mean.mean');
    L.push(`Per-class MAE (pp, labelled classes only, renormalised): absolute ${ci(mae)} (n=${mae?.n ?? 0}); relative ${ci(rel)} (n=${rel?.n ?? 0}). Advisory input to the TISSUE_RELATIVE decision.`);
    L.push(`Sentinel (20/20/20/20/20 "nothing considered") rate: ${ci(find(metrics, arm, 'tissue', 'sentinel_rate'), true)}.`);
    const acc = find(metrics, arm, 'tissue', 'dominant_accuracy');
    L.push(`Dominant tissue (engine precedence): accuracy ${ci(acc, true)} over non-withheld items (n=${acc?.n ?? 0}); abstention ${ci(find(metrics, arm, 'tissue', 'dominant_abstain_rate'), true)}; κ ${fmt(find(metrics, arm, 'tissue', 'dominant_kappa')?.value)}; macro-F1 ${fmt(find(metrics, arm, 'tissue', 'dominant_macro_f1')?.value)}.`, '');

    L.push(`## 5. Engine behaviour — \`${arm}\``, '');
    L.push(`Completion ${ci(find(metrics, arm, 'engine', 'completion_rate'), true)} · withheld ${ci(find(metrics, arm, 'engine', 'withheld_rate'), true)} · any urgent referral ${pct(find(metrics, arm, 'engine', 'any_urgent_referral_rate')?.value)}.`);
    const gatesRows = metrics.filter((m) => m.arm === arm && m.area === 'engine' && m.metric.startsWith('gate_rate.'));
    if (gatesRows.length) L.push(`Gate codes: ${gatesRows.map((m) => `\`${m.metric.slice(10)}\` ${pct(m.value)}`).join(', ')}.`);
    const reasons = metrics.filter((m) => m.arm === arm && m.area === 'engine' && m.metric.startsWith('incomplete_reason:'));
    if (reasons.length) L.push('', 'Top incomplete reasons:', ...reasons.map((m) => `- ${m.metric.slice(18)} — ${pct(m.value)}`));
    if (cfg.policy !== 'image_only') {
      L.push('', `Axis accuracy: exudate ${ci(find(metrics, arm, 'engine', 'exudate_accuracy'), true)}, infection ${ci(find(metrics, arm, 'engine', 'infection_accuracy'), true)}. Pathway exact match ${ci(find(metrics, arm, 'engine', 'pathway_exact_match'), true)}. Urgent-referral sensitivity ${ci(find(metrics, arm, 'engine', 'urgent_referral_sensitivity'), true)}; over-referral ${ci(find(metrics, arm, 'engine', 'over_referral_rate'), true)}; unsafe-confident ${ci(find(metrics, arm, 'engine', 'unsafe_confident_rate'), true)}.`);
    }
    const replay = find(metrics, arm, 'engine', 'replay_consistency');
    if (replay) L.push(`Engine replay consistency on GT axes: ${pct(replay.value)} (n=${replay.n})${replay.value !== null && replay.value < 1 ? ' — **below 100%: a harness or table-transcription bug; see eval/NOTES.md**' : ''}.`);
    L.push('');

    L.push(`## 6. Fairness — \`${arm}\``, '');
    L.push(`Skin tone is an ITA° proxy (${ITA_NOTE}). Bands with n < 10 are suppressed.`, '');
    // Bands only (the fairness gap rows carry a `hi-vs-lo` scope); each cell is suppressed on its OWN n.
    const bands = [...new Set(metrics.filter((m) => m.arm === arm && m.scope.startsWith('skinTone=') && !m.scope.includes('-vs-')).map((m) => m.scope))].sort();
    const cell = (m: MetricRow | undefined, asPct: boolean) => (!m || m.value === null ? '—' : m.n < 10 ? `(n=${m.n})` : `${asPct ? pct(m.value) : fmt(m.value)} (n=${m.n})`);
    if (bands.length) {
      L.push('| band | Dice | tissue MAE (pp) | dominant acc. | negatives FP |', '|---|---|---|---|---|');
      for (const b of bands) {
        L.push(
          `| ${b.slice(9)} | ${cell(find(metrics, arm, 'seg', 'dice.mean', b), false)} | ${cell(find(metrics, arm, 'tissue', 'absolute.mae_mean.mean', b), false)} | ${cell(find(metrics, arm, 'tissue', 'dominant_accuracy', b), true)} | ${cell(find(metrics, arm, 'seg', 'negatives_fp_rate', b), true)} |`,
        );
      }
      L.push('', 'Cells with n < 10 show only their n (suppressed).', '');
    }
    const gaps = metrics.filter((m) => m.arm === arm && m.area === 'fairness');
    for (const g of gaps) L.push(`- largest gap in ${g.metric.slice(8)}: ${fmt(g.value)} [${fmt(g.ciLow)}, ${fmt(g.ciHigh)}] (${g.scope.slice(9)})`);
    L.push('');
  }

  L.push('## 7. Ops and cost', '');
  const arm0 = cfg.arms[0];
  const lat = ['segment', 'measure', 'evaluate', 'total'].map((st) => `${st} p50 ${fmt(find(metrics, arm0, 'ops', `latency_ms.${st}.p50`)?.value, 0)} / p90 ${fmt(find(metrics, arm0, 'ops', `latency_ms.${st}.p90`)?.value, 0)} ms`);
  L.push(`Latency: ${lat.join(' · ')}.`);
  L.push(`Throughput: ${fmt(find(metrics, arm0, 'ops', 'throughput_items_per_min')?.value, 1)} items/min.`);
  L.push(
    `Cost: SAM 3 billed calls ${counts.fal_calls ?? 0} (cache hits ${counts.cache_hits?.fal ?? 0}), FUSegNet billed calls ${counts.modal_calls ?? 0} (cache hits ${counts.cache_hits?.modal ?? 0}); estimated **$${est.toFixed(2)}** at eval/costs.yaml rates (estimates only — provider dashboards are the source of truth).`,
    '',
  );

  L.push('## 8. Top failures', '');
  if (segFailures.length) {
    L.push('| item | arm | Dice | source | plausibility | why | mask |', '|---|---|---|---|---|---|---|');
    for (const f of segFailures) L.push(`| \`${f.item}\` | \`${f.arm}\` | ${f.dice} | ${f.source ?? '—'} | ${f.plausibility ?? '—'} | ${f.reason ?? '—'} | ${f.mask ? `\`${f.mask}\`` : '—'} |`);
  } else L.push('No scored segmentation items.');
  if (failedItems.length) L.push('', 'Failed items:', ...failedItems.map((f) => `- \`${f.item}\` (${f.arm}): ${f.error}`));
  L.push('');

  L.push('## 9. Limitations', '');
  L.push(
    '- **No clinician in the loop.** The model draft is used exactly as returned (the `auto` arm); the app always puts a clinician review between segmentation and measurement.',
    '- **Public data.** Strong on segmentation (FUSeg) and wound type; thin on exudate and infection; almost no coin/ruler measurements, so measurement metrics are N/A until the team\'s own data is onboarded.',
    '- **Contamination.** FUSegNet was trained on AZH-clinic data; its metrics on FUSeg/AZH are in-distribution and reported separately.',
    `- **Skin tone** is an ITA° proxy (${ITA_NOTE}).`,
    `- **Engine policy \`${cfg.policy}\`.** ${cfg.policy === 'image_only' ? 'Without exudate/infection the engine withholds a pathway on nearly every item — that is the correct, conservative behaviour, and decision metrics are NOT_RUN.' : 'Decision metrics depend on the axes this policy supplies.'}`,
    '- Any number quoted outside this file must cite the run id above and carry the contamination note.',
    '',
  );
  if (notes.length) L.push('## Notes', '', ...notes.map((n) => `- ${n}`), '');
  if (baselineComparison) L.push('## Baseline comparison', '', '```json', JSON.stringify(baselineComparison, null, 2), '```', '');
  const mdPath = join(dir, 'findings.md');
  writeFileSync(mdPath, L.join('\n'));
  return { json: jsonPath, md: mdPath };
}

export async function reportCommand(args: Record<string, unknown>): Promise<number> {
  const runId = typeof args.run === 'string' ? args.run : null;
  if (!runId) {
    console.error('usage: npx tsx eval/cli.mts report --run=<runId> [--baseline=<runId>]');
    return 2;
  }
  loadRun(runId);
  const { scoreRun } = await import('./score/index');
  const result = await scoreRun(runId, { sink: null, persist: false });
  const paths = writeReport(runId, result, { baselineRunId: typeof args.baseline === 'string' ? args.baseline : undefined });
  console.log(`findings → ${paths.md}\n           ${paths.json}`);
  return 0;
}
