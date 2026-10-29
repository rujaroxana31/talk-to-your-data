if (!process.env.LIVE_AI_BASE_URL) throw new Error('Set LIVE_AI_BASE_URL to the local authenticated Worker URL (for example http://127.0.0.1:8789).');
process.env.RUN_GOLDEN = '1';
await import('../tests/security.browser.mjs');
