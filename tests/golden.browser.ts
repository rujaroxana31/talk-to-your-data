import { executeSQL } from '../src/database';

type GoldenCase = {
  id: string; question: string; referenceSQL: string | null; shape: string;
  expectedRows: (number | null)[][] | null; expectedError?: string;
};

function sameRows(actual: (string | null)[][], expected: (number | null)[][]): boolean {
  return actual.length === expected.length && actual.every((row, index) =>
    row.length === expected[index].length && row.every((value, column) => {
      const reference = expected[index][column];
      if (reference === null) return value === null;
      if (value === null || !Number.isFinite(Number(value))) return false;
      // Counts/IDs are exact; floating aggregates allow only rounding differences.
      return Number.isInteger(reference) ? Number(value) === reference
        : Math.abs(Number(value) - reference) <= 1e-7 + 1e-10 * Math.abs(reference);
    }));
}

export async function runGoldenChecks(apiBaseURL: string) {
  const fixtureResponse = await fetch('/tests/golden-reference.json');
  if (!fixtureResponse.ok) throw new Error('Generate tests/golden-reference.json with the independent Python reference script first.');
  const reference = await fixtureResponse.json() as { cases: GoldenCase[]; sha256: string; duckdbVersion: string };
  const results: Record<string, unknown>[] = [];
  for (const item of reference.cases) {
    const start = performance.now();
    const record: Record<string, unknown> = { ...item, status: 'FAIL', evidence: 'real Worker/Workers AI + browser security gate', referenceBrowserPass: null };
    try {
      // Check the independent reference through the same browser gate as well.
      if (item.referenceSQL && item.expectedRows) {
        record.referenceBrowserPass = sameRows((await executeSQL(item.referenceSQL)).rows, item.expectedRows);
        if (!record.referenceBrowserPass) throw new Error('Native vs browser reference mismatch.');
      }
      const response = await fetch(`${apiBaseURL}/api/generate-sql`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: item.question }), credentials: 'omit', signal: AbortSignal.timeout(40_000),
      });
      const body = await response.json();
      record.httpStatus = response.status;
      if (!response.ok) {
        record.apiError = body.error;
        record.status = response.status === 422 && body.error?.code === item.expectedError ? 'PASS' : 'FAIL';
        record.actualSQL = null;
      } else {
        if (typeof body.sql !== 'string') throw new Error('Malformed SQL response.');
        record.actualSQL = body.sql;
        // Never execute generated SQL natively or via a raw DuckDB connection.
        const result = await executeSQL(body.sql);
        record.actualRows = result.rows;
        record.actualColumns = result.columns;
        record.status = !item.expectedError && item.expectedRows && sameRows(result.rows, item.expectedRows) ? 'PASS' : 'FAIL';
      }
    } catch (error) { record.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error); }
    record.elapsedMs = Math.round(performance.now() - start);
    results.push(record);
  }
  return {
    model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', referenceSHA256: reference.sha256,
    referenceDuckDB: reference.duckdbVersion, mocked: false,
    passed: results.filter((item) => item.status === 'PASS').length,
    failed: results.filter((item) => item.status !== 'PASS').length, results,
  };
}
