# Parity benchmark: ProofMesh and every local alternative

The twelve question classes of `bench/graph-bench` (callers, implementations, importers, dependents, transitive
callers, call paths, type users, dead code, cycles, entry points), asked of ProofMesh and of each local tool an agent
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
| `run.mjs` | Times each tool's builds, asks each question, scores every answer and writes `out/` |
| `questions.json` | The twelve questions and their targets in the fixture |
| `aider-map.py` | aider's `RepoMap.get_repo_map`, run by aider's own Python |
| `install.sh` | Installs the pinned comparators in user space |
| `../graph-bench/lib.mjs` | Truth per question, scoring, and the Graphify and ProofMesh adapters, shared with `bench/graph-bench` |

## The comparators

They are benchmark-only tools: no package of this repository depends on one, and none is vendored.

| Tool (licence) | How it is asked |
|---|---|
| Graphify 0.9.108 (Apache-2.0) | `graphify update` (code only), then `graphify affected` and `graphify path` |
| scip-typescript 0.3.15 (Apache-2.0), read with the scip CLI 0.10.0 (Apache-2.0) | `scip-typescript index`, decoded with `scip print --json` |
| Serena v2.1.0 (GPL-3.0-or-later), run only as an external process | `start-mcp-server --context claude-code --agent-interface tools` over MCP: `find_referencing_symbols`, `find_implementations` |
| aider-chat 0.86.2 (Apache-2.0) | `RepoMap.get_repo_map`, the target file in the chat and its file and name mentioned |
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
- **ProofMesh's context map** (`get_context_map`, #33) is scored as aider's map is: the question's target file as the focus, at
  4,096 and 16,384 bytes (about aider's 1,024 and 4,096 tokens), asked over MCP in the `data` profile; its rows' paths are the
  files it names. `parity.md` shows both beside aider's, per question and as a mean.
- **ProofMesh** is asked over MCP in its default core profile, as `bench/graph-bench` asks it; Q10 to Q12 have no MCP
  tool yet (#34) and are computed from the sealed snapshot, marked `(data)`. Graphify's Q10 to Q12 are computed from
  `graph.json`, also `(data)`.
- `tools/list` bytes are the bytes of the JSON of the tool array an MCP server lists.
- The one-edit rebuild adds `const parityEdit = "<unique>"` after `super(message)` in the constructor of
  `src/error/TypeORMError.ts` (72 files import it), rebuilds, restores the file with `git checkout` and rebuilds again.
  The tool caches inside the fixture (`graphify-out/`, `.serena/`, `.aider.tags.cache.v4/`) are added to its
  `.git/info/exclude`, so `git status --porcelain` there is empty after the run.

## Latest results

Run on 2026-11-27 (`sh bench/parity/run.sh`, medians of three runs), on an Apple M5 Max (18 cores, 64 GB), macOS (Darwin 25.6.0), Node 26.13.1. Other jobs shared the machine (load average about 70), so every time below is several times what it is on an idle machine: an earlier run the same day at a lower load measured full builds of 19.0 s (ProofMesh), 8.7 s (Graphify), 4.2 s (scip-typescript) and 4.8 s (aider), and one-edit rebuilds of 8.2 s, 2.2 s, 3.4 s and 1.2 s. Quality, memory, disk and bytes do not depend on load.

Fixture: typeorm @ 3d55188c0dd1256f520143379ecf97f45e71acba (src/, 504 files). ProofMesh 0.1.0 @ f85a3cb. Truth: typescript-checker 6.0.3. Run 2026-11-27 on Darwin 25.6.0 arm64, Apple M5 Max x18, 64 GB, Node v26.13.1.

Versions: ProofMesh 0.1.0 @ f85a3cb; Graphify 0.9.108; scip-typescript 0.3.15 (scip CLI 0.10.0); Serena 2.1.0 (claude-code context, tools interface); aider 0.86.2.

### Quality: recall / precision (%)

| Q | class | truth | ProofMesh | Graphify | scip-typescript | Serena | aider |
|---|---|---|---|---|---|---|---|
| Q1 | callers | 48 | 100 / 100 | 100 / 100 | 100 / 51 | 100 / 51 | 1k: in 2% out 44%; 4k: in 2% out 56% |
| Q2 | callers | 78 | 100 / 100 | 99 / 100 | 97 / 97 | 100 / 100 | 1k: in 8% out 22%; 4k: in 15% out 59% |
| Q3 | callers | 18 | 100 / 100 | 0 / - | 100 / 100 | 100 / 50 | 1k: in 0% out 56%; 4k: in 0% out 78% |
| Q4 | implementations | 12 | 100 / 100 | 100 / 100 | 100 / 60 | 100 / 57 | 1k: in 0% out 56%; 4k: in 0% out 78% |
| Q5 | importers | 72 | 100 / 100 | 100 / 100 | 100 / 100 | no tool | 1k: in 0% out -; 4k: in 3% out - |
| Q6 | dependents | 316 | 100 / 100 | 98 / 100 | 100 / 100 (derived) | no tool | 1k: in 0% out -; 4k: in 0% out - |
| Q7 | transitive_callers | 11 | 100 / 50 | 91 / 100 | 100 / 12 (derived) | 100 / 34 (derived) | 1k: in 0% out -; 4k: in 0% out - |
| Q8 | path | shortest 3 | valid 3 hops (shortest 3) | valid 3 hops (shortest 3) | valid 3 hops (shortest 3) (derived) | no tool | no tool |
| Q9 | type_users | 85 | 100 / 100 | 100 / 100 | 100 / 100 | 100 / 100 | 1k: in 0% out -; 4k: in 0% out - |
| Q10 | dead_code | 80 | 100 / 95 (data) | 93 / 94 (data) | 93 / 100 (data) | no tool | no tool |
| Q11 | cycles | 300 | 100 / 100 (data) | 94 / 100 (data) | 100 / 100 (data) | no tool | no tool |
| Q12 | roots | 7 | 100 / 100 (data) | 100 / 78 (data) | 100 / 100 (data) | no tool | no tool |

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
| Q1 | `src/globals.ts` | in 72% out 100% | in 100% out 100% | in 2% out 44% | in 2% out 56% |
| Q2 | `src/data-source/DataSource.ts` | in 62% out 57% | in 92% out 100% | in 8% out 22% | in 15% out 59% |
| Q3 | `src/driver/Driver.ts` | in 50% out 83% | in 100% out 100% | in 0% out 61% | in 0% out 78% |
| Q4 | `src/driver/Driver.ts` | in 100% out 83% | in 100% out 100% | in 0% out 61% | in 0% out 78% |
| Q5 | `src/error/TypeORMError.ts` | in 53% out - | in 94% out - | in 0% out - | in 3% out - |
| Q6 | `src/util/StringUtils.ts` | in 9% out - | in 27% out - | in 0% out - | in 0% out - |
| Q7 | `src/util/StringUtils.ts` | in 100% out - | in 100% out - | in 0% out - | in 0% out - |
| Q9 | `src/common/ObjectLiteral.ts` | in 47% out - | in 100% out - | in 0% out - | in 0% out - |
| mean | | in 62% out 81% | in 89% out 100% | in 1% out 47% | in 3% out 68% |

Each map is asked with the question's target file as its focus (aider: in the chat, its file and name mentioned). Inbound: the files of the truth's callers, importers, implementers, dependents or type users; outbound: the files the target file imports.

Run on 2026-11-27 with this change (`sh bench/parity/run.sh`, ProofMesh at the branch of #33); the other tables above are from the earlier run. The 16,384-byte maps stop at 100 rows (`limits.max_rows`), 7 to 10 KB, and a cursor pages the rest.

### Cost (medians of 3 runs)

| | ProofMesh | Graphify | scip-typescript | Serena | aider |
|---|---|---|---|---|---|
| Full build | 31.8 s | 25.3 s | 26.4 s | live | 30.2 s |
| Peak memory (largest process) | 459 MB | 187 MB | 460 MB | 167 MB (server and language server, whole session) | 284 MB |
| Disk (own store) | 61 MB | 14 MB | 13 MB | 10 MB | 1 MB |
| No-change re-index | 8.6 s | 2.2 s | 22.1 s | live | 2.5 s |
| One edit (a statement in the constructor of src/error/TypeORMError.ts) | 13.3 s | 11.3 s | 28.1 s | live | 3.9 s |
| ms per question, Q1–Q9 | 9–172 | 824–1639 | n/a (decode 2.5 s once) | 389–7157 | 207–2769 |
| bytes per answer, Q1–Q9 | 384–24176 | 80–25364 | n/a (decode 2.5 s once) | 3449–191986 | 3450–5464 |
| `tools/list` bytes (MCP) | 18338 (13 tools) | CLI | index file | 25188 (21 tools) | Python API |

Fixture after the edit step: clean (tool caches graphify-out/, .serena/, .aider.tags.cache.v4/ are in .git/info/exclude).

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
