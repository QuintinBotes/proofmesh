# Graph benchmark: ProofMesh vs Graphify

Thirteen code-graph questions an agent asks (callers, implementers, importers, dependents, call paths, type users,
dead code, cycles, entry points, hubs), asked of both tools on a copy of the Orbit repository at commit `5bd5dffa`
(874 TypeScript files in its tsconfig program). Ground truth comes from the TypeScript compiler's own checker, not
from either tool. Both tools run offline: Graphify code-only (`graphify update`, no model call), ProofMesh with no model.

## Run it

From the root of this clone:

```sh
pnpm install --frozen-lockfile && pnpm build
rm -rf .bench-data                      # only for a cold ProofMesh build; the benchmark never uses the default data directory
sh bench/graph-bench/run-all.sh [<orbit-clone-or-url> [<copy-dir>]]
```

- `<orbit-clone-or-url>` defaults to `https://github.com/QuintinBotes/orbit.git` (public); a local
  clone works too. It is cloned once into `<copy-dir>` (default `$TMPDIR/graph-bench-orbit`) and checked out at
  `5bd5dffa`, the commit `questions.json` names symbols at.
- Never pass a working checkout as `<copy-dir>`: `incremental.sh` edits two files there and restores them with
  `git checkout`.
- Needs Node 22.13+, `graphify` on `PATH` (`uv tool install graphifyy`; results below are 0.9.108), `sqlite3`, git,
  and `/usr/bin/time` (peak memory). `PM_DATA_DIR` moves ProofMesh's data directory (default `.bench-data/` here).
- It takes about five minutes. Everything it writes goes to `out/` and `.bench-data/`, both ignored by git.

| File | What it does |
|---|---|
| `run-all.sh` | Clones and pins the copy, times both full builds, then runs the three steps below |
| `truth.mjs` | Ground truth from the TypeScript checker: symbols, calls with call-site lines, references, resolved imports (static and `import()`), heritage clauses. `node truth.mjs <repo> <out.json>` |
| `questions.json` | The 13 questions and their targets |
| `run.mjs` | Asks each question of Graphify (CLI over `graphify-out/graph.json`) and ProofMesh (MCP in its default lean envelope, paging to the end), scores recall and precision against the truth, reports each answer's bytes (the symbol lookup apart) and bytes per correct row, and writes `out/results.md`, `out/results.json` and every raw answer under `out/raw/` |
| `incremental.sh` | Rebuild cost: no change, a one-function edit to a widely imported file and a leaf file, and each revert |
| `mcp-client.mjs` | A minimal MCP stdio client that times each call |
| `pm` | The ProofMesh CLI from this clone, pointed at the benchmark's data directory |

## Results (2026-11-15)

Graphify 0.9.108; ProofMesh 0.1.0 from this repository; truth: TypeScript 6.0.3 checker; macOS, Node 26.13.1.

| Question class | Q | ProofMesh | Graphify |
|---|---|---|---|
| Direct callers, recall | Q1 | **96%** | 78% |
| Instance-method callers, recall | Q2 | **83%** | 17% |
| Interface-method callers, recall | Q3 | 0% | **56%** |
| Classes implementing an interface | Q4 | 0% | **100%** |
| Files importing a file | Q5 | unreachable through any agent tool | **100%** |
| Transitive dependents of a file | Q6 | unreachable through any agent tool | **99%** |
| Callers up to 3 hops | Q7 | **100%** | 77% |
| Shortest call path | Q8 | **correct** (5 hops) | wrong: 3 hops that follow imports |
| Files using a type | Q9 | 0% | **100%** |
| Full build | | 50 s, 1.6 GB peak | **29 s, 0.3 GB** |
| Rebuild after a one-function edit | | 27–59 s (re-analyses 902 of 905 files) | **12–19 s** |
| Disk | | 254 MB, plus 157 MB per rebuild | **20 MB** |
| Answer size | | ~15x larger, some rows without line numbers | **smaller** |
| Time per question | | **10–220 ms** | 0.5–3.3 s |

