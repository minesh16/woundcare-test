import { z } from 'zod';

import { API_VERSION, REGULATORY_STATUS, SCOPES } from './_apiCore';
import { CONTRACTS } from './_contracts';

/**
 * The OpenAPI 3.1 document, generated from the Zod contracts (segmentation
 * spec §6A.2) — so the published reference is the validation the server runs.
 * Served at GET /api/v1/openapi and written into the docs site by
 * `npm run build:openapi`.
 */
export function buildOpenApi(): Record<string, unknown> {
  const errorSchema = {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message', 'request_id'],
        properties: { code: { type: 'string' }, message: { type: 'string' }, request_id: { type: 'string' } },
      },
    },
  };
  const envelopeSchema = {
    type: 'object',
    description: 'Fields present on every successful response, alongside the endpoint\'s own fields.',
    properties: {
      request_id: { type: 'string' },
      api_version: { type: 'string', const: API_VERSION },
      engine_version: { type: 'string' },
      model_versions: { type: 'object', additionalProperties: { type: ['string', 'null'] } },
      regulatory_status: { type: 'string', const: REGULATORY_STATUS },
      degraded: { type: 'boolean', description: 'A step degraded (e.g. a model was unavailable); `reason` says which.' },
      reason: { type: 'string' },
    },
  };

  const paths: Record<string, unknown> = {};
  for (const contract of CONTRACTS) {
    const schema = z.toJSONSchema(contract.schema, { target: 'draft-2020-12', unrepresentable: 'any' }) as Record<string, unknown>;
    delete schema.$schema;
    const responses: Record<string, unknown> = {
      200: {
        description: contract.path.endsWith('/run') ? 'Server-Sent Events: meta, step, decision, result.' : 'OK',
        content: contract.path.endsWith('/run')
          ? { 'text/event-stream': { schema: { type: 'string' } } }
          : { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } },
      },
      400: { description: 'Invalid JSON or a body that does not match this contract.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      401: { description: 'Missing or unknown API key.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      403: {
        description: contract.approval
          ? 'Key not scoped for this module, a production key, or a missing / invalid / mismatched approval_id.'
          : 'Key not scoped for this module, or a production key (not active until ARTG inclusion).',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      429: { description: 'Rate limited. See Retry-After.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    };
    paths[contract.path] = {
      post: {
        summary: (contract.schema.description ?? '').split(' — ')[1] ?? contract.path,
        description: contract.schema.description,
        security: [{ ApiKey: [] }],
        'x-scope': contract.scope,
        'x-requires-approval': contract.approval,
        parameters: [
          { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', maxLength: 200 }, description: 'Replays the original response for 24 h.' },
        ],
        requestBody: { required: true, content: { 'application/json': { schema } } },
        responses,
      },
    };
  }
  paths['/api/v1/assessments/health'] = {
    get: { summary: 'Status, configured capabilities, model and engine versions. No key needed.', responses: { 200: { description: 'OK' } } },
  };

  return {
    openapi: '3.1.0',
    info: {
      title: 'MendWise module API',
      version: API_VERSION,
      description:
        'SANDBOX — investigational, NOT FOR CLINICAL USE. Synthetic or public images only. Every response carries ' +
        '`regulatory_status: "investigational"`; production access starts after ARTG inclusion. Clinician review is ' +
        'enforced by the API: /measure, /tissue, /vlm-features and /run require an approval_id from /approve, bound ' +
        'to the image and the final mask.',
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: { ApiKey: { type: 'apiKey', in: 'header', name: 'x-api-key', description: `Scopes: ${SCOPES.join(', ')}, or *.` } },
      schemas: { Error: errorSchema, Envelope: envelopeSchema },
    },
    paths,
  };
}
