import { createHmac, timingSafeEqual } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * POST /api/docs-unlock — set an HttpOnly cookie if the passphrase matches.
 * DELETE /api/docs-unlock — clear it.
 *
 * Cookie name + HMAC message must stay in sync with middleware.ts.
 * Env: DOCS_PASSPHRASE (server-side, never EXPO_PUBLIC_).
 */
const COOKIE = 'mw_docs';
const MSG = 'mendwise-docs-v1';
const MAX_AGE = 60 * 60 * 24 * 7;

function token(passphrase: string): string {
  return createHmac('sha256', passphrase).update(MSG).digest('hex');
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

function cookie(value: string, secure: boolean, clear = false): string {
  const parts = [
    `${COOKIE}=${encodeURIComponent(value)}`,
    'Path=/docs',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  parts.push(clear ? 'Max-Age=0' : `Max-Age=${MAX_AGE}`);
  return parts.join('; ');
}

function readPassphrase(req: VercelRequest): string {
  if (typeof req.body === 'string') {
    try {
      return String(JSON.parse(req.body)?.passphrase ?? '');
    } catch {
      return '';
    }
  }
  if (req.body && typeof req.body === 'object') {
    return String((req.body as { passphrase?: unknown }).passphrase ?? '');
  }
  return '';
}

export default function handler(req: VercelRequest, res: VercelResponse): void {
  const secret = process.env.DOCS_PASSPHRASE ?? '';
  const secure = req.headers['x-forwarded-proto'] === 'https';

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', cookie('', secure, true));
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!secret) {
    res.status(503).json({ error: 'Docs passphrase is not configured on this deployment.' });
    return;
  }

  const given = readPassphrase(req);
  if (!given || !equal(token(given), token(secret))) {
    res.status(401).json({ error: 'Passphrase did not match.' });
    return;
  }

  res.setHeader('Set-Cookie', cookie(token(secret), secure));
  res.status(200).json({ ok: true });
}
