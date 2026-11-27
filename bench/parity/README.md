# Parity benchmark: ProofMesh and every local alternative

The thirteen question classes of `bench/graph-bench` (callers, implementations, importers, dependents, transitive
callers, call paths, type users, dead code, cycles, entry points, hubs), asked of ProofMesh and of each local tool an agent
could use instead, on one pinned public fixture, and scored on one truth: the TypeScript compiler's own checker
(`bench/graph-bench/truth.mjs`), not any tool. Every tool runs offline and none calls a model.

## Run it

From the root of this clone:

```sh
pnpm install --frozen-lockfile && pnpm build
sh bench/parity/install.sh      # once: the pinned comparators, in user space (network)
sh bench/parity/run.sh          # then read bench/parity/out/parity.md
```

- The fixture is TypeORM at commit `3d55188c0dd1256f520143379ecf97f45e71acba` (0.3.20, MIT). `run.sh` fetches that
  commit once and copies only `src/` and `LICENSE` into a new git repository at `$TMPDIR/parity-typeorm`
  (`PARITY_FIXTURE` moves it), with a `PROVENANCE` note and this `tsconfig.json`, and no `node_modules`, so every tool
  reads the same 504 files. None of its code is ever committed here.

  ```json
  { "compilerOptions": { "target": "es2020", "module": "commonjs", "moduleResolution": "node", "lib": ["es2020"],
      "experimentalDecorators": true, "emitDecoratorMetadata": true, "strict": false, "skipLibCheck": true, "noEmit": true },
    "include": ["src"] }
  ```

- Each run works on its own copy of the fixture, in a new directory under `$TMPDIR` that it names on stderr
  (`parity: fixture copy <dir>`) and removes when it ends; the ProofMesh data, the SCIP index, Serena's home (linked to
  the shared home's language servers) and the results are kept there too. The fixture at `PARITY_FIXTURE` is only
  read, so two runs at once, on one fixture and one `out/`, never edit, index or clean up each other's files: each
  exits 0 with its own table. Each file of `out/` is put in whole, by rename, from the run that wrote it last; when
  two runs end at the same moment, `parity.md`, `results.json`, `truth.json` and `raw/` can come from different runs.
  The first run builds the fixture in a directory of its own and renames it into place, so runs that start together
  with no fixture use one whole copy. A `PARITY_FIXTURE` that exists without a `PROVENANCE` note is refused, not
  replaced.
- Needs Node 22.13+, git, `sqlite3` and `/usr/bin/time`. Comparators are looked up on `PATH`, after
  `$PARITY_TOOLS/bin` and `$PARITY_TOOLS/npm/node_modules/.bin` (default `~/.local/share/proofmesh-parity`, where
  `install.sh` puts them). A comparator that is missing, at another version or failing reads `not run: <reason>` in
  its column; the other columns are still filled and the command exits 0.
