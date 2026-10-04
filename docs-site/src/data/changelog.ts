/** Docs-site version log. App capability lives on /operations/status/, not here. */
export const docsVersion = '0.4.0';

export const changelog: { date: string; version: string; change: string }[] = [
	{
		date: '2026-10-05',
		version: '0.4.0',
		change:
			'New Evaluation section: results of the first public-data evaluation (1,160 photos, 95% CIs) and what they mean for the app. Outline Dice 0.75 on unseen data (0.68 end to end without FUSegNet), so the review step is load-bearing; the FUSegNet fallback nearly doubles false outlines on non-wound photos; the coin detector reports a coin on 23% of coin-free photos; dominant-tissue accuracy is no better than always answering slough.',
	},
	{
		date: '2026-10-03',
		version: '0.3.2',
		change:
			'Both boundary providers verified live. FUSegNet\'s response contract pinned from a real call (mask_png_b64, area_px, mean_prob, regions, crop, model) and its decoded mask area matches its own area_px exactly. The finding worth keeping: FUSegNet has no abstain — it returned a mask at mean_prob 0.95 on an image with no wound in it, where SAM 3 correctly returned no match. mean_prob can only downgrade confidence, never establish it.',
	},
	{
		date: '2026-10-03',
		version: '0.3.1',
		change:
			'Chain order is now SAM 3 → FUSegNet: FUSegNet is trained on foot ulcers specifically, so the generalist leads until the eval set settles it. SAM 2 on Replicate removed outright — it took no prompt and segmented everything in frame. SAM 3 verified live end to end (mask measured within 0.3% of known geometry); FUSegNet\'s route, request field and /health are confirmed, its authenticated inference is not.',
	},
	{
		date: '2026-10-03',
		version: '0.3.0',
		change:
			'Segmentation is a provider chain, not one model: FUSegNet on Modal (wound-specific) → SAM 3 on fal.ai (concept prompt "wound") → SAM 2 on Replicate (unchanged, now the last fallback). A mask is measured for plausibility before it is trusted, every attempt is recorded in the audit log, and /api/v1/assessments/segment finally exists. 96 new offline assertions + a live probe.',
	},
	{
		date: '2026-09-23',
		version: '0.2.3',
		change:
			'Diagram pan/zoom actually works: the viewer now lives in a figure beside the <pre> mermaid re-renders into, instead of inside it (mermaid was wiping the toolbar on every render). Also fixed a semicolon that broke the screen-flow sequence diagram.',
	},
	{
		date: '2026-09-23',
		version: '0.2.2',
		change:
			'Live at /docs behind the passphrase gate (middleware must be middleware.ts, not .mjs). Production status re-checked: Supabase store live — SUPABASE_URL was misspelled, not missing.',
	},
	{
		date: '2026-09-23',
		version: '0.2.1',
		change:
			'Diagram viewer: two-finger pinch zoom on touchscreens, and distinct Fit / Fullscreen icons.',
	},
	{
		date: '2026-09-21',
		version: '0.2.0',
		change:
			'Docs served at mendwise.vercel.app/docs (same Vercel project, passphrase gate). Mermaid fullscreen + pan/zoom. Version log. Nav/content icons.',
	},
	{
		date: '2026-09-21',
		version: '0.1.0',
		change:
			'Initial Starlight site: cage, pipeline, engine, modules, production status, roadmap from HANDOFF NEXT. Cursor docs-check hook.',
	},
	{
		date: '2026-09-21',
		version: 'app Phase 2',
		change:
			'Caged VLM pipeline, safety gate, SSE run.ts, plain-language UI. Engine tests 97/97. Prod: gateway + SAM 2 live; store missing SUPABASE_URL.',
	},
	{
		date: '2026-09',
		version: 'app Phase 1',
		change: 'SAM 2 via Replicate, marker/pxPerCm, HSI tissue % with epithelial class, gallery upload.',
	},
	{
		date: '2026-09',
		version: 'app Phase 0',
		change: 'Deterministic engine.ts: 26 CWCS pathways, tissue precedence, Mölnlycke flags, evaluate().',
	},
];
