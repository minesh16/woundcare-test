/** §21.5 — the sampler is deterministic for a seed and respects quotas. */
import type { T } from './run.mts';

export default async function (t: T) {
  const { sampleItems, apportion, pickStratified, parsePerDataset } = await t.load<typeof import('../src/sample')>('../src/sample.ts');
  const mk = (ds: string, n: number, types: string[]) =>
    Array.from({ length: n }, (_, i) => ({
      id: `${ds}:${String(i).padStart(4, '0')}`,
      datasetId: ds,
      key: String(i),
      split: i % 4 === 0 ? 'test' : 'train',
      imageSha256: `${ds}${i}`,
      dhash: '',
      relPath: '',
      normPath: '',
      width: 1,
      height: 1,
      gt: { rawLabels: {}, woundType: types[i % types.length] },
      strata: { woundType: types[i % types.length], split: i % 4 === 0 ? 'test' : 'train' },
      duplicateOf: i === 5 ? `${ds}:0000` : null,
    })) as never[];
  const items = { a: mk('a', 400, ['venous', 'pressure']), b: mk('b', 50, ['diabetic_foot']), c: mk('c', 10, ['other']) };
  const manifests = { a: { sample_weight: 1, strata: ['split'] }, b: { sample_weight: 1, strata: [] }, c: { sample_weight: 1, strata: [] } };

  const s1 = sampleItems(items, manifests, { datasets: ['a', 'b', 'c'], sample: 120, seed: 42 });
  const s2 = sampleItems(items, manifests, { datasets: ['a', 'b', 'c'], sample: 120, seed: 42 });
  const s3 = sampleItems(items, manifests, { datasets: ['a', 'b', 'c'], sample: 120, seed: 43 });
  const ids = (s: typeof s1) => s.items.map((i: { id: string }) => i.id);
  t.eq(ids(s1), ids(s2), 'same seed + items → same list');
  t.ok(JSON.stringify(ids(s1)) !== JSON.stringify(ids(s3)), 'a different seed → a different list');
  t.eq(s1.items.length, 120, 'total respected');
  t.eq(s1.allocation.c.chosen, 9, 'floor of min(30, available) for a small dataset (10 minus 1 duplicate)');
  t.eq(s1.allocation.b.chosen >= 30, true, 'floor of 30 for b');
  t.ok(!ids(s1).includes('a:0005'), 'duplicates are skipped');

  // Stratification: woundType halves in a, so a stratified pick is ~half each.
  const aPick = s1.items.filter((i: { datasetId: string }) => i.datasetId === 'a') as { gt: { woundType: string } }[];
  const venous = aPick.filter((i) => i.gt.woundType === 'venous').length;
  t.ok(Math.abs(venous - aPick.length / 2) <= 1, 'stratified by woundType', { venous, of: aPick.length });

  const quota = sampleItems(items, manifests, { datasets: ['a', 'b'], perDataset: parsePerDataset('a:25,b:60'), seed: 1 });
  t.eq([quota.allocation.a.chosen, quota.allocation.b.chosen], [25, 49], 'per-dataset quotas, capped at availability (49 eligible)');
  const split = sampleItems(items, manifests, { datasets: ['a'], seed: 1, splits: ['test'] });
  t.ok(split.items.every((i: { split: string }) => i.split === 'test') && split.items.length === 100, '--split filters items', split.items.length);
  const all = sampleItems(items, manifests, { datasets: ['a', 'b', 'c'], seed: 1 });
  t.eq(all.items.length, 399 + 49 + 9, 'no --sample → every eligible item');

  t.eq(apportion(10, [1, 1, 1], [10, 10, 10]).reduce((a: number, b: number) => a + b, 0), 10, 'apportion sums to the total');
  t.eq(apportion(10, [1, 1], [2, 100]), [2, 8], 'apportion spills past a cap');
  t.eq(pickStratified(items.c as never, 3, [], 7, 'c').length, 3, 'pickStratified size');
}
