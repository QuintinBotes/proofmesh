# M2 evidence: depth for agents

M2 as the goal states it: incremental indexing with clean-versus-incremental equivalence, strict freshness and watcher reconciliation, resumable jobs, integrity-protected cursors, Streamable HTTP, `analyze_impact`, `find_tests`, `search_sources`, claims with `verify_claim`, memory notes, `get_job`, `request_index`, the Claims view, A2, A4, and a benchmark baseline. The plan adds TypeScript adapter depth on the maintainer's open-source repositories.

Every item below is proven by the test named, and `pnpm verify` runs all of them. `policy/traceability.json` maps each requirement to its tests, and `pnpm check:traceability` checks the mapping.

## Items and proof

| Item | Proof |
|---|---|
| `analyze_impact`, potential impact with its limits stated (FR019) | `packages/proofmesh/test/impact.test.ts` |
| `find_tests`, static test reach kept apart from observed coverage | `packages/proofmesh/test/find-tests.test.ts` |
| `search_sources`, lexical search over captured sources | `packages/proofmesh/test/search-sources.test.ts` |
| Memory notes and `get_memory`, with dependency staleness | `packages/proofmesh/test/memory.test.ts` |
| `save_memory`, notes proposed by agents | `packages/proofmesh/test/memory.test.ts` |
| Structured claims and `verify_claim`, layered outcomes | `packages/proofmesh/test/claims.test.ts` |
| `get_claims` and the Claims view | `e2e/claims.spec.ts` |
| `request_index` and `get_job`, background jobs with progress | `packages/proofmesh/test/jobs.test.ts` |
| MCP over Streamable HTTP on loopback | `packages/proofmesh/test/mcp-http.test.ts` |
| Integrity-protected cursors (FR021) | `packages/proofmesh/test/cursor.test.ts` |
| Resumable jobs (FR007) | `packages/proofmesh/test/resume.test.ts` |
| Strict freshness, and no snapshot from a tree edited mid-index (FR012, FR013) | `packages/proofmesh/test/freshness.test.ts` |
| Watcher reconciliation (FR009) | `packages/proofmesh/test/watch.test.ts` |
| Incremental indexing with clean equivalence (FR008, FR014, SC004, A16) | `packages/proofmesh/test/incremental.test.ts`, `packages/proofmesh/test/fact-cache.test.ts` |
| A2, external inputs in snapshot identity | `packages/proofmesh/test/csharp.golden.test.ts`, `packages/proofmesh/test/typescript-packages.test.ts` |
| A4, unresolved calls by reason, percentages only from 20 sites | `apps/observatory/test/share.test.ts` |
| Benchmark baseline | `pnpm bench`, results in `bench/results/` |
| TypeScript depth: installed packages, git ignore rules (A19), one program per project | `packages/proofmesh/test/typescript-packages.test.ts`, `packages/proofmesh/test/discovery.test.ts`, `packages/proofmesh/test/typescript-projects.test.ts` |

## Equivalence

`packages/proofmesh/test/incremental.test.ts` indexes a fixture, changes it, indexes again, and compares the result with a clean index of the changed tree, row by row, for ten changes: an edit, an edit in a referenced project, a rename, a delete, a branch switch, a configuration change, a dependency change, an analysis-mode change, an edit beside a linked file, and a TypeScript edit. Each also asserts how many files' facts were replayed, so the test fails if the cache is bypassed.

## Measured results

- Incremental indexing on a large private C# repository: an index after a one-line edit in a leaf project was faster than a clean index and replayed every file outside the edited project. What remains is loading the workspace and writing a full snapshot. The numbers are kept with the private evaluation results, outside this repository.
- TypeScript depth on the maintainer's open-source repositories, indexed read-only: unresolved calls fell from 39% to 0.6% on `orbit` once installed packages were read and ignored agent worktrees were left out. On `warden` and `tervin`, the calls that remain unresolved are mostly test globals in files their project configurations exclude, and workspace packages typed through unbuilt output; `tsc` reports the same. Repositories with nothing installed report `dependency_missing` instead of `unknown_name`.

## Amendments made during M2

A16 (incremental indexing by per-file replay), A17 (the `service` kind, snapshot format 0.3), A18 (inbound candidate callers), and A19 (git ignore rules) are recorded in `docs/proofmesh/adr/0001-proofmesh.md`, section 10.

## Known limits

- `find_tests` follows static reach only, so tests that reach code through dependency injection or a transaction context are not found.
- The C# adapter in trusted-build mode declares no units, so any change reanalyses every file there.
- An implementation inherited from a base class is not linked to the interface member it implements.
- Agents connected over MCP did not call Proofmesh unprompted in the parity evaluation; the M8 plugin needs a prompt that points them to it.
