/**
 * Phase 0 rules-engine tests (no native deps).
 * Run: npm run test:rules   (node --experimental-strip-types)
 *
 * Asserts: all 26 CWCS pathways, tissue precedence, Mölnlycke triggers,
 * and end-to-end engine behaviour incl. safety/confidence gates.
 */
import {
  CWCS_PATHWAYS,
  evaluate,
  lookupPathway,
  molnlyckeFlags,
  reconcileTissue,
} from '../src/decision/engine.ts';
import type { ExudateLevel, Infection, TissueBreakdown, TissueType } from '../src/decision/engine.types.ts';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error('FAIL', name, detail !== undefined ? JSON.stringify(detail) : '');
  }
}

function bed(p: Partial<TissueBreakdown>): TissueBreakdown {
  return { necrosis: 0, slough: 0, granulation: 0, epithelial: 0, other: 0, ...p };
}

// --- 1. Table integrity: 26 unique ids, unique axis keys -------------------
check('26 pathways present', CWCS_PATHWAYS.length === 26, CWCS_PATHWAYS.length);
const ids = new Set(CWCS_PATHWAYS.map((p) => p.id));
check('ids 1..26 unique', ids.size === 26 && [...ids].every((n) => n >= 1 && n <= 26));
const axisKeys = new Set(CWCS_PATHWAYS.map((p) => `${p.tissue}|${p.exudate}|${p.infection}`));
check('axis combinations unique', axisKeys.size === 26);
check('every pathway has >=1 primary', CWCS_PATHWAYS.every((p) => p.primary.length >= 1));

// --- 2. Every pathway is reachable by lookup with its id -------------------
for (const p of CWCS_PATHWAYS) {
  const got = lookupPathway(p.tissue, p.exudate, p.infection);
  check(`lookup pathway ${p.id}`, got !== null && got.id === p.id, got?.id);
}

// --- 3. Spot-check the axis→id mapping against the source table ------------
const expected: [TissueType, ExudateLevel, Infection, number][] = [
  ['necrotic_ischaemic', 'low', 'yes', 1],
  ['necrotic_ischaemic', 'high', 'no', 6],
  ['necrotic', 'low', 'yes', 7],
  ['necrotic', 'high', 'no', 12],
  ['slough', 'low', 'yes', 13],
  ['slough', 'moderate', 'no', 16],
  ['granulating', 'moderate', 'yes', 21],
  ['granulating', 'high', 'no', 24],
  ['epithelialising', 'low', 'no', 25],
  ['epithelialising', 'low', 'yes', 26],
];
for (const [t, e, i, id] of expected) {
  check(`axis map ${t}/${e}/${i}→${id}`, lookupPathway(t, e, i)?.id === id, lookupPathway(t, e, i)?.id);
}

// --- 4. Tissue precedence (necrotic > slough > granulating > epithelial) ---
check('slough+granulation → slough',
  reconcileTissue(bed({ slough: 40, granulation: 55 })).tissueType === 'slough');
check('necrosis present dominates',
  reconcileTissue(bed({ necrosis: 15, slough: 40, granulation: 45 })).tissueType === 'necrotic');
check('granulation over epithelial',
  reconcileTissue(bed({ granulation: 30, epithelial: 60 })).tissueType === 'granulating');
check('epithelial only → epithelialising',
  reconcileTissue(bed({ epithelial: 80 })).tissueType === 'epithelialising');
check('below-threshold falls back to largest',
  reconcileTissue(bed({ slough: 5, granulation: 8 })).tissueType === 'granulating');
check('empty bed → null',
  reconcileTissue(bed({})).tissueType === null);

// --- 5. Necrotic ischaemic vs non-ischaemic by perfusion -------------------
check('necrotic + ischaemic → ischaemic',
  reconcileTissue(bed({ necrosis: 60 }), 'ischaemic').tissueType === 'necrotic_ischaemic');
check('necrotic + non_ischaemic → necrotic',
  reconcileTissue(bed({ necrosis: 60 }), 'non_ischaemic').tissueType === 'necrotic');
