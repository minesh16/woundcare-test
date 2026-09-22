// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import mermaid from 'astro-mermaid';

const base = '/docs';

// https://astro.build/config
export default defineConfig({
	site: 'https://mendwise.vercel.app',
	base,
	trailingSlash: 'ignore',
	integrations: [
		// astro-mermaid must run before Starlight so fenced ```mermaid blocks
		// are transformed before Starlight's markdown pipeline sees them.
		mermaid({ autoTheme: true }),
		starlight({
			title: 'MendWise Docs',
			description:
				'Architecture, modules, and operational status for the MendWise wound-assessment prototype.',
			favicon: '/favicon.svg',
			logo: {
				src: './src/assets/logo.svg',
				alt: 'MendWise',
			},
			customCss: ['./src/styles/custom.css'],
			components: {
				Footer: './src/components/Footer.astro',
			},
			head: [
				{
					tag: 'script',
					attrs: { src: `${base}/mermaid-viewer.js?v=0.2.2`, defer: true },
				},
			],
			social: [
				{
					icon: 'github',
					label: 'GitHub',
					href: 'https://github.com/minesh16/woundcare-test',
				},
			],
			editLink: {
				baseUrl: 'https://github.com/minesh16/woundcare-test/edit/main/docs-site/',
			},
			lastUpdated: true,
			sidebar: [
				{
					label: 'Start here',
					items: [
						{ label: 'Overview', slug: '' },
						{ label: 'Getting started', slug: 'getting-started' },
					],
				},
				{
					label: 'Architecture',
					items: [
						{ label: 'The cage & pipeline', slug: 'architecture' },
						{ label: 'Assessment pipeline', slug: 'architecture/pipeline' },
						{ label: 'Decision engine', slug: 'architecture/decision-engine' },
					],
				},
				{
					label: 'Modules',
					items: [{ autogenerate: { directory: 'modules' } }],
				},
				{
					label: 'Operations',
					items: [
						{ label: 'Production status', slug: 'operations/status' },
						{ label: 'Tech stack', slug: 'stack/tech-stack' },
						{ label: 'Platforms & versions', slug: 'stack/platforms' },
					],
				},
				{
					label: 'Project',
					items: [
						{ label: 'Roadmap', slug: 'roadmap' },
						{ label: 'Contributing & docs automation', slug: 'contributing' },
					],
				},
			],
		}),
	],
});
