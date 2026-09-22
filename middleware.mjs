/**
 * Passphrase gate for /docs on the Expo Vercel project.
 * Matcher keeps this off the app and off /api/* (except we never match those).
 *
 * Cookie name + HMAC message must stay in sync with api/docs-unlock.ts.
 */
const COOKIE = 'mw_docs';
const MSG = 'mendwise-docs-v1';

export const config = {
	matcher: ['/docs', '/docs/(.*)'],
};

function parseCookie(header) {
	const out = {};
	if (!header) return out;
	for (const part of header.split(';')) {
		const i = part.indexOf('=');
		if (i === -1) continue;
		out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
	}
	return out;
}

function timingSafeEqual(a, b) {
	if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) {
		return false;
	}
	let mismatch = 0;
	for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return mismatch === 0;
}

async function token(passphrase) {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(passphrase),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(MSG));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function next() {
	return new Response(null, {
		headers: { 'x-middleware-next': '1' },
	});
}

function isPublicDocsPath(pathname) {
	return (
		pathname === '/docs/gate' ||
		pathname.startsWith('/docs/gate/') ||
		pathname === '/docs/favicon.svg' ||
		pathname === '/docs/favicon.ico'
	);
}

function sendToGate(request, extra = {}) {
	const gate = new URL('/docs/gate/', request.url);
	for (const [key, value] of Object.entries(extra)) gate.searchParams.set(key, value);
	const url = new URL(request.url);
	const nextPath = `${url.pathname}${url.search}`;
	if (nextPath.startsWith('/docs') && !nextPath.startsWith('/docs/gate')) {
		gate.searchParams.set('next', nextPath);
	}
	return Response.redirect(gate, 302);
}

export default async function middleware(request) {
	const { pathname } = new URL(request.url);
	if (isPublicDocsPath(pathname)) return next();

	const secret = process.env.DOCS_PASSPHRASE;
	if (!secret) return sendToGate(request, { reason: 'unconfigured' });

	const given = parseCookie(request.headers.get('cookie'))[COOKIE] ?? '';
	const expected = await token(secret);
	if (timingSafeEqual(given, expected)) return next();
	return sendToGate(request);
}
