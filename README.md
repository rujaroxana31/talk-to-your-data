# Talk to Your Data

## Overview

Ask natural-language questions about NYC Yellow Taxi trips using RAG and Cloudflare Workers AI. Review or edit the generated SQL, then select **Run SQL** to execute it locally in DuckDB-WASM and view a table.
Generation never executes SQL automatically. Dataset rows and Parquet bytes are never automatically sent to the LLM; only the question and curated metadata are sent. Do not paste rows or secrets into questions.

## Architecture

**Flow:** question → Cloudflare Worker → lexical retrieval → Workers AI SQL → editable SQL → browser security gate → DuckDB-WASM → results.

| Component | Responsibility |
| --- | --- |
| React + TypeScript | Question input, editable SQL, loading/error/retry states and results. |
| DuckDB-WASM + browser Web Worker | Loads Parquet as the `trips` view; reuses one local connection and executes off the UI thread. |
| Cloudflare Worker | Validates `POST /api/generate-sql`, retrieves metadata and calls `env.AI`; never executes SQL. |
| Lexical retrieval | Always includes the verified schema; selects up to three curated snippets by deterministic keyword scores. No embeddings or vector database. |
| Workers AI | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` proposes DuckDB SQL. Its output is untrusted. |
| SQL security gate | Native AST checks restrict statements, tables and functions; read-only transactions and restricted external access apply to manual, generated and edited SQL. |

Dataset: [official TLC January 2022 yellow taxi Parquet](https://d37ci6vzurychx.cloudfront.net/trip-data/yellow_tripdata_2022-01.parquet), at `public/data/yellow_tripdata_2022-01.parquet`: **38,139,949 bytes, 2,463,931 rows, 19 columns**.
Vite serves the file to the browser and includes it in the production build; it is not sent to the Cloudflare Worker or Workers AI.
SHA-256: `797d6f008e67c3e3371b7f957ab97dbc2b38a9fb0ac083cb5eae4b0297b32372`.

## Prerequisites

- Node.js **22.20+**, npm **11**, and Git for cloning. Project dependencies, including Wrangler, come from the lockfile; no global Wrangler is needed.
- A modern browser supporting WebAssembly/Web Workers; Chrome was verified. Automated browser tests require installed Chrome/Chromium (`CHROME_PATH` if auto-detection fails).
- Internet access and a Cloudflare account with Workers AI access and available inference quota. CLI authentication is separate from dashboard login.

## Quick Start

**Submission status:** only `PLAN.md` is committed; application files are untracked and no remote is configured. A clone of that history is not runnable. The commands below require the eventual complete submission repository; replace the placeholder URL rather than using it literally.

```powershell
$repositoryUrl = 'REPLACE_WITH_SUBMISSION_REPOSITORY_URL'
git clone $repositoryUrl talk-to-your-data
cd talk-to-your-data
npm ci
npm exec -- wrangler whoami
npm exec -- wrangler login  # Only if not already authenticated
```

Confirm the Parquet file is present. From the repository root, start each process in its own terminal.

```text
# Terminal 1: local Worker, remote AI inference
npm run worker:dev
```

```text
# Terminal 2: React frontend
npm run dev -- --port 5173 --strictPort
```

Open **http://127.0.0.1:5173**, not `localhost`. Enter a question → **Generate SQL** → review/edit → **Run SQL**. Manual SQL remains available during AI failures; the prefilled January query returns **2,463,879**.

`wrangler.jsonc` sets Worker name `talk-to-your-data-api`, binding `AI` with `remote: true`, and `FRONTEND_ORIGIN=http://127.0.0.1:5173`. The handler runs locally; inference consumes remote quota. Starting it does not deploy or overwrite the deployed Worker.
`VITE_API_BASE_URL` defaults to **http://127.0.0.1:8787** in development. To override it, run `Copy-Item .env.example .env.local`, edit the URL and restart Vite. If ports/hostnames change, update both this URL and the Worker's exact allowed origin.
The API URL is public configuration; never put secrets in `VITE_` variables. For multiple accounts, set `CLOUDFLARE_ACCOUNT_ID`. Production embeds the configured API URL or defaults to same-origin; hosting/deployment is not configured here.

## Example Questions

