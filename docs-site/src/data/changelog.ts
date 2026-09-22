/** Docs-site version log. App capability lives on /operations/status/, not here. */
export const docsVersion = '0.2.2';

export const changelog: { date: string; version: string; change: string }[] = [
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
