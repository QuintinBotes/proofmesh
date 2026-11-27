# Localisation benchmark: from a problem statement to the code

Each instance of a pinned sample of 50 SWE-bench Lite instances is indexed by ProofMesh at its base commit and asked
`search_concepts` with its problem statement as `text`. A BM25 baseline over files and one over functions rank the
same tree. No tool calls a model.

## Run it

From the root of this clone:

```sh
pnpm install --frozen-lockfile && pnpm build
node bench/localise/run.mjs            # then read bench/localise/out/results.md
```

- Needs Node 22.13+, git and python3. The first run needs the network: it downloads the dataset rows from the
  Hugging Face datasets server and fetches each base commit (depth 1). Both are cached under `$LOCALISE_CACHE`
  (default `~/.cache/proofmesh-localise`), with ProofMesh's data directory; later runs are offline.
- `--only <id,id>` runs some instances; `--baseline-only` skips ProofMesh. `$LOCALISE_OUT` moves `out/`.
- The command exits 1 when the bar of #27 is missed: file Acc@5 at least 60% and 10 points above BM25, function Acc@10
  10 points above BM25.
- On a heavily loaded machine an index of a large tree (sympy) can stop with `analyze timed out: no message from the
  adapter for 60000 ms`; it then scores a miss and the results name it. Run again, which reuses every snapshot already
  built, or with fewer `--jobs`. With `--jobs 3` at a load average of 40 to 60, three to five sympy trees stopped so.
- Python is indexed without Pyright (`PROOFMESH_PYRIGHT=off`, so no call is resolved), which keeps indexing time bounded:
  with Pyright one Django tree took over 20 minutes for 600 of its 2,546 files here, without it about two minutes. The
  ranking must not rely on call resolution. Set `PROOFMESH_PYRIGHT=on` to measure with it.

| File | What it does |
|---|---|
| `instances.json` | The 50 instance ids, drawn once with seed 27 by `sample()` in `run.mjs`, and each base commit. The dataset is never committed. |
| `run.mjs` | Fetches and caches, computes the truth and the baselines, indexes and asks ProofMesh, and writes `out/results.md` and `out/results.json` |
| `functions.py` | Every function of a tree with its qualified name and lines, by Python's own `ast` |

## How it is scored

- **Truth.** Gold files are the files the instance's gold patch changes. Gold functions are the innermost functions
  (by `functions.py`) holding a line the patch removes or changes, or an inserted block that is not itself a new
  definition. Function Acc counts only the instances whose patch has a gold function.
- **Acc@k.** An instance counts when a gold file is among the top k files (a gold function among the top k functions).
- **BM25.** Okapi BM25 (k1 1.2, b 0.75) over lower-cased `\w+` tokens, the whole problem statement as the query; over
  every `.py` file of the tree, and over every function's source lines.
- **ProofMesh.** `search_concepts` with the problem statement, 50 rows, tests ranked below production code (its
  default). A symbol row is matched to a gold function by path and qualified name.

## Latest results

Run on 2026-11-27 (`node bench/localise/run.mjs --jobs 2`, Python indexed with `PROOFMESH_PYRIGHT=off`), on an Apple
M5 Max (18 cores, 64 GB), macOS, Node 26.13.1, while other jobs shared the machine. A query took 231 ms at the median
(589 ms at most); 45 of the 46 problem statements asked had more than 32 indexed terms and were cut to their 32 heaviest.

| | file Acc@1 | @3 | @5 | @10 | function Acc@5 | @10 |
|---|---|---|---|---|---|---|
| BM25 | 26 | 44 | 56 | 60 | 18.2 | 25 |
| ProofMesh `search_concepts` | 54 | 70 | **70** | 78 | 34.1 | **52.3** |

The bar of #27, file Acc@5 at least 66 (60, and BM25 + 10) and function Acc@10 at least 35 (BM25 + 10), is met.
Function Acc counts the 44 instances whose gold patch changes a line inside a function.

Four instances score a miss because ProofMesh cannot index their tree: one source file that is not UTF-8 fails the
whole index (#139). They are `pylint-dev__pylint-7114` and `pylint-dev__pylint-7228`
(`tests/functional/i/implicit/implicit_str_concat_latin1.py`), and `sphinx-doc__sphinx-10451` and
`sphinx-doc__sphinx-8627` (`tests/roots/test-pycode/cp_1251_coded.py`).
