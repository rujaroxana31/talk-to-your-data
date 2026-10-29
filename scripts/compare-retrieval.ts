// Development-only entry point. Never imported by worker/index.ts or the frontend.
// Run with Wrangler locally; it uses real remote Workers AI, not a fake responder.
import { APIError, generateSQL, MODEL_ID, type Env } from '../worker/generation.ts';
import { retrieveDocumentation } from '../worker/dataset.ts';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/compare') return new Response('POST /compare', { status: 405 });
    const questions = [
      'How many trips were paid by credit card?',
      'How many trips were paid in cash?',
      'How many trips had pickup timestamps in January 2022?',
      'What is the average trip distance in miles across all records?',
      'What was the total amount of actual cash tips?',
    ];
    const comparisons: Record<string, unknown>[] = [];
    for (const question of questions) {
      const results: Record<string, unknown>[] = [];
      for (const withRetrieval of [false, true]) {
        const start = Date.now();
        try {
          results.push({ withRetrieval, sql: await generateSQL(question, env.AI, withRetrieval), elapsedMs: Date.now() - start });
        } catch (error) {
          results.push({ withRetrieval, code: error instanceof APIError ? error.code : 'ERROR', error: error instanceof Error ? error.message : String(error), elapsedMs: Date.now() - start });
        }
      }
      comparisons.push({ question, retrievedSnippetIds: retrieveDocumentation(question).map((snippet) => snippet.id), results });
    }
    return Response.json({ evidence: 'real Workers AI calls', model: MODEL_ID, comparisons });
  },
};
