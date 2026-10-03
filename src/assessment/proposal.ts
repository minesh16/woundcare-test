import type { SegmentResponse } from '@/assessment/client';
import type { BoundaryProposal } from '@/decision/types';

/** A `/segment` response as the session's boundary proposal (used by analyze and review). */
export function toBoundaryProposal(seg: SegmentResponse): BoundaryProposal {
  const opinion = seg.secondOpinion;
  return {
    maskUrl: seg.mask,
    source: seg.source,
    provider: seg.provider,
    model: seg.model ?? null,
    outline: seg.outline ?? null,
    areaPx: seg.areaPx,
    areaPct: seg.areaPx && seg.totalPx ? Number(((100 * seg.areaPx) / seg.totalPx).toFixed(2)) : null,
    multipleRegions: seg.multipleRegions ?? null,
    confidence: seg.confidence,
    score: seg.score,
    frame: seg.frame ?? null,
    secondOpinion:
      opinion?.status === 'ok'
        ? {
            status: 'ok',
            model: opinion.model,
            maskUrl: opinion.mask,
            outline: opinion.outline,
            agreementIoU: opinion.agreementIoU,
            regions: opinion.regions,
            meanProb: opinion.meanProb,
            latencyMs: opinion.latencyMs,
          }
        : opinion?.status === 'unavailable'
          ? { status: 'unavailable', reason: opinion.reason }
          : null,
    promptConflict: seg.promptConflict,
    reason: seg.reason ?? null,
  };
}
