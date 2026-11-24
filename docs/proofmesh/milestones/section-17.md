# Plan section 17, item by item

`specs/001-proofmesh-foundation/plan.md` section 17 lists the work of each milestone. The goal that drove M0 to M8 renumbered the later milestones (its M5 is the ecosystem, M6 Replay and Diff, M7 verification execution, M8 release readiness), so this table maps every section 17 item to the goal milestone that delivered it and to its proof. Every test named runs in `pnpm verify`; `pnpm check:traceability` checks the requirement mapping separately.

## M0 and M1

| Plan item | Goal milestone | Proof |
|---|---|---|
| M0 walking skeleton | M0 | `m0-walking-skeleton.md`; AC01 to AC33 in the test suite, AC35 run privately |
| M1.1 trust grants, `TRUST_REQUIRED`, mode in identity and provenance | M1 | `m1-evidence.md`; `cli.e2e.test.ts` (CLI-only grants) and `csharp.golden.test.ts` (the sentinel fixture, mode in identity) |
| M1.2 the Roslyn indexer re-hosted as `adapters/csharp` | M1 | C# golden fixtures, `pnpm conformance` (C# entry) |
| M1.3 no-execution mode | M1 | sentinel marker absent; unresolved reasons for restore-dependent targets (`csharp.golden.test.ts`) |
| M1.4 trusted mode, mode badges | M1 | mode in every envelope; Observatory badge legend (FR057) |
| M1.5 private overlay as a third-party adapter | M1 | the overlay repository loads as an installed extension; results private |
| M1.6 parity run on the large private C# codebase | M1 | 20 of 20 on the final build; results in the gitignored `eval/results/` |
| M1.7 the old tool surface removed | M8 (A15) | pre-publication history; plugin replaced |

## M2: depth for agents

| Plan item | Goal milestone | Proof |
|---|---|---|
| Incremental indexing and clean equivalence | M2 | `incremental.test.ts` |
| Strict freshness and watcher reconciliation | M2 | `freshness.test.ts`, `watch.test.ts` |
| Resumable jobs | M2 | `resume.test.ts` |
| Cursors | M2 | `cursor.test.ts` |
| Streamable HTTP | M2 | `mcp-http.test.ts` |
| `analyze_impact`, `find_tests`, `search_sources` | M2 | `impact.test.ts`, `find-tests.test.ts`, `search-sources.test.ts` |
| Claims with `verify_claim`, the Claims view | M2 | `claims.test.ts`, `e2e/claims.spec.ts` |
| Memory notes | M2 | `memory.test.ts` |
| `get_job`, `request_index` | M2 | `jobs.test.ts` |
| Benchmark baseline | M2 | `pnpm bench`, results in `bench/results/` |
| TypeScript adapter depth on the maintainer's open-source repositories | not in the goal's M2 | TypeScript depth is proven on fixtures (`typescript-packages.test.ts`, `typescript-projects.test.ts`); no open-source repository of the maintainer was indexed |

## M3: Galaxy and React

| Plan item | Goal milestone | Proof |
|---|---|---|
| Galaxy rendering spike | M3, measured after M8 | `research.md` "Galaxy rendering"; `bench/observatory/frames.mjs` |
| Aggregates in snapshot files, `get_overview` | M3 | `overview.test.ts` |
| Galaxy view with fog and stable layout | M3 | `apps/observatory/test/galaxy.test.ts`, `e2e/galaxy.spec.ts` |
| Export with embedded caveats | M3 | `apps/observatory/test/exporting.test.ts` |
| Accessibility audit | M3 | `e2e/accessibility.spec.ts`, `docs/proofmesh/accessibility.md` |
| React framework adapter | M3 | `react.test.ts` |

## M4: Python and Terraform

| Plan item | Goal milestone | Proof |
|---|---|---|
| Python semantic-engine spike | M4 | `research.md` "Python semantic engine" |
| Python adapter | M4 | `python.test.ts`, `python.frameworks.test.ts` |
| Terraform adapter | M4 | `terraform.test.ts` |
| Adapter protocol v1 | M4 | `adapter-host.test.ts` and the conformance kit |
| Public conformance kit and authoring guide | M4 | `pnpm conformance`, `docs/proofmesh/adapter-authoring.md` |

## M5 in the plan: release and publication

| Plan item | Goal milestone | Proof |
|---|---|---|
| npm package and OCI image | M8 | `release.test.ts`; image built and run (`m8-evidence.md`) |
| Signing, SBOM, provenance | M8 | `release.test.ts` |
| Bundles and the offline checker | M8 | `bundle.test.ts` |
| Backup and restore | M8 | `backup.test.ts` |
| Retention and garbage collection | M8 | `gc.test.ts` |
| Client certification for Claude Code and Codex | M8 | `mcp-config.test.ts`, `plugin.test.ts`; SC006 run with both clients |
| Open-source scaffolding | M8 | `release.test.ts` |
| Publication gate | M8 | `release.test.ts` (export and leak scan to a local directory) |
| First public release | a person's step | not done by design: nothing is published |

## M6 and later in the plan

| Plan item | Goal milestone | Proof |
|---|---|---|
| Replay, Diff, `compare_snapshots`, `list_queries` | M6 | `m6-evidence.md`; `compare.test.ts`, `list-queries.test.ts`, `e2e/replay.spec.ts`, `e2e/diff.spec.ts` |
| Framework adapters for wiring: routes, jobs, DI | M1, M5 and after | C# (`csharp.frameworks.test.ts`), Python (`python.frameworks.test.ts`), TypeScript (`typescript.routes.test.ts`) |
| Links from cloud resources to services (A26) | after M8 (A35) | `packages/proofmesh/test/cloud-links.test.ts`, `fixtures/cloud-links` |
| Verification execution (Gate D) | M7 | `verification.test.ts` |
| Shared hosting (Gate E) | not in the goal | Gate E is not opened |
