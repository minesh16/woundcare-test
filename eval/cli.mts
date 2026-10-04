/**
 * MendWise eval harness — entry point (spec §19).
 *
 *   npx tsx eval/cli.mts profile  --dir=<abs> --id=<dataset>
 *   npx tsx eval/cli.mts ingest   --dataset=<id>|all [--dry-run]
 *   npx tsx eval/cli.mts parity
 *   npx tsx eval/cli.mts run      --datasets=<ids>|all [options]      (see eval/README.md)
 *   npx tsx eval/cli.mts estimate --datasets=… [run options]
 *   npx tsx eval/cli.mts score    --run=<runId>
 *   npx tsx eval/cli.mts report   --run=<runId>
 *   npx tsx eval/cli.mts compare  --base=<runId> --head=<runId>
 *   npx tsx eval/cli.mts status   [--run=<runId>]
 *   npx tsx eval/cli.mts cache    stats | clear [--host=fal.run|modal] [--before=<date>]
 *   npx tsx eval/cli.mts negatives                                     (generate synthetic-negatives)
 *
 * Order matters here: the production guard runs first, then `.env.local` is
 * loaded, then the provider response cache wraps `fetch` — all BEFORE any
 * `api/` module is imported (spec §13.7).
 */

// tsx loads the .ts modules as CommonJS. Their named exports appear on the dynamic-import
// namespace; `default` is a module's OWN default export (e.g. an endpoint handler), so it is
// only unwrapped when nothing else was detected.
const load = async <T,>(path: string): Promise<T> => {
  const mod = (await import(path)) as Record<string, unknown>;
  const named = Object.keys(mod).filter((k) => k !== 'default');
  return (named.length === 0 && mod.default && typeof mod.default === 'object' ? mod.default : mod) as T;
};

type Args = { _: string[]; [flag: string]: string | boolean | string[] };

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) {
      out._.push(a);
      continue;
    }
    const key = m[1];
    if (key.startsWith('no-') && m[2] === undefined) out[key.slice(3)] = false;
    else out[key] = m[2] === undefined ? true : m[2];
  }
  return out;
}

const env = await load<typeof import('./src/env')>('./src/env.ts');
try {
  env.productionGuard();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
env.loadEnvLocal();

const args = parseArgs(process.argv.slice(2));
const command = args._[0];

const cache = await load<typeof import('./src/providerCache')>('./src/providerCache.ts');
cache.installProviderCache({ enabled: args.cache !== false, epoch: typeof args['cache-epoch'] === 'string' ? args['cache-epoch'] : 'v1' });

async function main(): Promise<number> {
  switch (command) {
    case 'parity': {
      const { runParity } = await load<typeof import('./src/parity')>('./src/parity.ts');
      const report = await runParity({ verbose: Boolean(args.verbose) });
      for (const c of report.cases) {
        console.log(
          `${c.diffs.length === 0 ? 'ok  ' : 'DIFF'} ${c.id.padEnd(12)} status=${c.status} pathway=${c.pathway ?? '—'} px/cm=${c.pxPerCm?.toFixed(1) ?? '—'} periwound=${c.periwound ? 'yes' : 'no'} tissue=${c.tissue ?? '—'}`,
        );
        for (const d of c.diffs) console.log(`       ${d}`);
      }
      console.log(report.ok ? `parity: ${report.cases.length}/${report.cases.length} identical to runAssessment.` : 'parity: MISMATCH — update eval/src/engineInputs.ts, never the app.');
      return report.ok ? 0 : 1;
    }
    case 'profile': {
      const { profileCommand } = await load<typeof import('./src/profile')>('./src/profile.ts');
      return profileCommand(args);
    }
    case 'ingest': {
      const { ingestCommand } = await load<typeof import('./src/ingest')>('./src/ingest.ts');
      return ingestCommand(args);
    }
    case 'run':
    case 'estimate': {
      const { runCommand } = await load<typeof import('./src/runner')>('./src/runner.ts');
      return runCommand(args, { estimateOnly: command === 'estimate' });
    }
    case 'score': {
      const { scoreCommand } = await load<typeof import('./src/score/index')>('./src/score/index.ts');
      return scoreCommand(args);
    }
    case 'report': {
      const { reportCommand } = await load<typeof import('./src/report')>('./src/report.ts');
      return reportCommand(args);
    }
    case 'compare': {
      const { compareCommand } = await load<typeof import('./src/compare')>('./src/compare.ts');
      return compareCommand(args);
    }
    case 'status': {
      const { statusCommand } = await load<typeof import('./src/runner')>('./src/runner.ts');
      return statusCommand(args);
    }
    case 'cache':
      return cache.cacheCommand(args);
    case 'negatives': {
      const { generateNegatives } = await load<typeof import('./src/negatives')>('./src/negatives.ts');
      return generateNegatives(args);
    }
    default:
      console.log('usage: npx tsx eval/cli.mts <profile|ingest|parity|run|estimate|score|report|compare|status|cache|negatives> [--flags]  (see eval/README.md)');
      return command ? 2 : 0;
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
}
