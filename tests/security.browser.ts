import { executeSQL, initializeDatabase, SQL } from '../src/database';
import { SQLValidationError } from '../src/sql-security';
import { validSQL, rejectedSQL } from './sql-cases';

export async function runSecurityChecks() {
  const results: { test: string; pass: boolean; detail?: string }[] = [];
  const check = async (name: string, run: () => Promise<void>) => {
    try { await run(); results.push({ test: name, pass: true }); }
    catch (error) { results.push({ test: name, pass: false, detail: String(error) }); }
  };
  await Promise.all([initializeDatabase(), initializeDatabase()]);
  for (const sql of validSQL) await check(`allow: ${sql}`, async () => { await executeSQL(sql); });
  for (const sql of rejectedSQL) await check(`reject: ${sql}`, async () => {
    try { await executeSQL(sql); } catch (error) {
      // An engine error is not evidence that the validation gate blocked execution.
      if (error instanceof SQLValidationError) return;
      throw new Error(`Reached engine or failed unexpectedly: ${String(error)}`);
    }
    throw new Error('Unsafe/unsupported SQL was accepted.');
  });
  await check('concurrent queries and January count after attacks', async () => {
    const [count, average] = await Promise.all([executeSQL(SQL), executeSQL('SELECT AVG(trip_distance) FROM trips')]);
    if (count.rows[0]?.[0] !== '2463879' || !average.rows.length) throw new Error('Wrong results after attacks.');
  });
  await check('binder error does not poison read-only transaction or queue', async () => {
    let failed = false;
    try { await executeSQL('SELECT nonexistent_column FROM trips'); } catch { failed = true; }
    if (!failed || (await executeSQL(SQL)).rows[0]?.[0] !== '2463879') throw new Error('Recovery failed.');
  });
  await check('empty result', async () => {
    if ((await executeSQL('SELECT * FROM trips WHERE FALSE')).totalRows !== 0) throw new Error('Wrong empty result.');
  });
  return { passed: results.filter((result) => result.pass).length, failed: results.filter((result) => !result.pass), results };
}
