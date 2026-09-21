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
  reconcileExudate,
  reconcileInfection,
  reconcileTissue,
} from '../src/decision/engine.ts';
import type {
  ExudateLevel,
  Infection,
  TissueBreakdown,
  TissueType,
  VlmFeatures,
} from '../src/decision/engine.types.ts';

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

// ===========================================================================
// Phase 2 — reconciliation of caged VLM features
// ===========================================================================

function vlm(p: Partial<VlmFeatures> = {}): VlmFeatures {
  return {
    infectionSigns: {
      erythema: 'uncertain',
      warmth: 'uncertain',
      purulent: 'uncertain',
      malodour: 'uncertain',
      friableGranulation: 'uncertain',
    },
    edgeType: 'uncertain',
    visualExudate: 'uncertain',
    tissueCorroboration: 'uncertain',
    imageFlags: [],
    ...p,
  };
}

// --- Exudate axis ----------------------------------------------------------
const exAnswered = reconcileExudate('moderate', vlm({ visualExudate: 'high' }));
check('exudate: answer wins over image', exAnswered.exudate === 'moderate' && !exAnswered.downgrade);

const exFar = reconcileExudate('low', vlm({ visualExudate: 'very_high' }));
check('exudate: >1 band disagreement keeps answer but downgrades', exFar.exudate === 'low' && exFar.downgrade);

const exFill = reconcileExudate(undefined, vlm({ visualExudate: 'high' }));
check('exudate: image fills a missing answer, capped at medium', exFill.exudate === 'high' && exFill.confidenceCap === 'medium');

const exNone = reconcileExudate(undefined, vlm({ visualExudate: 'uncertain' }));
check('exudate: uncertain image carries no information', exNone.exudate === null);

const exNoVlm = reconcileExudate('high', undefined);
check('exudate: works with no VLM at all', exNoVlm.exudate === 'high' && !exNoVlm.downgrade);

// --- Infection axis --------------------------------------------------------
const infYes = reconcileInfection('yes', vlm());
check('infection: answered yes → yes', infYes.infection === 'yes');

const infPurulent = reconcileInfection(undefined, vlm({ infectionSigns: { ...vlm().infectionSigns, purulent: 'present' } }));
check('infection: purulence alone → yes', infPurulent.infection === 'yes');

const infTwoSigns = reconcileInfection(undefined, vlm({
  infectionSigns: { ...vlm().infectionSigns, erythema: 'present', warmth: 'present' },
}));
check('infection: two classic signs → yes', infTwoSigns.infection === 'yes');

const infOneSign = reconcileInfection(undefined, vlm({
  infectionSigns: { ...vlm().infectionSigns, erythema: 'present' },
}));
check('infection: one sign alone is not enough → null', infOneSign.infection === null);

const infOverride = reconcileInfection('no', vlm({
  infectionSigns: { ...vlm().infectionSigns, purulent: 'present' },
}));
check('infection: purulence overrides a "no" answer', infOverride.infection === 'yes' && infOverride.notes.length > 0);

const infNoWithSign = reconcileInfection('no', vlm({
  infectionSigns: { ...vlm().infectionSigns, friableGranulation: 'present' },
}));
check('infection: answered no + a subtle sign → null, not no', infNoWithSign.infection === null);

const infCleanNo = reconcileInfection('no', vlm());
check('infection: answered no with nothing seen → no', infCleanNo.infection === 'no');

const infVlmOnlyAbsent = reconcileInfection(undefined, vlm({
  infectionSigns: {
    erythema: 'absent', warmth: 'absent', purulent: 'absent', malodour: 'absent', friableGranulation: 'absent',
  },
}));
check('infection: the VLM can never establish "no" on its own', infVlmOnlyAbsent.infection === null);

// --- Tissue: the VLM may not change the class ------------------------------
const tissueDisagree = evaluate({
  tissue: bed({ granulation: 70 }), exudate: 'low', infection: 'no',
  cvConfidence: 'high', vlm: vlm({ tissueCorroboration: 'disagrees' }),
});
check('tissue: VLM disagreement does not change the class', tissueDisagree.axes.tissue === 'granulating');
check('tissue: VLM disagreement downgrades confidence', tissueDisagree.confidence === 'medium');
check('tissue: VLM disagreement alone still yields a pathway', tissueDisagree.cwcsPathwayId !== null);

