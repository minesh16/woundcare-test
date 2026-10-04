/**
 * Cost: rates, estimator and budget guard (spec §13.6). `eval/costs.yaml` is
 * committed pre-filled; this file only does arithmetic on it. Estimates only —
 * the provider dashboards are the source of truth for billing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { EVAL_ROOT } from './env';

const Costs = z.object({
  currency: z.string(),
  providers: z.object({
    sam3: z.object({ billing: z.literal('per_request'), usd_per_request: z.number() }).passthrough(),
    fusegnet: z
      .object({
        billing: z.literal('per_second'),
        cpu_cores: z.number(),
        memory_gib: z.number(),
        usd_per_core_second: z.number(),
        usd_per_gib_second: z.number(),
        est_seconds_per_call: z.number(),
        cold_start_seconds: z.number(),
        scaledown_window_seconds: z.number(),
        region_multiplier: z.number().default(1),
      })
      .passthrough(),
    gateway: z.object({ usd_per_vlm_call: z.number().nullable(), usd_per_llm_call: z.number().nullable() }).passthrough(),
  }),
  budget: z.object({ warn_usd: z.number(), hard_stop_usd: z.number() }),
});
export type Costs = z.infer<typeof Costs>;

export function loadCosts(path = join(EVAL_ROOT, 'costs.yaml')): Costs {
  return Costs.parse(parseYaml(readFileSync(path, 'utf8')));
}

/** USD per second of the Modal container: cores × core rate + GiB × memory rate. */
export function modalRate(c: Costs): number {
  const f = c.providers.fusegnet;
  return (f.cpu_cores * f.usd_per_core_second + f.memory_gib * f.usd_per_gib_second) * f.region_multiplier;
}

/** Modal USD for `calls` billed calls in `bursts` warm-up windows. */
export function modalCost(c: Costs, calls: number, bursts = calls > 0 ? 1 : 0): number {
  const f = c.providers.fusegnet;
  return modalRate(c) * (calls * f.est_seconds_per_call + bursts * (f.cold_start_seconds + f.scaledown_window_seconds));
}

export type CallPlan = {
  sam3Calls: number;
  sam3Hits: number;
  fusegnetCalls: number;
  fusegnetHits: number;
  vlmCalls: number;
  llmCalls: number;
};

export type CostRow = { provider: 'sam3' | 'fusegnet' | 'gateway'; calls: number; cacheHits: number; usd: number };
export type CostEstimate = { rows: CostRow[]; totalUsd: number; refused: string | null };

export function estimateCost(c: Costs, plan: CallPlan): CostEstimate {
  const gw = c.providers.gateway;
  let refused: string | null = null;
  let gatewayUsd = 0;
  if (plan.vlmCalls > 0) {
    if (gw.usd_per_vlm_call === null) refused = 'fill costs.yaml first: providers.gateway.usd_per_vlm_call is null';
    else gatewayUsd += plan.vlmCalls * gw.usd_per_vlm_call;
  }
  if (plan.llmCalls > 0) {
    if (gw.usd_per_llm_call === null) refused = 'fill costs.yaml first: providers.gateway.usd_per_llm_call is null';
    else gatewayUsd += plan.llmCalls * gw.usd_per_llm_call;
  }
  const rows: CostRow[] = [
    { provider: 'sam3', calls: plan.sam3Calls, cacheHits: plan.sam3Hits, usd: plan.sam3Calls * c.providers.sam3.usd_per_request },
    { provider: 'fusegnet', calls: plan.fusegnetCalls, cacheHits: plan.fusegnetHits, usd: modalCost(c, plan.fusegnetCalls) },
    { provider: 'gateway', calls: plan.vlmCalls + plan.llmCalls, cacheHits: 0, usd: gatewayUsd },
  ];
  return { rows, totalUsd: rows.reduce((a, r) => a + r.usd, 0), refused };
}

export function formatEstimate(e: CostEstimate, currency = 'USD'): string {
  const lines = [`provider   calls  cache hits  est. ${currency}`, ...e.rows.map((r) => `${r.provider.padEnd(9)} ${String(r.calls).padStart(6)} ${String(r.cacheHits).padStart(11)}  ${r.usd.toFixed(2).padStart(9)}`)];
  lines.push(`${'total'.padEnd(9)} ${''.padStart(6)} ${''.padStart(11)}  ${e.totalUsd.toFixed(2).padStart(9)}`);
  return lines.join('\n');
}

/** Spec §13.6: warn above warn_usd; above hard_stop_usd refuse unless --budget covers it. */
export function budgetDecision(c: Costs, estimateUsd: number, budgetFlag: number | null): { ok: boolean; budget: number; message: string | null } {
  const budget = budgetFlag ?? c.budget.hard_stop_usd;
  if (estimateUsd > budget) {
    return {
      ok: false,
      budget,
      message:
        budgetFlag === null
          ? `Estimated $${estimateUsd.toFixed(2)} exceeds budget.hard_stop_usd ($${c.budget.hard_stop_usd}). Re-run with --budget=<usd> to allow it.`
          : `Estimated $${estimateUsd.toFixed(2)} exceeds --budget=$${budgetFlag}.`,
    };
  }
  return {
    ok: true,
    budget,
    message: estimateUsd > c.budget.warn_usd ? `Warning: estimated $${estimateUsd.toFixed(2)} is above budget.warn_usd ($${c.budget.warn_usd}).` : null,
  };
}

/**
 * Live spend from real (missed) calls. The first Modal call of a run also
 * books one cold-start + scaledown window, as the estimator does.
 */
export class SpendTracker {
  usd = 0;
  calls = { fal: 0, modal: 0 };
  private modalBurstBooked = false;
  constructor(private costs: Costs, private budget: number) {}
  record(kind: 'fal' | 'modal'): void {
    this.calls[kind] += 1;
    if (kind === 'fal') this.usd += this.costs.providers.sam3.usd_per_request;
    else {
      const f = this.costs.providers.fusegnet;
      this.usd += modalRate(this.costs) * f.est_seconds_per_call;
      if (!this.modalBurstBooked) {
        this.modalBurstBooked = true;
        this.usd += modalRate(this.costs) * (f.cold_start_seconds + f.scaledown_window_seconds);
      }
    }
  }
  get exceeded(): boolean {
    return this.usd > this.budget;
  }
  byProvider(): { sam3: number; fusegnet: number } {
    return { sam3: this.calls.fal * this.costs.providers.sam3.usd_per_request, fusegnet: this.calls.modal ? modalCost(this.costs, this.calls.modal) : 0 };
  }
}