"Unreachable" means the right answer exists in ProofMesh's snapshot but no MCP tool gets there: the module symbol
`find_symbols` returns has no import edges, and the `file_` id that has them is returned by no tool. `run.mjs` looks
that id up in the snapshot to show the data is there (Q5 then scores 100%); `analyze_impact` refuses a `file_` id, so
Q6 scores 0%. Since #40, `run.mjs` asks Q5 and Q6 by path through MCP only (see the 2026-11-20 results below). Q10–Q12 have no tool in either product; `run.mjs` computes them from `graph.json` and from the sealed
snapshot, so they measure the data, not an agent's reach:

| Q | Question | ProofMesh R / P (from snapshot) | Graphify R / P (from graph.json) |
|---|---|---|---|
| Q10 | Dead top-level functions | 100% / 4% | 75% / 6% |
| Q11 | Files in an import cycle | 100% / 100% | 78% / 100% |
| Q12 | Entry points (modules nothing imports) | 100% / 89% | 100% / 100% |

The per-question table `run.mjs` prints (recall / precision, milliseconds, answer bytes, MCP calls, whether every row
cites a file and line):

| Q | kind | truth | Graphify R / P | ProofMesh R / P | Graphify ms / bytes | ProofMesh ms / bytes / calls | file:line G / P |
|---|---|---|---|---|---|---|---|
| Q1 | callers | 23 | 78% / 100% | 96% / 100% | 831 / 1107 | 162 / 18369 / 2 | y / y |
| Q2 | callers | 12 | 17% / 100% | 83% / 77% | 1310 / 192 | 40 / 33619 / 2 | y / y |
| Q3 | callers | 9 | 56% / 100% | 0% / - | 950 / 367 | 12 / 783 / 1 | y / n |
| Q4 | implementations | 7 | 100% / 100% | 0% / - | 1198 / 510 | 23 / 1829 / 2 | y / n |
| Q5 | importers | 60 | 100% / 100% | 100% / 100% | 1246 / 4123 | 16 / 28180 / 2 | y / y |
| Q6 | dependents | 453 | 99% / 100% | 0% / - | 1026 / 38953 | 17 / 1210 / 2 | y / n |
| Q7 | transitive_callers | 101 | 77% / 99% | 100% / 100% | 1317 / 4503 | 20 / 23463 / 2 | y / n |
| Q8 | path | - | invalid 3 hops (shortest 5) | valid 5 hops (shortest 5) | 3316 / 256 | 44 / 16351 / 3 | n / n |
| Q9 | type_users | 68 | 100% / 99% | 0% / - | 911 / 7000 | 10 / 1823 / 2 | y / n |
| Q10 | dead_code | 4 | 75% / 6% (graph) | 100% / 4% (graph) | 7 / 0 | 22 / 0 / 0 | n / n |
| Q11 | cycles | 40 | 78% / 100% (graph) | 100% / 100% (graph) | 5 / 0 | 26 / 0 / 0 | n / n |
| Q12 | roots | 8 | 100% / 100% (graph) | 100% / 89% (graph) | 13 / 0 | 111 / 0 / 0 | n / n |

Call sites (file:line): Q1 ProofMesh 100% / Graphify 78%; Q2 100% / 4%; Q3 - / 26%.

Peak memory is the largest single process `/usr/bin/time` reports (for ProofMesh, the TypeScript adapter, about
1.5 GiB). Disk is `du -sh` of the data directory and of `graphify-out/`.

Two reruns of `run-all.sh` on 2026-11-16, each with a new data directory, reproduced every recall, precision and byte
figure above (ProofMesh sealed the same snapshot id each time). Times varied on the same machine: full build Graphify
19 s (307 MB), ProofMesh 30–33 s (1.6 GB); rebuild after an edit Graphify 12–22 s, ProofMesh 25–52 s; ProofMesh's data
directory grew 161–224 MB per rebuild. Compare times as the median of several runs.