- Results go to `out/` (ignored by git; `PARITY_OUT` moves it): `parity.md` (the tables), `results.json` (per tool
  and question: misses, extras, ms, bytes, every build time), `raw/` (each tool's answers) and `truth.json`.
- Times are medians of three runs (`PARITY_RUNS`). A full run takes about half an hour, most of it Graphify and
  scip-typescript builds.

| File | What it does |
|---|---|
| `run.sh` | Builds the fixture once, then runs `run.mjs` |
| `run.mjs` | Copies the fixture, times each tool's builds, asks each question, scores every answer and writes `out/` |
| `questions.json` | The twelve questions and their targets in the fixture |
| `aider-map.py` | aider's `RepoMap.get_repo_map`, run by aider's own Python, offline and with the same maps each run |
| `install.sh` | Installs the pinned comparators in user space |
| `rename.mjs` | After `run.sh` built the fixture: scores `plan_rename`'s code sites for ten pinned symbols against the TypeScript language service's `findRenameLocations`, at `file:line` (#38); exits 1 on any miss or extra |
| `xrepo.sh`, `xrepo.mjs` | Cross-repository calls on a public library and application pair (#28 scenario 4), below |
| `../graph-bench/lib.mjs` | Truth per question, scoring, and the Graphify and ProofMesh adapters, shared with `bench/graph-bench` |

## Cross-repository calls: a library and an application (#28, SC-002)

```sh
sh bench/parity/xrepo.sh        # prints one row per library callee and the share resolved; exits 1 under 95%
```

- The pair is [Excalibur](https://github.com/excaliburjs/Excalibur) at tag v0.32.0 (`7cb426da0dae70eb50a42341a35e7bbd74395579`,
  BSD-2-Clause) and its sample game [sample-tactics](https://github.com/excaliburjs/sample-tactics) at
  `bfe18ba107897ab5c662fdb909fb0b10669daf1a` (BSD-2-Clause), which depends on `excalibur` ^0.32.0. The first run fetches both commits
  and the published package `excalibur@0.32.0` (`npm pack`) once into `$TMPDIR/parity-xrepo` (`PARITY_XREPO` moves it): `lib/` and
  `app/` hold each repository's `src/`, licence, `package.json` and `tsconfig.json` (the library without `src/spec` and
  `src/stories`), `installed/excalibur` the package as `npm install` leaves it, and a `PROVENANCE` note. None of it is ever committed
  here. A `PARITY_XREPO` with no `PROVENANCE` is refused.
- Every run after that is offline. It copies the fixture into a new directory under `$TMPDIR` (named on stderr, removed at exit),
  makes `lib/` and `app/` git repositories, and puts the package at `app/node_modules/excalibur`.
- **Truth:** `bench/graph-bench/truth.mjs` over the application's sources with its own compiler options and `excalibur` mapped to
  the library's `src/engine/index.ts`: every call or `new` in the application whose callee the checker declares in the library.
- **ProofMesh:** both repositories registered and indexed, in one workspace, linked; then, over MCP in the core profile, for each
  callee the truth names, `get_relationships` inbound `calls` with `include_workspace` from the library's side. A truth site counts
  when a resolved row of the application names its `file:line`. A resolved row the truth does not hold is counted as extra.

Run on 2026-11-27 with this change, ProofMesh 0.1.0, TypeScript 6.0.3, on an Apple M5 Max (macOS, Node 26.13.1): the link file holds
400 resolved `calls` and 7 resolved `inherits` from sample-tactics into Excalibur, and

> 400 of 400 application call sites into excalibur resolved to the library's symbol (100.0%); 0 resolved rows the checker does not count.

over 81 library callees (from `vec`, 51 sites, and `delay`, 25, to constructors such as `Actor` and `ImageSource` and members such
as `GraphicsComponent.use` and `Vector.scale`). Two runs in a row gave the same table.

## The comparators

They are benchmark-only tools: no package of this repository depends on one, and none is vendored.

| Tool (licence) | How it is asked |
|---|---|
| Graphify 0.9.108 (Apache-2.0) | `graphify update` (code only), then `graphify affected` and `graphify path` |
| scip-typescript 0.3.15 (Apache-2.0), read with the scip CLI 0.10.0 (Apache-2.0) | `scip-typescript index`, decoded with `scip print --json` |
| Serena v2.1.0 (GPL-3.0-or-later), run only as an external process | `start-mcp-server --context claude-code --agent-interface tools` over MCP: `find_referencing_symbols`, `find_implementations` |
| aider-chat 0.86.2 (Apache-2.0) | `RepoMap.get_repo_map`, the target file in the chat and its file and name mentioned |
| ast-grep 0.51.1 (MIT), for `bench/structure` only | `ast-grep run -p <pattern> -l <language> --json=stream <files>` (`../structure/README.md`) |
| TypeORM (MIT), the fixture | copied at run time, never committed |

A newer version of a comparator is added as a second column, never by replacing the pinned one.

## How each tool is scored

- Items are `file::name` keys, as in `bench/graph-bench`. Callers are scored at three levels: items, `file:line`
  sites and files.
- **SCIP and Serena answer with references, not calls.** Their answers are scored as returned, so their caller
  precision counts the imports and type uses they mix in; nothing is filtered on their behalf.
- **SCIP:** each non-definition occurrence is attributed to the innermost non-local definition whose enclosing range
  holds it; implementations come from `is_implementation` relationships. Importers are the files with an occurrence of
  a file's module symbol. SCIP has no query for dependents, transitive callers or paths: the harness computes them
  from the index, marked `(derived)`, and Q10 to Q12 from the index, marked `(data)`. Time per question is not
  measured, as the answers are read from the decoded index; the decode time is shown instead.
- **Serena:** a caller is mapped to its enclosing named member, as the truth names callers: its name path is cut at
  the first callback (`<function>`, `map() callback`), then kept to a top-level symbol or its member (a deeper name is
  a local of that member), and a top-level symbol's own local variable stands for that symbol. Serena's 0-based lines
  are converted before sites are scored. `find_referencing_symbols` and `find_implementations` are asked for the whole
  answer (`max_answer_chars`), as every tool is.
  Transitive callers repeat `find_referencing_symbols` from each caller found, marked `(derived)`. Serena has no index,
  so its build columns read `live`; its peak memory is that of the server and its language server over the whole
  session.
- **aider** answers no question directly. It is scored as context: the share of the truth's files its map names, at
  1,024 and 4,096 tokens, inbound (the files of the callers, importers, implementers, dependents or type users) and
  outbound (the target file's own imports). Its build time is the map's own time in a fresh tags cache, without
  Python's start-up.
- **aider runs offline** (#187). Its model only counts tokens, but building it reads model prices from
  `~/.aider/caches/model_prices_and_context_window.json` and downloads them from `raw.githubusercontent.com` when that
  file is missing or more than a day old. `aider-map.py` therefore runs aider with a HOME of its own, a new directory
  under `$TMPDIR` removed when it ends, holding a copy of the price file that ships inside the installed litellm
  (`model_prices_and_context_window_backup.json`), written when it starts. So aider never downloads it, and
  `~/.aider` is neither read nor written. Tokens are counted with the tiktoken files bundled in litellm. Any network
  connection or name lookup in that process fails, and the step fails with it (`not run: ... aider tried to reach the
  network (<host>)`).
- **aider's maps are the same in every run** (#191). They varied between runs, even on one copy, and
  `PYTHONHASHSEED=0` did not help, for three reasons:
  - tree-sitter 0.25 returns each capture's nodes in an order that changes with the process's memory, and aider
    0.86.2's `get_tags_raw` counts the last node of each capture twice, so a different reference was counted twice in
    each run;
  - aider weighs an edge with `num_refs = sqrt(num_refs)` inside its loop over a name's defining files (a set), so the
    weights depend on that set's order;
  - Python's string hashing was random, as `-I` ignores `PYTHONHASHSEED`, and a tag held the absolute path of the
    run's copy.
  
  The harness keeps aider's ranking as it is and fixes its inputs. `aider-map.py` sorts each capture's nodes into
  source order and gives aider file names relative to the fixture root. `run.mjs` runs it with `-s -P`, with no
  other `PYTHON*` variable and with `PYTHONHASHSEED=0`, which `aider-map.py` requires. Each run then makes every map a
  second time, in a second copy of the fixture at another path with a fresh tags cache, and `parity.md` says whether
  every map is the same or names the questions and budgets whose maps differ.
- **ProofMesh's context map** (`get_context_map`, #33) is scored as aider's map is: the question's target file as the focus, at
  4,096 and 16,384 bytes (about aider's 1,024 and 4,096 tokens), asked over MCP in the `data` profile; its rows' paths are the
  files it names. `parity.md` shows both beside aider's, per question and as a mean.
- **ProofMesh** is asked over MCP in its default core profile, as `bench/graph-bench` asks it. Q10 to Q13 are asked of
  `find_unused` (rows tagged `unused`), `find_cycles` (type-only cycles included), `find_entry_points` (rows tagged
  `not_imported`) and `find_hubs` (top 10 by fan-in) (#34), through a second server started with `--tools extra`, so the
  `tools/list` bytes below stay those of the default listing. Graphify's Q10 to Q13 are computed from
  `graph.json`, also `(data)`.
- **ProofMesh through `query_graph`** (#36): each question is asked again as one read-only query, over the second
  server started with `--tools extra`, `PARITY_RUNS` times. A target is named by its qualified name; the queries are
  `queryGraphQuery` in `../graph-bench/lib.mjs`, and each answer is in `out/raw/pm-query-<Q>.txt`. Its own table puts each answer's score
  beside the typed tools' answer and says whether their items are the same, with the median time per question and the p95 over Q1
  to Q12, the questions #36 set its target on. That p95 includes the MCP round trip, as every time here does. Q13 (hubs) ranks every
  use, so its count is cut at max_rows before it ranks (FR963).
- `tools/list` bytes are the bytes of the JSON of the tool array an MCP server lists.
- The one-edit rebuild adds `const parityEdit = "<unique>"` after `super(message)` in the constructor of
  `src/error/TypeORMError.ts` (72 files import it), rebuilds, restores the file with `git checkout` and rebuilds again.
  The tool caches inside the run's copy of the fixture (`graphify-out/`, `.serena/`, `.aider.tags.cache.v4/`) are
  added to its `.git/info/exclude`, so `git status --porcelain` there is empty after the run.

## Latest results

Run on 2026-11-27 (`sh bench/parity/run.sh`, medians of three runs), on an Apple M5 Max (18 cores, 64 GB), macOS (Darwin 25.6.0), Node 26.13.1, with this branch's change (#34) built on fc33d43 and not yet committed, which is why the header names fc33d43. Other jobs shared the machine (load average about 45), so the times are several times what they are on an idle machine. Quality, memory, disk and bytes do not depend on load.

Fixture: typeorm @ 3d55188c0dd1256f520143379ecf97f45e71acba (src/, 504 files). ProofMesh 0.1.0 @ fc33d43. Truth: typescript-checker 6.0.3. Run 2026-11-27 on Darwin 25.6.0 arm64, Apple M5 Max x18, 64 GB, Node v26.13.1.

Versions: ProofMesh 0.1.0 @ fc33d43; Graphify 0.9.108; scip-typescript 0.3.15 (scip CLI 0.10.0); Serena 2.1.0 (claude-code context, tools interface); aider 0.86.2.

### Quality: recall / precision (%)

| Q | class | truth | ProofMesh | Graphify | scip-typescript | Serena | aider |
|---|---|---|---|---|---|---|---|
| Q1 | callers | 48 | 100 / 100 | 100 / 100 | 100 / 51 | 100 / 51 | 1k: in 2% out 44%; 4k: in 2% out 61% |
| Q2 | callers | 78 | 100 / 100 | 99 / 100 | 97 / 97 | 100 / 100 | 1k: in 8% out 22%; 4k: in 15% out 59% |
| Q3 | callers | 18 | 100 / 100 | 0 / - | 100 / 100 | 100 / 50 | 1k: in 0% out 61%; 4k: in 0% out 78% |
| Q4 | implementations | 12 | 100 / 100 | 100 / 100 | 100 / 60 | 100 / 57 | 1k: in 0% out 61%; 4k: in 0% out 78% |
| Q5 | importers | 72 | 100 / 100 | 100 / 100 | 100 / 100 | no tool | 1k: in 0% out -; 4k: in 0% out - |
| Q6 | dependents | 316 | 100 / 100 | 98 / 100 | 100 / 100 (derived) | no tool | 1k: in 0% out -; 4k: in 0% out - |
| Q7 | transitive_callers | 11 | 100 / 50 | 91 / 100 | 100 / 12 (derived) | 100 / 34 (derived) | 1k: in 0% out -; 4k: in 0% out - |
| Q8 | path | shortest 3 | valid 3 hops (shortest 3) | valid 3 hops (shortest 3) | valid 3 hops (shortest 3) (derived) | no tool | no tool |
| Q9 | type_users | 85 | 100 / 100 | 100 / 100 | 100 / 100 | 100 / 100 | 1k: in 0% out -; 4k: in 0% out - |
| Q10 | dead_code | 80 | 99 / 95 | 93 / 94 (data) | 93 / 100 (data) | no tool | no tool |
| Q11 | cycles | 300 | 100 / 100 | 94 / 100 (data) | 100 / 100 (data) | no tool | no tool |
| Q12 | roots | 7 | 100 / 100 | 100 / 78 (data) | 100 / 100 (data) | no tool | no tool |
| Q13 | hubs | 10 | 70 / 70 | 60 / 60 (data) | no tool | no tool | no tool |

(derived): computed by the harness from an index that has no query for it. (data): computed from stored data; no tool answers it. aider is scored as context: the share of the truth's files its map names, inbound and outbound, at 1k and 4k tokens.

### Callers at three levels: items · `file:line` sites · files

| Q | ProofMesh | Graphify | scip-typescript | Serena |
|---|---|---|---|---|
| Q1 | 100 / 100 · 100 / 100 · 100 / 100 | 100 / 100 · 89 / 100 · 100 / 100 | 100 / 51 · 100 / 53 · 100 / 100 | 100 / 51 · 100 / 53 · 100 / 100 |
| Q2 | 100 / 100 · 100 / 100 · 100 / 100 | 99 / 100 · 93 / 100 · 92 / 100 | 97 / 97 · 99 / 99 · 100 / 100 | 100 / 100 · 99 / 99 · 100 / 100 |
| Q3 | 100 / 100 · 100 / 100 · 100 / 100 | 0 / - · 0 / - · 0 / - | 100 / 100 · 100 / 100 · 100 / 100 | 100 / 50 · 100 / 50 · 100 / 40 |

### Context map: the share of the truth's files named, inbound / outbound (%)

| Q | focus | ProofMesh get_context_map 4096 bytes | ProofMesh get_context_map 16384 bytes | aider 1k tokens | aider 4k tokens |
|---|---|---|---|---|---|
| Q1 | `src/globals.ts` | in 72% out 100% | in 100% out 100% | in 2% out 44% | in 2% out 61% |
| Q2 | `src/data-source/DataSource.ts` | in 62% out 57% | in 92% out 100% | in 8% out 22% | in 15% out 59% |
| Q3 | `src/driver/Driver.ts` | in 50% out 83% | in 100% out 100% | in 0% out 61% | in 0% out 78% |
| Q4 | `src/driver/Driver.ts` | in 100% out 83% | in 100% out 100% | in 0% out 61% | in 0% out 78% |
| Q5 | `src/error/TypeORMError.ts` | in 53% out - | in 94% out - | in 0% out - | in 0% out - |
| Q6 | `src/util/StringUtils.ts` | in 9% out - | in 27% out - | in 0% out - | in 0% out - |
| Q7 | `src/util/StringUtils.ts` | in 100% out - | in 100% out - | in 0% out - | in 0% out - |
| Q9 | `src/common/ObjectLiteral.ts` | in 47% out - | in 100% out - | in 0% out - | in 0% out - |
| mean | | in 62% out 81% | in 89% out 100% | in 1% out 47% | in 2% out 69% |

Each map is asked with the question's target file as its focus (aider: in the chat, its file and name mentioned). Inbound: the files of the truth's callers, importers, implementers, dependents or type users; outbound: the files the target file imports.

Run on 2026-11-27 with this change (`sh bench/parity/run.sh`, ProofMesh at the branch of #33); the other tables above are from the earlier run. aider's cells in both tables are from two runs in a row on 2026-11-27 with the offline, repeatable aider step (#187, #191), at 247c6af. Every score row of the two runs is equal, their 16 raw aider maps are equal byte for byte, and each run's `parity.md` reads: "aider's 16 maps, made again in a second copy of the fixture at another path with a fresh tags cache: every one is the same." The 16,384-byte maps stop at 100 rows (`limits.max_rows`), 7 to 10 KB, and a cursor pages the rest.

### Cost (medians of 3 runs)

| | ProofMesh | Graphify | scip-typescript | Serena | aider |
|---|---|---|---|---|---|
| Full build | 41.4 s | 10.2 s | 20.6 s | live | 6.1 s |
| Peak memory (largest process) | 459 MB | 187 MB | 402 MB | 169 MB (server and language server, whole session) | 283 MB |
| Disk (own store) | 62 MB | 15 MB | 13 MB | 10 MB | 1 MB |
| No-change re-index | 8.3 s | 770 ms | 15.6 s | live | 811 ms |
| One edit (a statement in the constructor of src/error/TypeORMError.ts) | 23.5 s | 4.5 s | 9.7 s | live | 800 ms |
| ms per question, Q1–Q9 | 67–261 | 210–1004 | n/a (decode 939 ms once) | 370–4743 | 58–616 |
| bytes per answer, Q1–Q9 | 384–24176 | 80–25364 | n/a (decode 939 ms once) | 3449–191986 | 3450–4778 |
| `tools/list` bytes (MCP) | 18338 (13 tools) | CLI | index file | 25188 (21 tools) | Python API |

Fixture after the edit step: clean (tool caches graphify-out/, .serena/, .aider.tags.cache.v4/ are in .git/info/exclude).

Q13 scores the ten symbols each tool ranks first against the truth's ten with the most distinct callers and referrers;
recall and precision are both the share of the ten in common. `find_hubs` misses `QueryBuilder.expressionMap`,
`BaseQueryRunner.connection` and `ColumnMetadata`: the first two are properties the truth ranks by their reads, which the
TypeScript adapter does not record as references. Q10's four extras (`EJSONserialize`, `EJSONdeserialize`, `parse`,
`stringify` in `bson.typings.ts`) are used only as `typeof f` in a type (#175), and its one miss, `createConnection`
of `src/globals.ts`, is `possibly_used`: an unresolved call by that name could reach it.

### ProofMesh through `query_graph` (#36)

Run on 2026-11-27 at ProofMesh 58a2752 (`PARITY_RUNS=3`), on the same machine with a load average about 50, so times are high. Q10 to Q13's typed answers are from the structure tools (#34):

| Q | class | ProofMesh (typed tools) | ProofMesh query_graph | same items as typed | ms (median) |
|---|---|---|---|---|---|
| Q1 | callers | 100 / 100 | 100 / 100 | yes | 44 |
| Q2 | callers | 100 / 100 | 100 / 100 | yes | 27 |
| Q3 | callers | 100 / 100 | 100 / 100 | yes | 11 |
| Q4 | implementations | 100 / 100 | 100 / 100 | yes | 14 |
| Q5 | importers | 100 / 100 | 100 / 100 | yes | 29 |
| Q6 | dependents | 100 / 100 | 100 / 100 | no (+0 −1) | 168 |
| Q7 | transitive_callers | 100 / 50 | 100 / 100 | no (+0 −11) | 19 |
| Q8 | path | valid 3 hops (shortest 3) | valid 3 hops (shortest 3) | yes | 82 |
| Q9 | type_users | 100 / 100 | 100 / 100 | yes | 173 |
| Q10 | dead_code | 99 / 95 | 100 / 95 | no (+1 −0) | 60 |
| Q11 | cycles | 100 / 100 | 98 / 100 | no (+0 −5) | 279 |
| Q12 | roots | 100 / 100 | 100 / 100 | yes | 202 |
| Q13 | hubs | 70 / 70 | 10 / 10 (cut) | no (+9 −9) | 279 |

query_graph p95 over Q1–Q12, 3 runs each: 279 ms (target 500 ms).

- Q6 and Q11 differ because a variable-length pattern follows at most 6 hops (FR962). On Q6, one dependent of `StringUtils.ts` is more than 6 imports away: 315 of 316, which rounds to 100% recall. On Q11, five files are only in import cycles longer than 6.
- Q7 differs on purpose. `analyze_impact` follows calls through the interface method that `DefaultNamingStrategy.columnName` implements; `query_graph` follows only the calls the snapshot resolved. So it equals the truth, which counts direct calls only.
- Q10 says "top-level" as `f.qualified_name ENDS WITH ':' + f.name`. A module path can hold a dot (`bson.typings`), so a test for a dot in the qualified name would drop real functions. Its one item beyond `find_unused` is `createConnection`: `find_unused` calls it `possibly_used`, because an unresolved call by that name could reach it.
- Q13 ranks every call and reference by its target. That is tens of thousands of rows, so `count` is cut at `max_rows` (1,000) before it ranks, and the answer says so (FR963). `find_hubs` answers this question.

### Against the study of 2026-11-20 (scenario 3 of #25)

The study's question targets were not kept, so `questions.json` names its own targets in the same twelve classes.
On Q1 to Q9, against the study's figures (R / P):

| Q | ProofMesh (study / here) | Graphify | scip-typescript | Serena |
|---|---|---|---|---|
| Q1 | 100 / 100 · 100 / 100 | 100 / 100 · 100 / 100 | 100 / 51 · 100 / 51 | 100 / 73 · **100 / 51** |
| Q2 | 100 / 100 · 100 / 100 | 9 / 100 · **99 / 100** | 100 / 100 · **97 / 97** | 94 / 97 · **100 / 100** |
| Q3 | 100 / 100 · 100 / 100 | 0 / - · 0 / - | 100 / 100 · 100 / 100 | 100 / 50 · 100 / 50 |
| Q4 | 100 / 100 · 100 / 100 | 100 / 100 · 100 / 100 | 100 / 60 · 100 / 60 | 100 / 60 · **100 / 57** |
| Q5 | 100 / 100 · 100 / 100 | 100 / 100 · 100 / 100 | 100 / 100 · 100 / 100 | no tool · no tool |
| Q6 | 0 / - · 100 / 100 | 98 / 100 · 98 / 100 | 100 / 100 (derived) · 100 / 100 (derived) | no tool · no tool |
| Q9 | 100 / 100 · 100 / 100 | 100 / 100 · 100 / 100 | 100 / 99 · 100 / 100 | 100 / 99 · 100 / 100 |

Bold cells differ by more than one point; the scorer was not changed to close them.

- Q2 here targets `DataSource.getMetadata`, which two getters call (`Repository.metadata`, `JoinAttribute.metadata`).
  scip-typescript gives a getter no enclosing range, so it names the class and loses those two callers (ProofMesh did
  too until #127). Graphify's 9% in the study was on another target.
- Serena's Q1 and Q4 precision differ with the target: it lists every import line as a `File` reference, and
  `find_implementations` on `Driver` adds subclasses of implementers and `DriverUtils.buildColumnAlias`.
- ProofMesh's Q7 precision (50%) and Serena's are lower because both follow calls through the interface method
  that `DefaultNamingStrategy.columnName` implements; the truth counts direct calls only.
