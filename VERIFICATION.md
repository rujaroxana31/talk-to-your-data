# Final Verification Report

## 1. Verification Summary

Recorded run: **2026-10-29**. **10/10 golden cases passed**: nine generated queries and one correct abstention.
Model: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, temperature 0, maximum 512 output tokens.
Real inference used a local Cloudflare Worker with the remote `AI` binding; generated SQL executed locally in Chrome/DuckDB-WASM through the existing security gate.

Dataset: `public/data/yellow_tripdata_2022-01.parquet`, **38,139,949 bytes, 2,463,931 rows, 19 columns**. Every row/column decoded successfully during dataset inspection.
Pinned SHA-256: `797d6f008e67c3e3371b7f957ab97dbc2b38a9fb0ac083cb5eae4b0297b32372`.
The native reference calculation checked this checksum before and after reading the file.

Evidence types are distinct: golden answers use independent local DuckDB reference queries; golden generation and the CORS smoke test use **real Workers AI**; repeatable failure/UI tests use **mocked AI responses**.
Outbound-payload tests verify that the application sends questions and curated metadata, not dataset rows, results or Parquet bytes. Callers must not paste sensitive data into questions.
Generation does not execute SQL automatically. Manual, generated and edited SQL share `executeSQL`; the Worker never executes SQL.

The following are excerpts from the recorded successful run, not tests rerun for this documentation refactor:

```text
npm test
# tests 73
# pass 73
# fail 0

npm run test:golden
  "gateTests": 92,
  "failures": []
  "runtimeTests": 11,
  "generationChecks": 12,
  "goldenPassed": 10,
  "goldenFailed": 0,
PASS: 4 editor checks; one Parquet request; no unexpected requests or uncaught browser errors.

npm run worker:test:http
# tests 7
# pass 7
# fail 0
# skipped 0
```

TypeScript and the Vite production build passed (`npm run build`); Wrangler bundling passed (`npm run worker:check`, dry-run only). Nothing was deployed.
The real browser CORS smoke test generated the credit-card count without executing it; explicit Run SQL returned **1,874,874**. An unauthorized Origin received **403** before inference.

## 2. Golden Questions and Results

Definitions, reference SQL and expected shapes are fixed in [golden-cases.json](tests/golden-cases.json).
[golden-reference.json](tests/golden-reference.json) contains independently measured answers; [golden-report.json](tests/golden-report.json) preserves exact AI SQL, actual rows, HTTP statuses and timings (`mocked: false`).
All records are included unless the question specifies otherwise; no implicit positive-value filters or deduplication are applied.

| ID | Natural-language question | Expected answer / shape | Actual verified result | Status |
| --- | --- | --- | --- | --- |
| G01 | How many trips are in the dataset? | 2,463,931; 1 row × 1 count | 2,463,931 | PASS |
| G02 | How many trips had pickup timestamps in January 2022? | 2,463,879; 1 row × 1 count | 2,463,879 | PASS |
| G03 | How many trips were paid by credit card? | 1,874,874; 1 row × 1 count | 1,874,874 | PASS |
| G04 | How many trips were paid in cash? | 495,171; 1 row × 1 count | 495,171 | PASS |
| G05 | What is the average trip distance in miles across all records? | 5.37275119311366 miles; 1 row × 1 number | 5.37275119311366 | PASS |
| G06 | What is the average metered fare, using fare_amount, across all records? | $12.946484016795376; 1 row × 1 number | 12.946484016795376 | PASS |
| G07 | What is the total recorded revenue, defined as SUM(total_amount), across all records? | $47,232,005.22967679; 1 row × 1 number | 47232005.22967679 | PASS |
| G08 | How many trips have a known passenger count of exactly one? | 1,794,055; 1 row × 1 count | 1,794,055 | PASS |
| G09 | Which five pickup location IDs had the most trips? Return the pickup location ID and trip count, ordered by count descending and then pickup location ID ascending. | 5 ordered rows × 2 columns: (237,121630), (236,120814), (132,103485), (161,88237), (186,80580) | All five ordered pairs matched | PASS |
| G10 | What was the total amount of actual cash tips? | Not derivable: HTTP 422, `UNANSWERABLE`; no SQL execution | HTTP 422, `UNANSWERABLE`; no SQL returned/executed | PASS |