## Results after #40 (2026-11-20)

Q5 and Q6 asked by path through MCP only: `get_relationships` with `path`, `direction: in`, `types: [imports]`, and
`analyze_impact` with `paths`, `types: [imports]`, `max_depth` 12 and `max_bytes` 1 MiB (it does not page). No snapshot
lookup remains for either. Same commit, same Graphify; one run on a shared, loaded machine, so times are not comparable.

| Q | ProofMesh R / P | ProofMesh ms / bytes / calls | Graphify R / P |
|---|---|---|---|
| Q5 importers (60) | **100% / 100%** | 43 / 28006 / 1 | 100% / 100% |
| Q6 dependents (453) | **100% / 100%** | 702 / 136916 / 1 | 99% / 100% |
| Q11 cycles (40, from snapshot) | 100% / 100% | | 78% / 100% |
| Q12 entry points (8, from snapshot) | 100% / **100%** (was 89%: `import()` is now recorded) | | 100% / 100% |

Every other row reproduced its earlier recall and precision. The Orbit snapshot's unresolved imports fell from 1,571
to 23: built-ins resolve to `node:<name>`, 17 JSON schema imports are `not_indexed`, 2 `import()` calls have computed
specifiers, and 4 imports in test fixtures do not resolve. Q6's answer is 3.5x Graphify's bytes; lean rows are #41.

## Lean answers (2026-11-20, #41)