All ten cases below were verified. Results use all file records unless a date/filter is explicit; repeated AI outputs may vary. Exact SQL, shapes and scoring are in [VERIFICATION.md](VERIFICATION.md).

| Question | Expected result |
| --- | --- |
| How many trips are in the dataset? | 2,463,931 |
| How many trips had pickup timestamps in January 2022? | 2,463,879 |
| How many trips were paid by credit card? | 1,874,874 |
| How many trips were paid in cash? | 495,171 |
| What is the average trip distance in miles across all records? | 5.37275119311366 miles |
| What is the average metered fare, using fare_amount, across all records? | $12.946484016795376 |
| What is the total recorded revenue, defined as SUM(total_amount), across all records? | Approximately $47,232,005.23 |
| How many trips have a known passenger count of exactly one? | 1,794,055 |
| Which five pickup location IDs had the most trips? Return the pickup location ID and trip count, ordered by count descending and then pickup location ID ascending. | (237,121630), (236,120814), (132,103485), (161,88237), (186,80580) |
| What was the total amount of actual cash tips? | Explicit abstention: HTTP 422 / UNANSWERABLE; cash tips are not recorded |

## Testing

| Command | Coverage | Authentication / inference quota |
| --- | --- | --- |
| `npm test` | Unit/API, retrieval, client failures, payload privacy and CORS | None; model responses mocked |
| `npm run build` | TypeScript checks and production build | None |
| `npm run test:browser` | Real Chrome/React/DuckDB security and UI checks; mocked AI HTTP by default | None if LIVE_AI_BASE_URL and RUN_GOLDEN are unset |
| `npm run worker:check` | Wrangler bundle/binding check (`deploy --dry-run`), no deployment | No inference |
| `npm run worker:test:http` | HTTP checks against a running offline Worker | None; [setup](VERIFICATION.md#6-how-to-reproduce) |
| `npm run test:golden` | Browser suite, real CORS smoke request and ten golden cases | Cloudflare login, Workers AI access and quota required |

For optional real-model golden tests, use separate terminals:

```powershell
# Terminal 1
npm exec -- wrangler dev --ip 127.0.0.1 --port 8789 --inspector-port 9232 --var FRONTEND_ORIGIN:http://127.0.0.1:5186
# Terminal 2
$env:LIVE_AI_BASE_URL = 'http://127.0.0.1:8789'
npm run test:golden
```

The harness manages Vite/Chrome and saves pass/fail details in `tests/golden-report.json`. Unset LIVE_AI_BASE_URL and RUN_GOLDEN for later offline browser runs.
See [reproduction details](VERIFICATION.md#6-how-to-reproduce) for offline HTTP tests, reference regeneration (optional Python/DuckDB), and the real retrieval comparison. No deployment is required.

## Verification and Limitations

Recorded results: **10/10 real-model golden cases**, **73 unit/API tests**, **92 browser security checks** and **11 runtime restriction checks** passed. The small real-model RAG experiment scored **3/5 without retrieval vs. 5/5 with retrieval**, not a general accuracy guarantee.
Clean-copy setup completed in **90.864 seconds** with preinstalled tools and existing authentication. **Genuine clean-clone setup remains unverified**; [measurements and caveats](VERIFICATION.md#clean-copy-setup-evidence) distinguish these tests.

- Include the untracked application/configuration/docs/tests/dataset in the submission and retest its clone. Exclude dependencies, builds, local Worker state and private env/credential files.
- Deviations from the original plan: the single-dataset API accepts only `{question}`; column existence is checked by DuckDB binding, not a separate column-name allowlist.
- Browser memory consumption is unmeasured; reliable SQL timeout/cancellation is not implemented. The historical five-hour timebox is not substantiated.
- SQL can be semantically wrong despite passing validation. The supported subset is deliberately limited, DuckDB-WASM is a prerelease, and other browsers/fallback bundles remain unverified. CORS is not authentication; cancelling generation does not guarantee cancellation of remote inference/billing.

[PLAN.md](PLAN.md) is the unchanged preimplementation snapshot. [VERIFICATION.md](VERIFICATION.md) contains evidence, attack tests and unresolved limitations; [AI-USAGE.md](AI-USAGE.md) explains AI assistance and human responsibility.