G07 is a floating-point sum of recorded charges (approximately **$47,232,005.23**), not audited profit or a total including unrecorded cash tips.
All nine answerable native/browser references agreed. The final ten-question run required no retries and had no provider errors; that does not predict future availability.

## 3. Semantic Correctness and RAG Evaluation

1. [verify-golden-reference.py](scripts/verify-golden-reference.py) executes only trusted reference SQL against the actual pinned Parquet file, in a read-only native DuckDB 2.0.0 transaction. It never executes model output.
2. [golden.browser.ts](tests/golden.browser.ts) requests SQL from the real Worker, passes it through `executeSQL` and compares actual rows, column positions and ordering against those references. Aliases may differ.
3. Counts/IDs are exact. Floating aggregates use the unchanged tolerance `abs(actual - expected) <= 1e-7 + 1e-10 * abs(expected)`. Shape alone never earns a pass; G10 requires the specified 422 error code.
4. The recorded SQL was also reviewed for filters, aggregation, units, date boundaries and metric definitions. January uses a half-open pickup range `[2022-01-01, 2022-02-01)`; payment codes are 1=credit card and 2=cash; metered fare differs from total charge; null passengers are not zero; locations are IDs, not inferred boroughs.

This catches valid-looking SQL that answers the wrong question. It does not establish correctness for every paraphrase, coincidentally equivalent query, ambiguous metric, dataset error or future model version. Recorded anomalies remain in all-record aggregates.

**Real retrieval comparison:** five paired questions used the same model, essential schema, instructions and settings; only supplementary retrieved documentation changed. Correct abstention counted as a correct decision.

| Question | Without retrieval | With retrieval | Retrieved snippet IDs |
| --- | --- | --- | --- |
| Credit-card trip count | Correct `payment_type=1` | Correct `payment_type=1` | `payments` |
| Cash trip count | Incorrect `payment_type=1` | Correct `payment_type=2` | `payments` |
| January pickups | Correct year/month predicate | Correct half-open timestamp range | `dates` |
| Average distance across all records | Correct `AVG(trip_distance)` | Correct `AVG(trip_distance)` | `distance` |
| Actual cash-tip total | Incorrect sum of recorded credit-card tips | Correct `UNANSWERABLE` | `fares`, `payments`, `tips` |

Result: **3/5 correct decisions without retrieval versus 5/5 with retrieval**. This is a small real-model experiment, not a general accuracy guarantee or statistical benchmark.
Four initial provider failures preceded one complete retry: 20 inference attempts total. Those failures are not silently counted as successes. Temperature zero did not guarantee identical repeated SQL text.
[scripts/compare-retrieval.ts](scripts/compare-retrieval.ts) reproduces the comparison. The separate mocked ablation in `tests/worker.test.mjs` verifies context plumbing only; it is not evidence of model improvement.

**Retrieval evidence retention:** the table above records the observed comparison, but no raw paired-response artifact was found in the searched project tests, local Wrangler logs or project-related temporary directories. Unlike the saved golden report, the comparison has no portable raw-response report identified here. No outputs were reconstructed and no inference was rerun to fill that gap.

## 4. SQL Validator Attack Tests

**Browser evidence:** [sql-cases.ts](tests/sql-cases.ts) and [security.browser.ts](tests/security.browser.ts) cover 22 permitted queries, 67 rejected malicious/unsupported inputs and 3 recovery/concurrency/empty-result checks: **92 passed**.
Rejection requires `SQLValidationError`, not an incidental binder error. [security.unit.test.mjs](tests/security.unit.test.mjs) also checks that rejected ASTs never reach the execution callback.

