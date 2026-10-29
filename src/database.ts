import * as duckdb from '@duckdb/duckdb-wasm';
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import { hardenConnection, runRestrictedQuery } from './sql-security-runtime';

export const SQL = `SELECT COUNT(*) AS trip_count
FROM trips
WHERE tpep_pickup_datetime >= TIMESTAMP '2022-01-01'
AND tpep_pickup_datetime < TIMESTAMP '2022-02-01';`;

export type Initialization = { initializationMs: number; loadingMs: number };
export type Result = {
  columns: string[];
  rows: (string | null)[][];
  totalRows: number;
  queryMs: number;
};

type Session = {
  db: duckdb.AsyncDuckDB;
  connection: duckdb.AsyncDuckDBConnection;
  worker: Worker;
  timing: Initialization;
  healthy: boolean;
};

let initialization: Promise<Session> | undefined;
let queue: Promise<void> = Promise.resolve();
let disposal: Promise<void> | undefined;
let disposed = false;

// Attempt every cleanup step without replacing the original initialization error.
async function release(db?: duckdb.AsyncDuckDB, connection?: duckdb.AsyncDuckDBConnection, worker?: Worker) {
  try { await connection?.close(); } catch (error) { console.warn('DuckDB connection cleanup failed', error); }
  try { await db?.terminate(); } catch (error) { console.warn('DuckDB termination failed', error); }
  worker?.terminate();
}

async function createSession(): Promise<Session> {
  let db: duckdb.AsyncDuckDB | undefined;
  let connection: duckdb.AsyncDuckDBConnection | undefined;
  let worker: Worker | undefined;
  let stage = 'initializing DuckDB-WASM';
  try {
    const start = performance.now();
    const bundle = await duckdb.selectBundle({
      mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
      eh: { mainModule: ehWasm, mainWorker: ehWorker },
    });
    if (!bundle.mainWorker) throw new Error('No compatible Web Worker bundle.');
    worker = new Worker(bundle.mainWorker);
    db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    connection = await db.connect();
    const initializationMs = performance.now() - start;

    stage = 'loading the Parquet dataset';
    const loadingStart = performance.now();
    const response = await fetch(`${import.meta.env.BASE_URL}data/yellow_tripdata_2022-01.parquet`);
    if (!response.ok) throw new Error(`Dataset request failed: HTTP ${response.status}.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== 38_139_949) throw new Error('Dataset size differs from the verified file.');
    await db.registerFileBuffer('taxi.parquet', bytes);
    await connection.query("CREATE VIEW trips AS SELECT * FROM read_parquet('taxi.parquet')");
    const loadingMs = performance.now() - loadingStart;
    stage = 'applying required SQL security restrictions';
    await hardenConnection(connection);
    return { db, connection, worker, healthy: true, timing: { initializationMs, loadingMs } };
  } catch (error) {
    await release(db, connection, worker);
    throw new Error(`Failed while ${stage}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function getSession(): Promise<Session> {
  if (disposed) return Promise.reject(new Error('The database session is closed. Reload the page.'));
  // Cache the promise immediately: concurrent callers share initialization and its failure.
  return initialization ??= createSession();
}

export async function initializeDatabase(): Promise<Initialization> {
  return (await getSession()).timing;
}

function displayValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  // String preserves BIGINT precision and also handles Arrow scalar values.
  return String(value);
}

// Every manual/edited/future generated query goes through this same security gate.
export function executeSQL(sql: string): Promise<Result> {
  if (disposed) return Promise.reject(new Error('The database session is closed. Reload the page.'));
  const task = queue.then(async () => {
    const session = await getSession();
    if (!session.healthy) throw new Error('Database transaction state is uncertain. Reload the page.');
    const start = performance.now();
    const table = await runRestrictedQuery(session.connection, sql, () => { session.healthy = false; });
    const rows: Result['rows'] = [];
    // Limit DOM/conversion work only. DuckDB still computes the entire result.
    for (let row = 0; row < Math.min(table.numRows, 200); row++) {
      rows.push(table.schema.fields.map((_, column) => displayValue(table.getChildAt(column)?.get(row))));
    }
    return {
      columns: table.schema.fields.map((field) => field.name),
      rows,
      totalRows: table.numRows,
      queryMs: performance.now() - start,
    };
  });
  // A rejected query must not poison subsequent queries in the queue.
  queue = task.then(() => undefined, () => undefined);
  return task;
}

export function disposeDatabase(): Promise<void> {
  if (disposal) return disposal;
  disposed = true;
  disposal = (async () => {
    await queue;
    if (!initialization) return;
    const session = await initialization.catch(() => undefined);
    if (session) await release(session.db, session.connection, session.worker);
  })();
  return disposal;
}

// Session ownership belongs to this module, not a component mount.
// Keep the worker alive when the page enters the browser back/forward cache.
function onPageHide(event: PageTransitionEvent) {
  if (!event.persisted) void disposeDatabase();
}
window.addEventListener('pagehide', onPageHide);
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.removeEventListener('pagehide', onPageHide);
    void disposeDatabase();
  });
}
