import type { VercelRequest, VercelResponse } from '@vercel/node';

import { buildOpenApi } from '../_openapi';

/** GET /api/v1/openapi — the OpenAPI 3.1 document. Public: it describes, it does nothing. */
export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method !== 'GET') {
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'Method not allowed.', request_id: null } });
    return;
  }
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(200).json(buildOpenApi());
}
