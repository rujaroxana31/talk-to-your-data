import * as duckdb from '@duckdb/duckdb-wasm';
import wasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import workerURL from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import { hardenConnection } from '../src/sql-security-runtime';

// A separate, disposable database deliberately bypasses AST validation to prove
// the runtime layer independently. No raw application connection is exposed.
export async function testRuntimeRestrictions() {
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: wasm, mainWorker: workerURL },
    eh: { mainModule: ehWasm, mainWorker: ehWorker },
  });
  if (!bundle.mainWorker) throw new Error('No compatible bundle.');
  const worker = new Worker(bundle.mainWorker);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  const results: string[] = [];
  let connection: duckdb.AsyncDuckDBConnection | undefined;
  try {
    await db.instantiate(bundle.mainModule);
    connection = await db.connect();
    // The real app resolves Parquet while creating trips, before hardening.
    await connection.query('LOAD parquet');
    await connection.query('CREATE TABLE trips AS SELECT 1 AS n');
    await connection.query('CREATE VIEW protected_view AS SELECT * FROM trips');
    await hardenConnection(connection);
    const blocked = async (sql: string, expected: string) => {
      try { await connection!.query(sql); }
      catch (error) {
        if (!String(error).toLowerCase().includes(expected.toLowerCase())) throw error;
        results.push(sql); return;
      }
      throw new Error(`Runtime unexpectedly allowed: ${sql}`);
    };
    for (const sql of ['CREATE TABLE forbidden(a INTEGER)', 'DROP TABLE trips', 'DROP VIEW protected_view']) {
      await connection.query('BEGIN TRANSACTION READ ONLY');
      try { await blocked(sql, 'read-only'); }
      finally { await connection.query('ROLLBACK'); }
    }
    for (const sql of [
      "SELECT * FROM read_csv('/not-approved.csv')",
      "SELECT * FROM read_parquet('https://example.invalid/forbidden.parquet')",
      "COPY trips TO '/not-approved.csv'",
      "COPY trips FROM '/not-approved.csv'",
      "ATTACH '/not-approved.duckdb' AS forbidden",
    ]) await blocked(sql, 'disabled');
    await blocked('SET enable_external_access=true', 'locked');
    await blocked("SET allowed_paths=['/']", 'locked');
    await blocked('SET autoload_known_extensions=true', 'locked');
    const result = await connection.query('SELECT n FROM trips');
    if (String(result.getChildAt(0)?.get(0)) !== '1') throw new Error('Runtime attacks changed trips.');
    return { passed: results.length, blocked: results };
  } finally {
    try { await connection?.close(); } finally {
      try { await db.terminate(); } finally { worker.terminate(); }
    }
  }
}
