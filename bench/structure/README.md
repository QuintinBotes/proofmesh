# Structural search against ast-grep

`search_structure` (#37) matches ast-grep's pattern syntax. This benchmark checks that claim against the ast-grep CLI itself, pattern by pattern, on the same files.

## Run it

From the root of this clone:

```sh
pnpm install --frozen-lockfile && pnpm build
sh bench/parity/install.sh                # once: the pinned comparators, ast-grep 0.51.1 among them (network)
sh bench/parity/run.sh --fixture-only     # once: the parity fixture, TypeORM src/ at a pinned commit (network)
node bench/structure/run.mjs              # then read bench/structure/out/structure.md
```

- `patterns.json` is the suite: 29 patterns over TypeScript, Python and Go, each with its language, and the graph-scoped scenario. Each pattern runs on the parity fixture (`$TMPDIR/parity-typeorm`; `PARITY_FIXTURE` moves it) and on the files of that language in `fixtures/`. Both are indexed into throwaway data directories.
- ProofMesh is asked over MCP (`proofmesh mcp --tools core,extra`), in the compact envelope, paging with the cursor until the answer is whole. ast-grep runs as `ast-grep run -p <pattern> -l <language> --json=stream <files>` on the files the repository tracks with that language's extensions.
- SC-001: for every pattern, the sets of matched `path:start-end` line ranges must be equal.
- SC-002: `$D.escape($A)` scoped by `reachable_from: DataSource.initialize` must return exactly those of its unscoped matches whose enclosing symbol `trace_paths` reaches from `DataSource.initialize`.
- SC-003, as FR1880 restates it: the p95 time per TypeScript pattern on the parity fixture, over `STRUCTURE_RUNS` runs (3), must be at most `p95_budget_ms` in `patterns.json` (1,500 ms). ProofMesh's time includes the MCP round trip. ast-grep's p95 is printed beside each pattern for comparison and is no longer the bar: each search is one Node process that parses with the WebAssembly grammars on one thread, where ast-grep is native and multi-threaded. The header records the machine's load; time it on an otherwise idle machine.
- The script exits 1 when any of the three fails, and 2 when ast-grep or the fixture is missing.
- `--record` rewrites `fixtures-answers.json`, ast-grep's answers on `fixtures/`. `packages/proofmesh/test/search-structure.test.ts` replays them against the matcher, so parity on `fixtures/` is checked without the CLI.

ast-grep (MIT) is a benchmark-only tool: no package of this repository depends on it, and `install.sh` puts it in user space under `$PARITY_TOOLS/npm`. `search_structure` reimplements its pattern syntax and matching. It uses none of its code.
