// Requires an existing Chrome/Chromium installation; installs no testing packages.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const chromePath = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
if (!chromePath) throw new Error('Set CHROME_PATH to an installed Chrome/Chromium executable.');
const port = process.env.TEST_PORT || '5186';
const url = `http://127.0.0.1:${port}/`;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', port, '--strictPort'], {
  windowsHide: true, stdio: 'pipe',
  env: { ...process.env, ...(process.env.LIVE_AI_BASE_URL ? { VITE_API_BASE_URL: process.env.LIVE_AI_BASE_URL } : {}) },
});
let serverOutput = '';
server.stderr.on('data', (data) => { serverOutput += data; });
const profile = mkdtempSync(join(tmpdir(), 'taxi-security-'));
let chrome;
let ws;
const errors = [];
const requests = [];
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`Vite failed: ${serverOutput}`);
    try { ready = (await fetch(url)).ok; } catch { /* wait for server */ }
    if (ready) break;
    await sleep(100);
  }
  if (!ready) throw new Error('Vite did not become ready.');
  chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let debuggingPort;
  for (let i = 0; i < 100; i++) {
    try { debuggingPort = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; break; } catch { await sleep(100); }
  }
  if (!debuggingPort) throw new Error('Chrome did not expose its debugging endpoint.');
  const pages = await (await fetch(`http://127.0.0.1:${debuggingPort}/json`)).json();
  ws = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const pending = new Map();
  let id = 0;
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const task = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(task?.timer);
      if (message.error) task?.reject(message.error); else task?.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params);
    else if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url);
  };
  const send = (method, params = {}, timeoutMs = 60_000) => new Promise((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => { pending.delete(n); reject(new Error(`Timed out: ${method}`)); }, timeoutMs);
    pending.set(n, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expression, timeoutMs) => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  const wait = async (expression) => {
    for (let i = 0; i < 300; i++) { if (await evaluate(expression)) return; await sleep(100); }
    throw new Error(`Timed out waiting for ${expression}`);
  };
  await send('Runtime.enable'); await send('Network.enable');
  await send('Page.navigate', { url });
  await wait("!!document.querySelector('#run-sql') && (!document.querySelector('#run-sql').disabled || !!document.querySelector('[role=alert]'))");
  const initializationError = await evaluate("document.querySelector('[role=alert]')?.textContent");
  assert.equal(initializationError, undefined);
  const suite = await evaluate("(async()=>{const m=await import('/tests/security.browser.ts'); return m.runSecurityChecks();})()");
  console.log(JSON.stringify({ gateTests: suite.passed, failures: suite.failed }, null, 2));
  assert.equal(suite.failed.length, 0);
  const runtime = await evaluate("(async()=>{const m=await import('/tests/runtime-restrictions.browser.ts'); return m.testRuntimeRestrictions();})()");
  console.log(JSON.stringify({ runtimeTests: runtime.passed, blocked: runtime.blocked }, null, 2));
  // Drive the React editor, not just the exported module API.
  for (const sql of ['DROP VIEW trips', 'SELECT * FROM trips; DROP VIEW trips', "WITH x AS (SELECT * FROM read_csv('/etc/passwd')) SELECT * FROM x", null]) {
    const input = sql || "SELECT COUNT(*) AS trip_count FROM trips WHERE tpep_pickup_datetime >= TIMESTAMP '2022-01-01' AND tpep_pickup_datetime < TIMESTAMP '2022-02-01'";
    await evaluate(`(()=>{const e=document.querySelector('#sql');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(input)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await sleep(50);
    await evaluate("document.querySelector('#run-sql').click()");
    await wait("!document.querySelector('#run-sql').disabled");
    if (sql) assert.match(await evaluate("document.querySelector('[role=alert]')?.textContent || ''"), /SQL rejected:/);
    else assert.equal(await evaluate("document.querySelector('tbody td')?.textContent"), '2463879');
  }
  const generation = await evaluate("(async()=>{const m=await import('/tests/generation.browser.ts'); return m.runGenerationChecks();})()");
  console.log(JSON.stringify({ generationChecks: generation.passed, evidence: generation.evidence, checks: generation.checks }, null, 2));
  if (process.env.LIVE_AI_BASE_URL) {
    // Opt-in real inference. The Worker must allow this test server's exact origin.
    await evaluate(`(()=>{const e=document.querySelector('#question');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'How many trips were paid by credit card?');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await sleep(50);
    await evaluate("document.querySelector('#generate-sql').click()");
    await wait("!document.querySelector('#generate-sql').disabled");
    assert.equal(await evaluate("document.querySelector('#generation-error')?.textContent"), undefined);
    assert.equal(await evaluate("document.querySelectorAll('tbody tr').length"), 0, 'Real generation must not execute SQL');
    const generatedSQL = await evaluate("document.querySelector('#sql').value");
    await evaluate("document.querySelector('#run-sql').click()");
    await wait("!document.querySelector('#run-sql').disabled");
    assert.equal(await evaluate("document.querySelector('tbody td')?.textContent"), '1874874');
    const denied = await fetch(`${process.env.LIVE_AI_BASE_URL}/api/generate-sql`, { method: 'POST', headers: { Origin: 'https://not-allowed.example', 'Content-Type': 'application/json' }, body: '{"question":"count trips"}' });
    assert.equal(denied.status, 403);
    console.log(JSON.stringify({ evidence: 'REAL Workers AI over browser CORS', generatedSQL, automaticExecution: false, explicitRunCount: '1874874', forbiddenOriginStatus: denied.status }));
  }
  if (process.env.RUN_GOLDEN === '1') {
    assert.ok(process.env.LIVE_AI_BASE_URL, 'Golden generation requires a real local Worker API URL.');
    const golden = await evaluate(`(async()=>{const m=await import('/tests/golden.browser.ts');return m.runGoldenChecks(${JSON.stringify(process.env.LIVE_AI_BASE_URL)});})()`, 360_000);
    writeFileSync('tests/golden-report.json', JSON.stringify(golden, null, 2) + '\n');
    console.log(JSON.stringify({ goldenPassed: golden.passed, goldenFailed: golden.failed, results: golden.results }, null, 2));
    assert.equal(golden.failed, 0, 'Golden failures recorded in tests/golden-report.json');
  }
  assert.equal(requests.filter((request) => request.includes('yellow_tripdata')).length, 1);
  assert.deepEqual(requests.filter((request) => !request.startsWith(url) && !request.startsWith('data:') && !(process.env.LIVE_AI_BASE_URL && request === `${process.env.LIVE_AI_BASE_URL}/api/generate-sql`)), []);
  assert.deepEqual(errors, []);
  console.log('PASS: 4 editor checks; one Parquet request; no unexpected requests or uncaught browser errors.');
  await send('Browser.close');
} finally {
  ws?.close(); chrome?.kill(); server.kill();
  await sleep(400);
  // Only remove the uniquely created temporary profile, never a user profile.
  if (dirname(resolve(profile)) === resolve(tmpdir()) && basename(profile).startsWith('taxi-security-')) {
    rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}
