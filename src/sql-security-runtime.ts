import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { validatedQuery } from './sql-security';

// Trusted initialization only. Do not pass user strings into these statements.
export async function hardenConnection(connection: AsyncDuckDBConnection): Promise<void> {
  // Resolve the built-in JSON parser before disabling extension autoloading.
  await connection.query("SELECT json_serialize_sql('SELECT 1')");
  for (const sql of [
    "SET allowed_paths = ['taxi.parquet']",
    'SET enable_external_access = false',
    'SET autoinstall_known_extensions = false',
    'SET autoload_known_extensions = false',
    'SET allow_community_extensions = false',
    'SET lock_configuration = true',
  ]) await connection.query(sql);
  for (const [setting, expected] of [
    ['enable_external_access', 'false'],
    ['autoinstall_known_extensions', 'false'],
    ['autoload_known_extensions', 'false'],
    ['allow_community_extensions', 'false'],
    ['allow_unsigned_extensions', 'false'],
    ['lock_configuration', 'true'],
  ]) {
    const result = await connection.query(`SELECT current_setting('${setting}')`);
    if (String(result.getChildAt(0)?.get(0)) !== expected) {
      throw new Error(`Required DuckDB security setting was not applied: ${setting}`);
    }
  }
  // Fail initialization if this runtime cannot enforce a read-only transaction.
  await connection.query('BEGIN TRANSACTION READ ONLY');
  await connection.query('ROLLBACK');
}

export async function runRestrictedQuery(
  connection: AsyncDuckDBConnection,
  sql: string,
  onBrokenTransaction: () => void,
) {
  return validatedQuery(sql, async (input) => {
    // Binding the SQL as a parameter prevents quote/comment/semicolon injection
    // into the trusted parser call. Serialization parses; it does not execute input.
    const parser = await connection.prepare('SELECT json_serialize_sql(CAST(? AS VARCHAR)) AS ast');
    try {
      const table = await parser.query(input);
      return JSON.parse(String(table.getChildAt(0)?.get(0)));
    } finally {
      await parser.close();
    }
  }, async (approvedSQL) => {
    await connection.query('BEGIN TRANSACTION READ ONLY');
    try {
      return await connection.query(approvedSQL);
    } finally {
      try { await connection.query('ROLLBACK'); }
      catch {
        onBrokenTransaction();
        throw new Error('Database transaction cleanup failed. Reload the page before running more SQL.');
      }
    }
  });
}
