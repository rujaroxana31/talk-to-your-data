import { SQL } from '../src/database';

// Real React + DuckDB, mocked HTTP responses: no inference quota used by this suite.
export async function runGenerationChecks() {
  const originalFetch = window.fetch;
  const calls: RequestInit[] = [];
  const passed: string[] = [];
  let respond: (init?: RequestInit) => Promise<Response> = async () => Response.json({ sql: 'SELECT 1' });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
  const element = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
  const wait = async (condition: () => boolean) => {
    for (let i = 0; i < 200; i++) { if (condition()) return; await sleep(25); }
    throw new Error('Timed out waiting for generation UI.');
  };
  const input = async (selector: string, value: string) => {
    const target = element<HTMLInputElement | HTMLTextAreaElement>(selector);
    const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(target, value);
    target.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(0);
  };
  const generate = async () => {
    element<HTMLButtonElement>('#generate-sql').click();
    await sleep(0);
  };
  const finished = () => !element<HTMLButtonElement>('#generate-sql').disabled;
  const sqlValue = () => element<HTMLTextAreaElement>('#sql').value;
  const run = async () => {
    element<HTMLButtonElement>('#run-sql').click();
    await sleep(0);
    await wait(() => !element<HTMLButtonElement>('#run-sql').disabled);
  };
  window.fetch = async (resource, init) => {
    if (String(resource).endsWith('/api/generate-sql')) { calls.push(init ?? {}); return respond(init); }
    return originalFetch(resource, init);
  };
  try {
    await input('#question', 'How many trips were paid by credit card?');
    let complete!: (response: Response) => void;
    respond = () => new Promise((resolve) => { complete = resolve; });
    await generate();
    assert(element('#generation-status').textContent?.includes('Generating'), 'Loading state missing');
    assert(!element<HTMLButtonElement>('#run-sql').disabled, 'Manual SQL disabled during generation');
    const callCount = calls.length;
    await generate(); assert(calls.length === callCount, 'Duplicate generation request');
    complete(Response.json({ sql: 'SELECT COUNT(*) AS n FROM trips WHERE payment_type=1' }));
    await wait(finished);
    assert(sqlValue().includes('payment_type=1'), 'Generated SQL missing');
    assert(!document.querySelector('tbody tr'), 'Generation executed SQL automatically');
    assert(element('#generation-status').textContent?.includes('not been executed'), 'Review notice missing');
    passed.push('loading, duplicate-click protection, SQL placement, no automatic execution');
    await run();
    assert(element('tbody td').textContent === '1874874', 'Generated SQL did not execute through Run SQL');
    passed.push('explicit execution of generated query');

    respond = async () => Response.json({ error: { code: 'MODEL_UNAVAILABLE' } }, { status: 502 });
    await generate(); await wait(() => !!document.querySelector('#generation-error'));
    assert(sqlValue().includes('payment_type=1'), 'API failure overwrote SQL');
    assert(element('#generate-sql').textContent === 'Retry generation', 'Retry action missing');
    await input('#sql', 'SELECT 42 AS manual'); await run();
    assert(element('tbody td').textContent === '42', 'Manual SQL failed during AI outage');
    passed.push('API failure preserves SQL and manual execution');
    respond = async () => Response.json({ sql: 'SELECT 7 AS retried' });
    await generate(); await wait(finished);
    assert(sqlValue().includes('retried'), 'Retry did not update SQL');
    assert(!document.querySelector('tbody tr'), 'Retry automatically executed SQL');
    passed.push('successful retry without execution');

    for (const [name, response] of [
      ['unsupported question', () => Response.json({ error: { code: 'UNANSWERABLE' } }, { status: 422 })],
      ['malformed envelope', () => Response.json({ sql: 123 })],
      ['unreadable response', () => new Response('not JSON')],
      ['network failure', () => { throw new TypeError('Failed to fetch'); }],
    ] as const) {
      respond = async () => response();
      const before = sqlValue();
      await generate(); await wait(() => !!document.querySelector('#generation-error'));
      assert(sqlValue() === before, `${name} changed SQL`);
      assert(finished(), `${name} left generation stuck`);
      passed.push(name);
    }

    respond = () => new Promise((resolve) => { complete = resolve; });
    await generate();
    await input('#sql', 'SELECT 8 AS manual_edit');
    complete(Response.json({ sql: 'SELECT 999 AS stale' }));
    await sleep(50);
    assert(sqlValue() === 'SELECT 8 AS manual_edit', 'Late response overwrote manual edit');
    passed.push('late response cannot overwrite edited SQL');

    await generate();
    element('#cancel-generation').click();
    complete(Response.json({ sql: 'SELECT 999 AS cancelled' }));
    await sleep(50);
    assert(sqlValue() === 'SELECT 8 AS manual_edit' && finished(), 'Cancellation failed');
    passed.push('explicit cancellation');

    respond = async () => Response.json({ sql: 'SELECT 1; DROP VIEW trips' });
    await generate(); await wait(finished);
    await run();
    assert(element('[aria-labelledby="results-heading"] [role="alert"]').textContent?.includes('SQL rejected:'), 'Generated SQL bypassed security gate');
    await input('#sql', SQL); await run();
    assert(element('tbody td').textContent === '2463879', 'trips changed or recovery failed');
    passed.push('malicious generated SQL blocked by unchanged gate, with recovery');
    for (const call of calls) {
      assert(call.method === 'POST' && call.credentials === 'omit', 'Incorrect API request');
      assert(JSON.stringify(Object.keys(JSON.parse(String(call.body)))) === '["question"]', 'Unexpected outbound data');
    }
    passed.push('only question sent, without browser credentials');
    return { evidence: 'real browser/UI/DuckDB; mocked AI HTTP responses', passed: passed.length, checks: passed };
  } finally { window.fetch = originalFetch; }
}
