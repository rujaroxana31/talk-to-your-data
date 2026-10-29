import test from 'node:test';
import assert from 'node:assert/strict';
import { requestGeneratedSQL, GenerationError } from '../src/api.ts';

test('generation posts only the question to the configured base URL', async () => {
  const sql = 'SELECT COUNT(*) FROM trips';
  const result = await requestGeneratedSQL(' count trips ', { baseURL: 'http://127.0.0.1:8787/', fetcher: async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:8787/api/generate-sql');
    assert.equal(init.method, 'POST'); assert.equal(init.credentials, 'omit');
    assert.deepEqual(JSON.parse(init.body), { question: 'count trips' });
    return Response.json({ sql });
  } });
  assert.equal(result, sql);
});
test('relative base URL supports same-origin deployments', async () => {
  await requestGeneratedSQL('count trips', { baseURL: '', fetcher: async (url) => {
    assert.equal(url, '/api/generate-sql'); return Response.json({ sql: 'SELECT 1' });
  } });
});
for (const body of [{}, { sql: 123 }, { sql: '' }, { sql: ' ' }, { sql: 'x'.repeat(10001) }]) {
  test(`malformed success envelope: ${JSON.stringify(body).slice(0, 40)}`, async () => {
    await assert.rejects(requestGeneratedSQL('count', { baseURL: '', fetcher: async () => Response.json(body) }), (error) => error.code === 'RESPONSE_INVALID');
  });
}
test('invalid JSON is readable', async () => {
  await assert.rejects(requestGeneratedSQL('count', { baseURL: '', fetcher: async () => new Response('<html>') }), GenerationError);
});
test('unsupported questions produce a rephrase/manual-SQL message', async () => {
  await assert.rejects(requestGeneratedSQL('cash tips', { baseURL: '', fetcher: async () => Response.json({ error: { code: 'UNANSWERABLE' } }, { status: 422 }) }), (error) => error.code === 'UNANSWERABLE' && error.message.includes('write SQL manually'));
});
test('HTTP failures and network failures are readable', async () => {
  for (const status of [400, 403, 429, 502, 504]) {
    await assert.rejects(requestGeneratedSQL('count', { baseURL: '', fetcher: async () => Response.json({}, { status }) }), (error) => error.message.includes(`HTTP ${status}`));
  }
  await assert.rejects(requestGeneratedSQL('count', { baseURL: '', fetcher: async () => { throw new TypeError('Failed to fetch'); } }), (error) => error.code === 'NETWORK_FAILED');
});
test('invalid question is rejected before fetch', async () => {
  for (const question of ['', ' ', 'x'.repeat(1001)]) await assert.rejects(requestGeneratedSQL(question, { baseURL: '', fetcher: async () => { throw new Error('Should not fetch'); } }), (error) => error.code === 'QUESTION_INVALID');
});
const abortingFetch = async (_, init) => new Promise((_, reject) => {
  if (init.signal.aborted) reject(new DOMException('aborted', 'AbortError'));
  else init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
});
test('timeout gives a retry message', async () => {
  await assert.rejects(requestGeneratedSQL('count', { baseURL: '', timeoutMs: 5, fetcher: abortingFetch }), (error) => error.code === 'TIMEOUT');
});
test('explicit cancellation is distinguished from timeout', async () => {
  const controller = new AbortController();
  const pending = requestGeneratedSQL('count', { baseURL: '', signal: controller.signal, fetcher: abortingFetch });
  controller.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
});
