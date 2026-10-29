// Run against `wrangler dev --local` for request handling without real inference.
import test from 'node:test';
import assert from 'node:assert/strict';

const base = process.env.WORKER_TEST_URL || 'http://127.0.0.1:8787';
for (const [name, path, init, status] of [
  ['unknown route', '/missing', {}, 404],
  ['wrong method', '/api/generate-sql', {}, 405],
  ['wrong content type', '/api/generate-sql', { method: 'POST', body: '{}' }, 415],
  ['invalid JSON', '/api/generate-sql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }, 400],
  ['empty question', '/api/generate-sql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"question":" "}' }, 400],
  ['oversized body', '/api/generate-sql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'x'.repeat(9000) }) }, 413],
]) test(`workerd HTTP: ${name}`, async () => {
  const response = await fetch(base + path, init);
  assert.equal(response.status, status);
  assert.equal(typeof (await response.json()).error.message, 'string');
});

test('workerd HTTP: no-AI local mode returns a sanitized model error', { skip: process.env.WORKER_EXPECT_NO_AI !== '1' }, async () => {
  const response = await fetch(base + '/api/generate-sql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"question":"How many trips?"}' });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: { code: 'MODEL_UNAVAILABLE', message: 'SQL generation is temporarily unavailable. Please try again.' } });
});
