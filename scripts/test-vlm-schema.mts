/**
 * Phase 2 cage tests — schema and report guardrails. No network, no models.
 * Run: npm run test:cage
 *
 * These assert the properties that make the VLM "caged": the schema admits no
 * free text, `uncertain` is always reachable, and a narration that invents a
 * pathway or a dressing is rejected.
 */
import { vlmFeaturesSchema, VLM_SYSTEM_PROMPT } from '../src/decision/vlm.schema.ts';
import { violatesCage } from '../src/decision/reportCage.ts';
import type { EngineResult } from '../src/decision/engine.types.ts';

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

// --- The schema is a cage, not a suggestion --------------------------------
const valid = {
  infectionSigns: {
    erythema: 'present',
    warmth: 'uncertain',
    purulent: 'absent',
    malodour: 'uncertain',
    friableGranulation: 'absent',
  },
  edgeType: 'rolled_epibole',
  visualExudate: 'moderate',
  tissueCorroboration: 'agrees',
  imageFlags: ['low_light'],
};
check('schema accepts a well-formed extraction', vlmFeaturesSchema.safeParse(valid).success);

const allUncertain = {
  infectionSigns: {
    erythema: 'uncertain', warmth: 'uncertain', purulent: 'uncertain',
    malodour: 'uncertain', friableGranulation: 'uncertain',
  },
  edgeType: 'uncertain',
  visualExudate: 'uncertain',
  tissueCorroboration: 'uncertain',
  imageFlags: [],
};
check('schema lets the model answer "uncertain" everywhere', vlmFeaturesSchema.safeParse(allUncertain).success);

check(
  'schema rejects free text in an enum slot',
  !vlmFeaturesSchema.safeParse({ ...valid, edgeType: 'looks a bit rolled to me' }).success,
);
check(
  'schema rejects an invented infection value',
  !vlmFeaturesSchema.safeParse({
    ...valid,
    infectionSigns: { ...valid.infectionSigns, erythema: 'probably' },
  }).success,
);
check(
  'schema rejects an unlisted image flag',
  !vlmFeaturesSchema.safeParse({ ...valid, imageFlags: ['wrong_angle'] }).success,
);
check(
  'schema strips any extra key the model tries to add',
  (() => {
    const parsed = vlmFeaturesSchema.safeParse({ ...valid, recommendedDressing: 'foam' });
    return parsed.success && !('recommendedDressing' in parsed.data);
  })(),
);

// No field in the schema accepts an unconstrained string: that is the property
// that makes it impossible for a decision to travel back as prose.
const shape = vlmFeaturesSchema.shape;
check(
  'no top-level field accepts unconstrained text',
  Object.values(shape).every((field) => field.constructor.name !== 'ZodString'),
);

check('the prompt forbids naming a treatment', /must NOT suggest, name or imply any dressing/i.test(VLM_SYSTEM_PROMPT));
check('the prompt permits uncertainty', /uncertain/i.test(VLM_SYSTEM_PROMPT));

// --- The report may not exceed the decision --------------------------------
function resultWith(over: Partial<EngineResult>): EngineResult {
  return {
    status: 'complete',
    incompleteReasons: [],
    pathwayWithheld: false,
    gateCodes: [],
    axes: { tissue: 'granulating', exudate: 'low', infection: 'no' },
    cwcsPathwayId: 7,
    primary: ['Hydrocolloid'],
    secondary: [],
    referrals: [],
    confidence: 'high',
    notes: [],
    rulesVersion: 'test',
    ...over,
  };
}

const decided = resultWith({});
check('report naming the decided pathway passes', violatesCage('Per CWCS pathway 7, apply a hydrocolloid.', decided) === null);
check('report naming a different pathway is rejected', violatesCage('Per CWCS pathway 12, apply a foam.', decided) !== null);

const withheld = resultWith({ cwcsPathwayId: null, primary: [], pathwayWithheld: true, gateCodes: ['blurred_image'], status: 'incomplete' });
check(
  'report suggesting a dressing with no decided pathway is rejected',
  violatesCage('We suggest an alginate dressing.', withheld) !== null,
);
check(
  'report explaining why there is no dressing is allowed',
  violatesCage('No dressing suggestion can be given — the assessment was withheld because the photo is blurred.', withheld) === null,
);
check(
  'report naming any pathway when none was decided is rejected',
  violatesCage('This looks like pathway 3.', withheld) !== null,
);
check('a report with no pathway talk at all passes', violatesCage('Take another photo in better light.', withheld) === null);

console.log(`\n${passed} passed, ${failed} failed (of ${passed + failed}).`);
if (failed > 0) process.exit(1);
console.log('All cage checks passed.');
