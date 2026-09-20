/** Lightweight sanity checks for the decision rules (no native deps). */

function assess(input) {
  const chronic =
    input.durationOver30Days === 'yes' ||
    (input.sloughPercent ?? 0) + (input.necrosisPercent ?? 0) > 50;

  const urgent =
    input.exudate === 'heavy' ||
    input.warmth === 'yes' ||
    input.pain >= 7 ||
    (input.diabetes === 'yes' && input.warmth === 'yes');

  return { chronic, urgent };
}

const cases = [
  {
    name: 'acute routine',
    input: { durationOver30Days: 'no', exudate: 'none', warmth: 'no', pain: 2 },
    expect: { chronic: false, urgent: false },
  },
  {
    name: 'chronic by duration',
    input: { durationOver30Days: 'yes', exudate: 'none', warmth: 'no', pain: 1 },
    expect: { chronic: true, urgent: false },
  },
  {
    name: 'urgent heavy exudate',
    input: { durationOver30Days: 'no', exudate: 'heavy', warmth: 'no', pain: 3 },
    expect: { chronic: false, urgent: true },
  },
  {
    name: 'urgent warmth and pain',
    input: { durationOver30Days: 'unsure', exudate: 'moderate', warmth: 'yes', pain: 8 },
    expect: { chronic: false, urgent: true },
  },
];

let failed = 0;
for (const testCase of cases) {
  const result = assess(testCase.input);
  const ok =
    result.chronic === testCase.expect.chronic && result.urgent === testCase.expect.urgent;
  if (!ok) {
    failed += 1;
    console.error('FAIL', testCase.name, result);
  } else {
    console.log('PASS', testCase.name);
  }
}

if (failed > 0) {
  process.exit(1);
}

console.log(`All ${cases.length} rule checks passed.`);