DuckDB's native `json_serialize_sql(CAST(? AS VARCHAR))` parses bound input as data. The policy requires one SELECT and recursively checks CTEs (including unused ones), subqueries, expressions and modifiers.
Only unqualified `trips`, validated in-scope CTEs, supported built-in types and allowlisted analytical functions are accepted. Unknown AST fields/classes fail closed; regex/prompt instructions are not the security boundary.
There is no explicit column-name allowlist: DuckDB binding rejects nonexistent columns. This differs from the original plan's proposed approved-column check; the browser tests cover the resulting binder error and recovery.

| Attack category | Representative tested SQL | Observed result and blocking mechanism |
| --- | --- | --- |
| Stacked statements | `SELECT 1; SELECT 2` / `SELECT * FROM trips; DROP VIEW trips` | Blocked in browser: exactly-one-statement policy or native SELECT-only serialization error. |
| Hidden CTE operations | `WITH unused AS (SELECT nextval('x')) SELECT COUNT(*) FROM trips` | Blocked in browser: every CTE definition is traversed, even if unused; `nextval` is not allowlisted. |
| Nested file access | `SELECT * FROM trips WHERE EXISTS (SELECT * FROM read_csv('/etc/passwd'))` | Blocked in browser: nested table-function source rejected. |
| SQL comments | `SELECT 1; -- hidden` followed by a newline and `DROP VIEW trips` | Blocked in browser: native parsing exposes the extra statement. Harmless comments and SQL-looking string literals were separately accepted. |
| Filesystem functions | `SELECT * FROM read_csv('/etc/passwd')`; `SELECT * FROM glob('*')` | Blocked in browser: all user table functions are prohibited; corpus also covers `read_parquet`, `read_blob`, `read_text` and implicit file paths. |
| Network/file URLs | `SELECT * FROM read_parquet('https://example.invalid/private.parquet')` | Blocked in browser before access: prohibited table function. URL-based CSV/JSON and implicit remote-file sources also tested. |
| ATTACH / DETACH | `ATTACH '/tmp/private.duckdb' AS private`; `DETACH memory` | Blocked in browser: not an accepted SELECT statement. |
| COPY TO / FROM | `COPY trips TO '/tmp/leak.csv'`; `COPY trips FROM '/tmp/input.csv'` | Blocked in browser: non-SELECT operations. |
| State changes | `DROP TABLE trips`; `DROP VIEW trips`; `INSERT INTO trips SELECT * FROM trips`; `UPDATE trips SET fare_amount=0`; `DELETE FROM trips` | All blocked in browser before execution; CREATE and ALTER also tested. |
| Unsafe scalar/dynamic functions | `SELECT nextval('secret') FROM trips LIMIT 1`; `SELECT query('DROP VIEW trips')` | Blocked in browser: function allowlist; environment/configuration and serialized-SQL functions also rejected. |
| Other tables / configuration | `SELECT * FROM information_schema.tables`; `SET enable_external_access=true` | Blocked in browser: table-source restriction or non-SELECT rejection; CTE shadowing and recursion also tested. |

**Independent runtime evidence:** [runtime-restrictions.browser.ts](tests/runtime-restrictions.browser.ts) uses a separate disposable database and intentionally tests the engine without AST filtering: **11 passed**.
It verifies read-only transaction rejection of CREATE TABLE and DROP TABLE/VIEW; external-access rejection of local CSV, remote Parquet, COPY TO/FROM and file ATTACH; and locked-setting rejection of attempts to enable external access, widen allowed paths or enable extension autoloading.
These runtime claims are narrower than the browser corpus: runtime rejection of every scalar function or DETACH was not independently established.