const tissueDoubleDoubt = evaluate({
  tissue: bed({ granulation: 4, slough: 3 }), exudate: 'low', infection: 'no',
  vlm: vlm({ tissueCorroboration: 'disagrees' }),
});
check('tissue: weak measurement + VLM disagreement → incomplete', tissueDoubleDoubt.status === 'incomplete');
check('tissue: that conflict is recorded as a gate code', tissueDoubleDoubt.gateCodes.includes('tissue_conflict'));

// --- Safety gates ----------------------------------------------------------
const blurred = evaluate({
  tissue: bed({ granulation: 70 }), exudate: 'low', infection: 'no',
  cvConfidence: 'high', vlm: vlm({ imageFlags: ['blur'] }),
});
check('gate: blur withholds the pathway', blurred.cwcsPathwayId === null && blurred.pathwayWithheld);
check('gate: blur forces low confidence', blurred.confidence === 'low');
check('gate: blur is recorded as a gate code', blurred.gateCodes.includes('blurred_image'));
check('gate: blur yields no dressings', blurred.primary.length === 0 && blurred.secondary.length === 0);

const noScale = evaluate({
  tissue: bed({ granulation: 70 }), exudate: 'low', infection: 'no', markerFound: false,
});
check('gate: no scale withholds the pathway', noScale.cwcsPathwayId === null && noScale.gateCodes.includes('no_scale'));

const manualSize = evaluate({
  tissue: bed({ granulation: 70 }), exudate: 'low', infection: 'no',
  markerFound: false, manualSizeProvided: true, cvConfidence: 'high',
});
check('gate: a hand-entered size satisfies the scale gate', manualSize.cwcsPathwayId !== null && !manualSize.pathwayWithheld);
check('gate: hand-entered size keeps confidence', manualSize.confidence === 'high');

const lowLight = evaluate({
  tissue: bed({ granulation: 70 }), exudate: 'low', infection: 'no',
  cvConfidence: 'high', vlm: vlm({ imageFlags: ['low_light'] }),
});
check('gate: low light downgrades but does not withhold', lowLight.confidence === 'medium' && lowLight.cwcsPathwayId !== null);

// Withheld is distinct from never-resolved: both are incomplete, but only one
// had a pathway to withhold. The audit trail must be able to tell them apart.
check('gate: withheld is distinct from unresolved', blurred.pathwayWithheld === true && missing.pathwayWithheld === false);

// --- Regression: absent VLM must not change any Phase-0 outcome ------------
const phase0Cases: { tissue: Partial<TissueBreakdown>; exudate: ExudateLevel; infection: Infection }[] = [
  { tissue: { granulation: 70 }, exudate: 'low', infection: 'no' },
  { tissue: { slough: 70 }, exudate: 'moderate', infection: 'yes' },
  { tissue: { necrosis: 60 }, exudate: 'high', infection: 'yes' },
  { tissue: { epithelial: 80 }, exudate: 'low', infection: 'no' },
];
for (const c of phase0Cases) {
  const withoutVlm = evaluate({ tissue: bed(c.tissue), exudate: c.exudate, infection: c.infection });
  const withNeutralVlm = evaluate({ tissue: bed(c.tissue), exudate: c.exudate, infection: c.infection, vlm: vlm() });
  check(
    `regression: neutral VLM changes nothing (${Object.keys(c.tissue)[0]}/${c.exudate}/${c.infection})`,
    withoutVlm.cwcsPathwayId === withNeutralVlm.cwcsPathwayId &&
      withoutVlm.confidence === withNeutralVlm.confidence &&
      withoutVlm.status === withNeutralVlm.status,
  );
}

// --- Summary ---------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed (of ${passed + failed}).`);
if (failed > 0) process.exit(1);
console.log('All rule checks passed.');
