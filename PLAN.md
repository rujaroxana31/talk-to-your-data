# Talk to Your Data - Implementation Plan

## 1. Scope and boundaries

**Confirmed requirements:** Build a single-page app with plain-English input, visible/editable/re-runnable SQL, a results table, and loading/error/empty states. A Cloudflare Worker retrieves relevant context and asks an LLM for SQL. Execute SQL locally in browser DuckDB-WASM against roughly 5-50 MB of data. Validate every execution as SELECT-only. The LLM never receives dataset rows. Clean-clone setup must take under ten minutes.

**Agreed choices:** React, TypeScript, Vite, plain CSS, Cloudflare Worker, DuckDB-WASM, NYC taxi Parquet, and static documentation with deterministic lexical retrieval. Exact dataset and model remain unverified.

**Excluded:** Charts, memory, multiple datasets/joins, correction learning, multi-step agents, embeddings, vector databases, reranking, and optional extensions until the core is complete and verified.

## 2. Architecture and data flow

1. Load a verified, pinned Parquet asset as one browser `trips` table. Use the DuckDB worker runtime to keep execution off the UI thread.
2. Send question and dataset identifier to the Cloudflare Worker. It owns matching schema metadata and documentation: column meanings, units, dates, metrics, and synthetic question-to-SQL examples.
3. Rank snippets lexically with stable tie-breaking. Send question, schema, selected snippets, and restrictive instructions to the LLM. Keep credentials in Worker secrets/bindings; return SQL.
4. Display editable SQL. Validate generated and edited queries through the same gate immediately before local execution, then display results or readable errors.

**Rationale:** One table simplifies validation and reference answers. Static retrieval avoids vector infrastructure; measure whether it helps. The identifier selects trusted metadata. Never transmit rows, results, or data-bearing errors to the Worker/model. Local execution and the no-rows boundary are assessment requirements.

**Proposed safeguards, unverified:** Structurally parse exactly one read query; allow approved tables, columns, and functions. Inspect nested expressions, CTEs, and table functions; reject mutations, external reads, unsupported syntax, and parse failures. Investigate DuckDB external-access/configuration restrictions as additional protection. Limit rendered results and investigate cancellation because read queries can exhaust resources.

## 3. Technical risks and early experiments

- **Unsafe SQL or parser mismatch:** Before generation, test legitimate analytics and attacks: stacked statements, CTEs, comments, filesystem/network functions, `ATTACH`, and `COPY ... TO`. Verify DuckDB syntax compatibility and runtime restrictions; narrow the subset if necessary.
- **Semantically wrong answers:** Define roughly ten golden questions and independently checked reference SQL/results early. Cover dates, nulls, fare versus total, recorded tips, and grouping. Compare identical questions/model/settings with and without retrieval; report variability honestly.
- **Dataset/browser/setup failure:** Before app implementation, verify official TLC file bytes, schema, dictionary, row count, dates, and quality. Record source, checksum, and reproducible preparation. Then measure browser loading, representative queries, responsiveness, and memory; compressed size is insufficient. Rehearse clean setup.

## 4. Verification and deliverables

Provide runnable golden questions with expected values/shapes and pass/fail output. Check semantics against reference queries with explicit ordering, tolerances, and filters. Exercise real generation/execution and distinguish model, validator, and runtime failures. Demonstrate retrieval improvement over no context.

Check editing/re-running, loading/error/empty states, a sensible question-to-table result, and readable rejection of "Drop table trips" plus two cleverer variants. Record the attack matrix and gaps; inspect outbound payloads for the no-rows boundary. Verify browser behavior and clean-clone setup.

Deliver README setup commands, environment variables/bindings, exact model ID, and five to ten working questions. `VERIFICATION.md` contains golden output, semantic checks, validator attacks, and at least three actual failures/fragilities with diagnoses. Half-page `AI-USAGE.md` records tools, delegated work, rejected/rewritten output and why, plus one confidently wrong agent claim and how it was caught. No tests have run.

## 5. Assumptions and open decisions

- Pin one public NYC taxi file for reproducibility; select only after verification. Parquet is preferred by the brief and agreed here. Exclude borough-name questions without a lookup; retain one table.
- Use metadata/synthetic examples, never sampled rows. Document metric definitions and ambiguity limits for single-query analytics.
- Dataset, provider/model, parser, supported grammar, DuckDB restrictions, asset delivery, performance, and local commands remain unverified.
- Assume reviewer-supplied model credentials; minimize provisioning and document it. Hosted deployment is not explicitly required; acceptance uses the real model.

## 6. Five-hour schedule and deviations

| Elapsed | Checkpoint |
| --- | --- |
| 0:00-0:25 | Finalize plan, verify dataset, draft golden questions. After approval, commit plan first, before code; no commit now. Cap dataset selection at thirty minutes. |
| 0:25-1:05 | Prove browser loading/reference queries; capture schema and expectations. |
| 1:05-1:50 | Build/attack validation gate; investigate runtime restrictions. |
| 1:50-2:35 | Add Worker, retrieval, LLM; complete first question-to-table loop. |
| 2:35-3:15 | Finish UI states/editing; run golden checks continuously. |
| 3:15-4:10 | Run golden set, retrieval comparison, attacks; fix consequential failures. |
| 4:10-5:00 | Rehearse setup; finish README, verification, AI usage, known failures, deviations. |

Planning/investigation count toward five hours; subtract time already spent. At the limit, stop and document unfinished work, next steps, and why. Record deviations here: original decision, replacement, and evidence that changed it. **Current deviations: none; implementation has not started.**