Defense in depth: approved queries run in `BEGIN TRANSACTION READ ONLY`, followed by rollback. Initialization disables external access with only registered `taxi.parquet` excepted, disables extension auto-install/autoload/community loading, verifies unsigned extensions disabled, and locks configuration. Required restrictions fail closed if unavailable.
The editor rejected DROP VIEW and two cleverer variants, then returned **2,463,879** for January; it also rejected malicious generated SQL. No recorded historical run proves the earlier ungated app actually dropped its view: the former direct `connection.query(sql)` path established exposure, not a captured exploit.

**Not complete security:** expensive allowed SELECTs can exhaust resources; arbitrary JavaScript/DevTools, compromised dependencies and DuckDB defects are outside this SQL-input boundary. Only Chrome's selected bundle was verified; no comprehensive browser/filesystem/network isolation claim is made.

## 5. Known Failures and Limitations

| Observed failure or fragile case | Discovery / reproduction and diagnosis | Fix or mitigation, final evidence, remaining limit |
| --- | --- | --- |
| Incorrect cash mapping — real AI | The real no-retrieval cash question generated `payment_type=1`. Missing category context allowed a plausible but wrong guess. | Retrieved payment mapping corrected it to `=2`; G04 returned 495,171. The validator cannot detect a safe but semantically wrong filter; other paraphrases remain unproven. |
| Incorrect cash-tip interpretation — real AI | The real no-retrieval cash-tip question generated `SELECT SUM(tip_amount) FROM trips WHERE payment_type = 1`, substituting recorded card tips for unrecorded cash tips. | Retrieved coverage caveat and explicit abstention produced G10's 422. Abstention is model-dependent, not a complete deterministic unsupported-question classifier. |
| Parser parameter typing — observed runtime failure | Preparing `SELECT json_serialize_sql(?)` failed even for valid input: the first argument had to be VARCHAR. The untyped placeholder did not meet DuckDB's contract. | Bound `CAST(? AS VARCHAR)` fixed it; all 92 browser checks and nine generated golden queries passed. AST/runtime version changes still require retesting. |
| Provider failures — real inference | Four payment-pair calls returned `MODEL_UNAVAILABLE` before the successful comparison retry. Sanitized errors do not reveal the provider's root cause; a warm-up explanation is unproven. | Controlled 502, explicit retry and continued manual SQL are tested. The final golden run had no provider errors, but future availability is not guaranteed; cancellation does not guarantee stopping remote billing. |
| Resource exhaustion — unresolved risk, not an observed crash | Read-only does not bound query cost. Rendering only 200 rows does not limit computation or the full result held in memory; no destructive stress test was performed. | SQL-length/AST-complexity bounds and rendering cap reduce some exposure; reliable SQL timeout/cancellation and measured memory limits remain absent. |

Timeouts and cancellation were tested with controlled mocks; no real 30-second provider timeout was observed in the final run. These must not be reported as live timeout evidence.
The installed WASM package is prerelease `1.33.1-dev57.0`. A forced MVP probe raised `_setThrew is not defined`; fallback/other-browser reliability remains unverified. Joins, windows, set operations and some otherwise-safe SQL are deliberately unsupported.
CORS is restricted but is not authentication; public quota/abuse controls are absent. Payload checks cover application-generated requests, not arbitrary sensitive text pasted into a question.

