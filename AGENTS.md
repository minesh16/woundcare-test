# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# MendWise architecture & handoff

Before non-trivial work, read `docs/MendWise_Assessment_Build_Spec.md` (full architecture) and `docs/HANDOFF.md` (current state + next task). Obey the cage in `.cursor/rules/mendwise.mdc`: the deterministic engine in `src/decision/engine.ts` makes the dressing/referral decision; AI is caged; changes are additive behind `assessmentV2`; no fine-tuning. Keep `npm run test:rules` green (66/66) and don't add `npm run typecheck` errors.
