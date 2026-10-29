export class GenerationError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

// This validates the HTTP envelope only. SQL remains untrusted until executeSQL.
export async function requestGeneratedSQL(question: string, options: {
  baseURL: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}): Promise<string> {
  if (!question.trim() || question.length > 1000) throw new GenerationError('QUESTION_INVALID', 'Enter a question of at most 1,000 characters.');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? 35_000);
  try {
    const response = await (options.fetcher ?? fetch)(`${options.baseURL.replace(/\/+$/, '')}/api/generate-sql`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: question.trim() }), signal: controller.signal,
      credentials: 'omit',
    });
    let body: unknown;
    try { body = await response.json(); }
    catch { throw new GenerationError('RESPONSE_INVALID', 'The AI service returned an unreadable response. Try again.'); }
    if (!response.ok) {
      const code = body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object' && 'code' in body.error ? body.error.code : undefined;
      if (code === 'UNANSWERABLE') throw new GenerationError('UNANSWERABLE', 'This question cannot be answered reliably from this dataset. Rephrase it or write SQL manually.');
      throw new GenerationError('API_FAILED', `SQL generation failed (HTTP ${response.status}). Try again or write SQL manually.`);
    }
    if (!body || typeof body !== 'object' || !('sql' in body) || typeof body.sql !== 'string' || !body.sql.trim() || body.sql.length > 10_000) {
      throw new GenerationError('RESPONSE_INVALID', 'The AI service did not return usable SQL. Try again.');
    }
    return body.sql.trim();
  } catch (error) {
    if (options.signal?.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
    if (timedOut) throw new GenerationError('TIMEOUT', 'SQL generation timed out. Try again or write SQL manually.');
    if (error instanceof GenerationError) throw error;
    throw new GenerationError('NETWORK_FAILED', 'Cannot reach the AI service. Check its URL, connection and CORS configuration, then retry. Manual SQL still works.');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}