`run.mjs` now asks ProofMesh in its default MCP envelope, lean: one `name path:line` row per result. It reports the bytes of
the answering call(s), the symbol lookup apart (Graphify's is not counted either), and bytes per correct row. A row is correct
when what it states is true: for a caller question a true caller at a true call site, otherwise the caller, implementer, file
or dependent it names. ProofMesh lists a caller once per call site, Graphify once per caller. Same Orbit copy, same sealed
snapshot as above; Graphify 0.9.108.

| Q | ProofMesh answer bytes / calls | lookup bytes | correct rows G / P | bytes per correct row G / P | ProofMesh within 2x | file:line G / P |
|---|---|---|---|---|---|---|
| Q1 callers | 1,271 / 1 | 144 | 18 / 24 | 62 / 53 | 0.85x | y / y |
| Q2 instance-method callers | 2,298 / 1 | 623 | 2 / 44 | 96 / 52 | 0.54x | y / y |
| Q5 importers | 2,029 / 1 | 192 | 60 / 60 | 69 / 34 | 0.49x | y / y |
| Q7 callers to 3 hops | 5,781 / 1 | 133 | 78 / 101 | 58 / 57 | 0.98x | y / y |
| Q8 call path | 308 / 1 (Graphify 256) | 277 | - | - | 308 ≤ 512 bytes | n / y |
| Q3, Q4, Q6, Q9 | pending #39 and #40, which make them answerable | | | | | |

Q8's answer names every hop as `name path:line`, so the path needs no `get_symbol` per node. Per correct item rather than
per row, Q2 is 230 bytes against Graphify's 96 (2.4x): its 12 callers make 47 calls, and Graphify lists one site per caller
(4% of the call sites). The other questions are within 2x either way (Q1 58 / 62, Q5 34 / 69, Q7 57 / 58).

## Dead code, cycles, entry points and hubs through tools (2026-11-27, #34)

`run.mjs` now asks Q10 to Q12 of `find_unused`, `find_cycles` and `find_entry_points`, and a new Q13 (the ten symbols with the
most distinct callers and referrers in the truth) of `find_hubs`, over MCP from a second server started with `--tools extra`, so
the default listing the first server measures is unchanged. Nothing is read from the snapshot's SQL. Graphify's answers are
still computed from `graph.json` (Q13 the same way: distinct sources per target over its use relations). Same Orbit copy and
sealed snapshot (`snap_7be31f93fdcb4923d3b72b56`); Graphify 0.9.108.

| Q | Question (tool call) | ProofMesh R / P | ms / bytes | Graphify R / P (graph.json) |
|---|---|---|---|---|
| Q10 | Dead top-level functions (`find_unused` kinds function, path_prefix `src/`, rows tagged `unused`) | 100% / 100% | 831 / 4,906 | 75% / 6% |
| Q11 | Files in an import cycle (`find_cycles` path_prefix `src/`, type-only included) | 100% / 100% | 135 / 9,713 | 78% / 100% |
| Q12 | Modules nothing under `src/` imports (`find_entry_points`, rows tagged `not_imported`) | 100% / 80% | 188 / 991 | 100% / 100% |
| Q13 | The ten hubs by fan-in (`find_hubs` top 10) | 7 of 10 | 285 / 910 | 5 of 10 |

- Q10: the four functions the snapshot-SQL answer added (`src/isolation/srt-chromium-preload.d.mts`) are `possibly_used`: a test
  loads the JavaScript module beside them by path and calls them on an untyped value, which an unresolved call by name could
  reach. 48 functions only tests use are `reachable_only_by=test`, not `unused`.
- Q12: the two extras are `src/isolation/srt-chromium-preload.mjs` and its `.d.mts`, which nothing imports (node loads the
  preload by path). The truth's program (`src/**/*.ts`) does not hold either file, so it cannot count them.
- Q13: the truth's top ten holds `run-store.ts` `id` and `state` and `context.ts` `run`, properties ranked by their reads; the
  TypeScript adapter records no property read as a reference, so `find_hubs` ranks `OrbitConfig`, `Clock` and the test harness
  `Lab` in their place.

## Symbol identity across renames and moves (issue 7, SC-2)

`node bench/graph-bench/identity-mutation.mjs [<orbit-clone-or-url>] [--n 50] [--seed 7]` clones the same Orbit commit into a temporary directory, renames 25 and moves 25 random top-level functions (one per file, seeded), commits, indexes both trees with `index --rev`, and checks what `compare_snapshots` pairs. It exits 1 on any wrong pair or a paired rate below 95%. Result of 2026-11-24 (seed 7, 3,881 candidate functions in 685 files): 50 of 50 mutated functions paired as `renamed` or `moved` with the right target, 0 wrong pairs among 50 pairs, 0 ambiguous, 0 below the pairing floor. About 80 seconds.

### Go compiler facts for the per-language benchmark

The Go input for #9 is Cobra v1.8.1. The corpus file pins its commit and license, the Go image digest, and the release archives of scip-go and the upstream SCIP reader. Prepare the input once with Python 3, Git, curl and Docker. The pinned container platform is Linux arm64 and requires Docker emulation on other architectures.

```sh
python3 bench/graph-bench/go-truth.py prepare ~/.cache/proofmesh/cobra-v1.8.1
python3 bench/graph-bench/go-truth.py run ~/.cache/proofmesh/cobra-v1.8.1 --out out/go/compiler-facts.jsonl
```

Preparation fetches the corpus, checks the archive hashes and verifies the downloaded Go modules. The second command takes the shared benchmark lock and runs two independent indexer processes with a read-only checkout, a read-only module cache, networking disabled and a 2 GiB container memory limit. Each index is read with the upstream SCIP CLI. The output file is published only after both runs agree.

Each JSON line represents a symbol, a site or a declared relationship. Sites retain the document path, position encoding, SCIP identifier, role bits and source and enclosing ranges. Relationships retain every flag from the indexer. Sorting records preserves repeated occurrences and removes variation in the order of the protobuf records.

On the pinned Cobra checkout both runs produced 37 documents, 3,672 symbol records, 21,617 occurrences and eight declared relationships. The SHA-256 of the JSON lines was `9f43976797cf4b0b052d4bcfcf34d40557fc14560428840ca9cf892a96275a06`. These are compiler observations. The per-question scores, independently reviewed truth sets and supported-tier decision remain tracked in #9.
