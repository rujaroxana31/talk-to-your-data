import { APIError, generateSQL, type Env } from './generation.ts';

const MAX_BODY_BYTES = 8_192;
const MAX_QUESTION_LENGTH = 1_000;

async function readQuestion(request: Request): Promise<string> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new APIError(415, 'CONTENT_TYPE_INVALID', 'Use Content-Type: application/json.');
  }
  if (!request.body) throw new APIError(400, 'BODY_INVALID', 'A JSON question object is required.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new APIError(413, 'BODY_TOO_LARGE', 'Request body exceeds 8192 bytes.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new APIError(400, 'BODY_INVALID', 'The request must contain valid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'question')) {
    throw new APIError(400, 'BODY_INVALID', 'Send only a JSON object with a question field.');
  }
  const question = (body as { question?: unknown }).question;
  if (typeof question !== 'string' || !question.trim() || question.length > MAX_QUESTION_LENGTH) {
    throw new APIError(400, 'QUESTION_INVALID', 'Question must be a nonempty string of at most 1000 characters.');
  }
  return question.trim();
}

function json(body: unknown, status: number, extraHeaders: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...extraHeaders } });
}

export default {
  async fetch(request: Request, env: Env & { FRONTEND_ORIGIN?: string }): Promise<Response> {
    const origin = request.headers.get('Origin');
    const allowed = origin !== null && (origin === env.FRONTEND_ORIGIN || origin === new URL(request.url).origin);
    // Reject unexpected browser origins before inference, not merely by omitting headers.
    // No-Origin CLI clients remain possible: CORS is not authentication/rate limiting.
    if (origin && !allowed) return json({ error: { code: 'ORIGIN_FORBIDDEN', message: 'This browser origin is not allowed.' } }, 403, { Vary: 'Origin' });
    const response = await handleRequest(request, env);
    response.headers.set('Vary', 'Origin');
    if (allowed) response.headers.set('Access-Control-Allow-Origin', origin!);
    return response;
  },
};

async function handleRequest(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== '/api/generate-sql') {
      return json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } }, 404);
    }
    if (request.method === 'OPTIONS') {
      const method = request.headers.get('Access-Control-Request-Method');
      const headers = (request.headers.get('Access-Control-Request-Headers') ?? '').split(',').map((header) => header.trim().toLowerCase()).filter(Boolean);
      if (method !== 'POST' || headers.some((header) => header !== 'content-type')) {
        return json({ error: { code: 'PREFLIGHT_FORBIDDEN', message: 'Only JSON POST requests are allowed.' } }, 403);
      }
      return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' } });
    }
    if (request.method !== 'POST') {
      return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST for SQL generation.' } }, 405, { Allow: 'POST' });
    }
    try {
      const question = await readQuestion(request);
      const sql = await generateSQL(question, env.AI);
      return json({ sql }, 200);
    } catch (error) {
      if (error instanceof APIError) return json({ error: { code: error.code, message: error.message } }, error.status);
      return json({ error: { code: 'INTERNAL_ERROR', message: 'Unable to process this request.' } }, 500);
    }
}