**PLAN.md follow-through still outstanding:** both a [local Git clone](#local-git-clone-verification) and a [fresh GitHub clone](#fresh-github-clone-verification) were verified successfully, but complete setup time was not measured, so the under-ten-minute requirement remains unverified. Browser memory measurement remains outstanding; five-hour timebox compliance is not substantiated by the available evidence. Git history includes the original plan (`ffcd41c`) and application (`58501ce`); the fresh GitHub clone verified commit `f7d31fc`. The earlier [clean-copy setup evidence](#clean-copy-setup-evidence) below records a separate measured experiment and its limitations.
The question-only API deviation is already documented in README's **Verification and Limitations** section: one fixed dataset uses server-owned schema rather than a request dataset identifier. `PLAN.md` remains unchanged as the original preimplementation planning snapshot; its unresolved assumptions and status statements describe that point in time. No production deployment is required to establish these local results.

## 6. How to Reproduce

Prerequisites: Node 22.20+, `npm ci`, the pinned Parquet file, and installed Chrome/Chromium (`CHROME_PATH` if not auto-detected). See [README.md](README.md) for frontend/Worker setup and environment variables.
To run deterministic unit/API tests, TypeScript/build checks, a non-deploying Worker bundle check and browser security/UI tests without inference quota:

```powershell
npm test
npm run build
npm run worker:check
Remove-Item Env:LIVE_AI_BASE_URL -ErrorAction SilentlyContinue
Remove-Item Env:RUN_GOLDEN -ErrorAction SilentlyContinue
npm run test:browser
```

For the seven offline HTTP tests, run `npm exec -- wrangler dev --local --ip 127.0.0.1 --port 8790 --inspector-port 9233` in one terminal; in another:

```powershell
$env:WORKER_TEST_URL = 'http://127.0.0.1:8790'
$env:WORKER_EXPECT_NO_AI = '1'
npm run worker:test:http
```

For real golden inference, authenticate using `npm exec -- wrangler login` with Workers AI access/quota. Start the local Worker (not a deployment):

```powershell
npm exec -- wrangler dev --ip 127.0.0.1 --port 8789 --inspector-port 9232 --var FRONTEND_ORIGIN:http://127.0.0.1:5186
```

Then, in another terminal:

```powershell
$env:LIVE_AI_BASE_URL = 'http://127.0.0.1:8789'
npm run test:golden
```

This runs the browser suite, one real CORS smoke request and ten real golden requests. It writes `tests/golden-report.json` before asserting the score; failures remain recorded and exit nonzero. Vite/Chrome are started/stopped by the harness. If changing `TEST_PORT`, also change the Worker's allowed origin.
To independently regenerate the native reference fixture, use an existing Python DuckDB installation: `python scripts/verify-golden-reference.py --duckdb-path <installation-directory>`. Omit the flag if already importable. The script checks dataset identity and overwrites only the reference fixture; it installs nothing. The saved fixture permits browser testing without Python.
Repeating the real retrieval comparison requires authenticated Wrangler, Workers AI access and available inference quota. To repeat it, run `npm run worker:compare`, then `Invoke-RestMethod -Uri http://127.0.0.1:8788/compare -Method Post | ConvertTo-Json -Depth 8`. It makes ten real calls and reports both variants plus snippet IDs; it never executes SQL. Repeated outcomes may differ.

### Fresh GitHub clone verification

These results were supplied from the completed verification in `C:\Users\rujat\Desktop\talk-to-your-data-github-test`; they were not rerun for this documentation update. The repository was downloaded directly from GitHub on branch `master`, and commit **`f7d31fc`** was confirmed:

```powershell
git clone --branch master https://github.com/rujaroxana31/talk-to-your-data.git talk-to-your-data-github-test
```

| Check | Recorded result |
| --- | --- |
| `npm ci` | **105 packages installed**, approximately **5 seconds**, **0 reported vulnerabilities** |
| `npm test` | **73 passed, 0 failures** |
| `npm run build` | TypeScript checks passed; Vite production build completed successfully |
| `npm run test:browser` | **92 SQL security gate tests**, **11 DuckDB runtime restrictions**, **12 mocked-AI generation/UI checks** and **4 SQL editor checks** passed |
| Browser errors/requests | No unexpected requests or uncaught browser errors |

This verifies remote repository transfer, installation, build and the browser checks from the published commit. The AI responses in this browser run were **mocked**; no real Workers AI request was executed in this fresh GitHub clone. Earlier real inference, golden results and local-clone measurements remain separate evidence.
Only dependency installation has a reported approximate duration for this run. Complete setup elapsed time was not measured, so this does not establish setup in under ten minutes. Deployment, browser memory and the historical five-hour timebox remain unverified; zero reported npm vulnerabilities is not a comprehensive security guarantee.

### Local Git clone verification

The following results were supplied from the completed clone verification; they were not rerun for this documentation update.
A real local `git clone --no-hardlinks` contained both commits, `ffcd41c docs: add initial implementation plan` and `58501ce feat: implement Talk to Your Data application`, plus `package.json` and the pinned Parquet dataset. The cloned working tree was clean.

| Check | Recorded result |
| --- | --- |
| Dependency installation | `npm ci` succeeded in **16.270 seconds** |
| Unit/API tests | `npm test`: **73 passed, 0 failed** |
| Production build | `npm run build`: successful |
| Browser tests | `npm run test:browser`: **92 security gate tests**, **11 runtime restrictions**, **12 generation/UI checks** and **4 editor checks** passed |
| Frontend | Started successfully on port **5173** |
| Cloudflare Worker | Responded successfully on port **8787**, using the remote Workers AI binding |
| Real generation and execution | “How many trips were paid by credit card?” → `SELECT COUNT(*) FROM trips WHERE payment_type = 1` → **1,874,874** |
| Browser DuckDB initialization | **542.9 ms** |
| Browser dataset loading | **195.5 ms** |
| Browser SQL validation/execution/conversion | **51.1 ms** |

This verifies the committed application from a **local Git clone**, including one real-model end-to-end query; it does not represent a rerun of the ten-question golden set. Only `npm ci` was timed for setup. The browser phase timings are separate measurements, not a complete setup duration; they do not establish browser memory usage.
Complete setup time, prerequisite installation/account provisioning time, remote GitHub cloning and deployment were not verified by this exercise. Workers AI inference requires authentication, access and available quota. The previous clean-copy total below must not be attributed to this clone run or combined with its timings.

### Clean-copy setup evidence

In the earlier experiment on 2026-10-29, before the application commit, a local `git clone --no-hardlinks` succeeded but contained **only PLAN.md**, with no `package.json`. That historical attempt did not establish a runnable clone; the successful post-commit clone verification is recorded above.
A separate clean-copy test copied the 39 files listed by `git ls-files --cached --others --exclude-standard` into an empty temporary directory. It copied no `node_modules`, build output, `.wrangler` state or private environment files; installation used a new empty npm cache:

```text
npm ci --cache <NEW_EMPTY_CACHE_DIRECTORY> --prefer-online
```

Servers used test-only ports 5192/8792 (inspector 9234), `VITE_API_BASE_URL=http://127.0.0.1:8792`, and `--var FRONTEND_ORIGIN:http://127.0.0.1:5192`. These were process-level overrides; project configuration was not changed for the test.
Times were measured with a monotonic clock to HTTP readiness; total elapsed time ran from the start of clone/copy preparation through the successful real browser query, including coordination pauses.

| Measurement | Observed time |
| --- | ---: |
| Copy working files | 0.081 s |
| Dependency installation (`npm ci`, fresh cache) | 12.697 s |
| Frontend process launch → HTTP 200 | 0.580 s |
| Worker process launch → permitted preflight 204 | 7.748 s |
| Preparation → both servers ready | 21.877 s |
| Browser navigation → dataset/database ready | 1.962 s |
| Total elapsed → successful real generated query and explicit execution | **90.864 s** |

The clean copy returned **2,463,879** for January, then real AI SQL `SELECT COUNT(*) FROM trips WHERE payment_type = 1` returned **1,874,874** after explicit Run SQL. There was no automatic execution or uncaught browser error. Its TypeScript/production build also passed.
This measures a working-copy installation in under ten minutes **with Node/npm/Git/Chrome and Cloudflare CLI authentication already available**. It excludes installing those prerequisites, interactive account setup/login, and any remote repository transfer. It is not proof of the assessment's genuine clean-clone requirement.
The temporary harness, manifest, installation log, measurements and browser result were retained under `%TEMP%/talk-to-your-data-setup-597i0wfz/` on the test machine; they are not runtime prerequisites. The original project, dataset and Git history were not altered by that test.
