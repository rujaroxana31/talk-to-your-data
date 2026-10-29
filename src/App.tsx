import { useEffect, useRef, useState } from 'react';
import { executeSQL, initializeDatabase, SQL, type Initialization, type Result } from './database';
import { requestGeneratedSQL } from './api';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.DEV ? 'http://127.0.0.1:8787' : '');

export function App() {
  const [question, setQuestion] = useState('');
  const [sql, setSQL] = useState(SQL);
  const [initialization, setInitialization] = useState<Initialization | null>(null);
  const [initializationError, setInitializationError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const mounted = useRef(false);
  const busy = useRef(false);
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [generationNotice, setGenerationNotice] = useState<string | null>(null);
  const generationController = useRef<AbortController | null>(null);
  const generationVersion = useRef(0);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    initializeDatabase()
      .then((value) => { if (active) setInitialization(value); })
      .catch((reason: unknown) => {
        if (active) setInitializationError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false; mounted.current = false;
      generationVersion.current++;
      generationController.current?.abort();
      generationController.current = null;
    };
  }, []);

  function cancelGeneration() {
    generationVersion.current++;
    generationController.current?.abort();
    generationController.current = null;
    setGenerating(false);
    setGenerationNotice(null);
  }

  async function generateSQL() {
    if (generationController.current || busy.current || !question.trim()) return;
    const controller = new AbortController();
    generationController.current = controller;
    const version = ++generationVersion.current;
    setGenerating(true); setGenerationError(null); setGenerationNotice(null);
    try {
      const generated = await requestGeneratedSQL(question, { baseURL: API_BASE_URL, signal: controller.signal });
      if (mounted.current && generationVersion.current === version) {
        setSQL(generated);
        setResult(null); setError(null);
        setGenerationNotice('SQL generated. Review or edit it, then select Run SQL. It has not been executed.');
      }
    } catch (reason) {
      if (mounted.current && generationVersion.current === version) {
        setGenerationError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (mounted.current && generationVersion.current === version) {
        generationController.current = null; setGenerating(false);
      }
    }
  }

  async function runSQL() {
    if (busy.current || !initialization || !sql.trim()) return;
    cancelGeneration();
    busy.current = true;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const value = await executeSQL(sql);
      if (mounted.current) setResult(value);
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      busy.current = false;
      if (mounted.current) setRunning(false);
    }
  }

  return (
    <main>
      <p className="eyebrow">Local SQL workspace</p>
      <h1>Talk to Your Data</h1>
      <p>NYC yellow taxi trips · January 2022</p>
      <section aria-labelledby="query-heading">
        <h2 id="query-heading">Explore the trips dataset</h2>
        <form onSubmit={(event) => { event.preventDefault(); void generateSQL(); }} aria-busy={generating}>
          <label htmlFor="question">Ask a question</label>
          <div className="question-row">
            <input id="question" maxLength={1000} value={question} onChange={(event) => {
              cancelGeneration(); setGenerationError(null); setQuestion(event.target.value);
            }} placeholder="How many trips were paid by credit card?" />
            <button id="generate-sql" disabled={generating || running || !question.trim()} type="submit">{generating ? 'Generating…' : generationError ? 'Retry generation' : 'Generate SQL'}</button>
          </div>
          {generating && <button id="cancel-generation" type="button" onClick={cancelGeneration}>Cancel generation</button>}
        </form>
        <p className="note">Only your question and dataset documentation go to Workers AI. Do not include rows or secrets. Generation never runs SQL.</p>
        {generating && <p role="status" id="generation-status">Generating SQL… You can cancel or continue with manual SQL.</p>}
        {generationNotice && <p role="status" id="generation-status">{generationNotice}</p>}
        {generationError && <p role="alert" id="generation-error" className="error">{generationError}</p>}
        <p className="warning">Read-only SQL: one SELECT over trips or validated CTEs, using supported analytical functions. Table functions, external files, state changes, and unsupported syntax are rejected. Expensive queries can still exhaust browser resources.</p>
        <form onSubmit={(event) => { event.preventDefault(); void runSQL(); }}>
          <label htmlFor="sql">SQL</label>
          <textarea id="sql" value={sql} onChange={(event) => { cancelGeneration(); setSQL(event.target.value); }} spellCheck={false} rows={7} />
          <button id="run-sql" disabled={!initialization || running || !sql.trim()} type="submit">{running ? 'Running…' : 'Run SQL'}</button>
        </form>
        {!initialization && !initializationError && <p role="status">Initializing DuckDB-WASM and loading the Parquet dataset…</p>}
        {initializationError && <p role="alert" className="error">{initializationError} Reload the page to retry initialization.</p>}
        {initialization && <p className="note">Ready · initialization {initialization.initializationMs.toFixed(1)} ms · dataset loading {initialization.loadingMs.toFixed(1)} ms</p>}
      </section>
      <section aria-labelledby="results-heading" aria-busy={running}>
        <h2 id="results-heading">Results</h2>
        {running && <p role="status">Executing SQL…</p>}
        {error && <p role="alert" className="error">{error}</p>}
        {!running && !error && !result && <p>Run a query to see its results.</p>}
        {result && <>
          <p role="status">{result.totalRows} rows · validation, execution and conversion {result.queryMs.toFixed(1)} ms</p>
          {result.totalRows === 0 && <p>No rows returned.</p>}
          {result.columns.length > 0 && <div className="table-scroll"><table>
            <thead><tr>{result.columns.map((name, index) => <th key={index} scope="col">{name}</th>)}</tr></thead>
            <tbody>{result.rows.map((row, rowIndex) => <tr key={rowIndex}>
              {row.map((value, columnIndex) => <td key={columnIndex}>{value === null ? <span className="null">NULL</span> : value}</td>)}
            </tr>)}</tbody>
          </table></div>}
          {result.totalRows > result.rows.length && <p className="note">Showing the first {result.rows.length} rows. Add LIMIT to SQL to reduce the computed result.</p>}
        </>}
      </section>
      <p className="note">DuckDB runs locally in a browser Web Worker. The dataset stays unchanged on disk.</p>
    </main>
  );
}