const necUnknown = reconcileTissue(bed({ necrosis: 60 }), 'unknown');
check('necrotic + unknown → necrotic + note',
  necUnknown.tissueType === 'necrotic' && necUnknown.notes.some((n) => n.includes('perfusion not assessed')));

// --- 6. Mölnlycke referral triggers ---------------------------------------
const codes = (fs: { code: string }[]) => fs.map((f) => f.code);
check('probe-to-bone → urgent', molnlyckeFlags({ probeToBone: true }).some((f) => f.code === 'probe_to_bone' && f.urgency === 'urgent'));
check('systemic infection → urgent', molnlyckeFlags({ systemicInfection: true }).some((f) => f.code === 'systemic_infection' && f.urgency === 'urgent'));
check('erythema >2cm → urgent', molnlyckeFlags({ spreadingErythemaOver2cm: true }).some((f) => f.code === 'spreading_infection' && f.urgency === 'urgent'));
check('ABPI<0.5 → urgent', molnlyckeFlags({ abpi: 0.4 }).some((f) => f.code === 'critical_ischaemia' && f.urgency === 'urgent'));
check('ABPI>1.4 → review TBPI', molnlyckeFlags({ abpi: 1.6 }).some((f) => f.code === 'incompressible_arteries' && f.urgency === 'review'));
check('DFU → mdt', molnlyckeFlags({ diabeticFootUlcer: true }).some((f) => f.code === 'hard_to_heal' && f.urgency === 'mdt'));
check('LOPS → mdt', molnlyckeFlags({ lossOfProtectiveSensation: true }).some((f) => f.code === 'lops' && f.urgency === 'mdt'));
check('necrotic tissue → mdt debridement', molnlyckeFlags({}, 'necrotic').some((f) => f.code === 'necrotic_tissue' && f.urgency === 'mdt'));
check('no triggers → no flags', molnlyckeFlags({}).length === 0, codes(molnlyckeFlags({})));
const ordered = molnlyckeFlags({ lossOfProtectiveSensation: true, probeToBone: true });
check('flags ordered urgent-first', ordered[0].urgency === 'urgent');

// --- 7. End-to-end engine --------------------------------------------------
const gran = evaluate({
  tissue: bed({ granulation: 70 }),
  exudate: 'moderate',
  infection: 'yes',
  cvConfidence: 'high',
  markerFound: true,
});
check('e2e granulation/mod/infected → pathway 21', gran.cwcsPathwayId === 21 && gran.status === 'complete', gran.cwcsPathwayId);

const missing = evaluate({ tissue: bed({ granulation: 70 }), infection: 'yes' });
check('missing exudate → incomplete', missing.status === 'incomplete' && missing.cwcsPathwayId === null && missing.incompleteReasons.some((r) => r.includes('Exudate')));

const epiMod = evaluate({ tissue: bed({ epithelial: 80 }), exudate: 'moderate', infection: 'no' });
check('epithelialising/mod → no pathway + note', epiMod.cwcsPathwayId === null && epiMod.notes.some((n) => n.includes('low exudate only')));

const urgent = evaluate({ tissue: bed({ granulation: 70 }), exudate: 'low', infection: 'no', molnlycke: { probeToBone: true } });
check('urgent flag surfaces priority note', urgent.referrals.some((f) => f.urgency === 'urgent') && urgent.notes[0].includes('Urgent referral'));

const noMarker = evaluate({ tissue: bed({ granulation: 70 }), exudate: 'low', infection: 'no', cvConfidence: 'high', markerFound: false });
check('no marker downgrades confidence', noMarker.confidence === 'medium' && noMarker.notes.some((n) => n.includes('marker')));

const necE2E = evaluate({ tissue: bed({ necrosis: 60 }), exudate: 'high', infection: 'yes', perfusion: 'ischaemic', markerFound: true, cvConfidence: 'high' });
check('e2e necrotic-ischaemic/high/infected → pathway 5', necE2E.cwcsPathwayId === 5, necE2E.cwcsPathwayId);
check('e2e necrotic tissue adds mdt flag', necE2E.referrals.some((f) => f.code === 'necrotic_tissue'));

// --- Summary ---------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed (of ${passed + failed}).`);
if (failed > 0) process.exit(1);
console.log('All rule checks passed.');
