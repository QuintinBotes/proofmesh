# The MCP service

Proofmesh serves its tools over MCP on stdio (`proofmesh mcp`) and over Streamable HTTP on loopback (`proofmesh mcp --http`). Both transports build the same server around the same query service, so a client sees the same tools, schemas and answers on either (FR034).

## Tool profiles (FR420 to FR423)

A client that does not defer tool loading puts every listed tool's name, description and input schema into the model's context before the first question. So `proofmesh mcp` lists only the `core` profile, whose `tools/list` stays under 20,000 bytes (a test asserts it; 18,338 bytes for 13 tools at this change, against 86,473 for all 30):

| Profile | Tools |
|---|---|
| `core` (default) | `find_symbols`, `get_symbol`, `get_symbols_at`, `get_relationships`, `trace_paths`, `analyze_impact`, `find_tests`, `search_sources`, `read_evidence`, `workspace_status`, `list_repositories`, `get_overview`, `list_queries` |
| `data` | `get_table_reach`, `get_property_reads`, `find_query_source`, `get_external_usage` |
| `claims` | `verify_claim`, `get_claims`, `prepare_verification`, `get_verification` |
| `extra` | `list_snapshots`, `list_workspaces`, `get_ecosystem`, `compare_snapshots`, `impact_completeness`, `request_index`, `get_job`, `get_memory`, `save_memory` |

- `proofmesh mcp --tools core,data` (or any comma-separated list) lists those profiles; `--tools all` lists every tool exactly as its schema file declares it. Both transports take it. In a client configuration, put the option after `mcp` in the arguments, for example `"args": ["mcp", "--tools", "all"]` in `.mcp.json`. A client restarts the server to change profile.
- Outside `all`, a listed tool keeps its description and every field of its input schema, with types, enums, patterns, defaults and required fields, but not the per-field descriptions; `envelope` keeps its first sentence. The full schemas are `schemas/tools/<tool>.input.schema.json`, and the server validates every call against them whatever the profile.
- `list_queries` lists every tool with its `profile`, loaded or not, and says how to load the others.
- A call to a tool of a profile the server was not started with is `INVALID_ARGUMENT` with `details.profile` naming the profile, and the message says which `--tools` option loads it.

## Read, management and execution (FR036)

`list_queries` gives every tool a `capability`:

- `read` tools answer from snapshots and the catalog. They record that they answered, as a query record or a claim's verification run, and start nothing.
- `management` tools ask the workspace to start or keep something: `request_index` starts an index job (as `impact_completeness` does for a side with no snapshot yet), `save_memory` saves a note proposal that a person accepts later, and `prepare_verification` prepares a plan that a person approves.
- `execution` runs repository code. No tool has it. A person approves and runs a verification with `proofmesh verification approve` and `proofmesh verification run`, and only the CLI loads the launcher.

## Schemas and the contract manifest (FR037)

Every input is validated against `schemas/tools/<tool>.input.schema.json` before the tool runs. Every answer is validated against `schemas/envelope.schema.json` and `schemas/tools/<tool>.data.schema.json` before it is sent. An answer that fails is a defect, so the client receives `INTERNAL_ERROR` naming the first mismatch instead of the answer.

`list_queries` returns `contract`, the version of each public contract: the envelope, the snapshot format, the link format, the adapter protocol, the bundle format and the newest catalog migration. [COMPATIBILITY.md](../../COMPATIBILITY.md) states the policy for each.

## Deadlines, bounds, errors and cancellation (FR038)

Each call takes `limits` for time, rows, bytes and depth, clamped to the server maximum, and an answer cut short by one says so in `completion`. Errors are tool results with `isError` and a body that matches `schemas/error.schema.json`.

Cancellation has a limit. Queries run synchronously against SQLite, so the server reads a cancellation only between calls:

- A call cancelled before its handler starts is not run. As MCP requires, it gets no reply. In process, the query service refuses such a call with `CANCELLED`.
- A call that is already running finishes, or stops at its deadline (`timeout_ms`, at most 30 s), and its answer is sent. The cancellation arrives too late to stop it.
- Over Streamable HTTP the server is stateless: each POST gets a fresh server, so a cancellation, which arrives in a POST of its own, cannot reach a call in flight. The call runs to its answer or its deadline.

## Relationship basis (FR181 to FR190)

Every relationship row `get_relationships` answers, and every dependent, test and path hop reached through relationships, carries `basis`: `observed` when a compiler, an index or a declared configuration proves the relationship, `inferred` when a convention, a name match or a contract match suggests it. It is derived when the answer is built, not stored: a row is `inferred` when its resolution is `candidate` or `ambiguous`, its origin is `contract_match`, `documentation` or `model_hypothesis`, or its `detail.inferred` is set. `resolved_external` rows are observed. An unresolved boundary is no relationship and has no `basis`.

A row reached through a chain is `inferred` when any hop of its strongest chain is. The strongest chain is the shortest all-observed chain where one exists: a dependent that an observed and an inferred chain both reach is `observed`, and `analyze_impact` gives the depth of that observed chain. A `trace_paths` path is `inferred` when any hop is, and each hop says its own `basis` in `relationships`. `get_relationships`, `analyze_impact`, `find_tests` and `impact_completeness` give `totals.by_basis` (`observed` and `inferred`). Check inferred rows before acting on them. `by_basis` counts rows that have a basis, so an unresolved boundary, which has none, is left out and the two counts can sum to less than the number of rows (`totals.in` and `totals.out` in `get_relationships` count every row). A `get_table_reach` reach row carries `basis` too: `inferred` when a hop of the chain from the endpoint or job to the table is.

## Reach through candidate edges (FR201 to FR210)

Where no compiler or index analysed a subject (Go and Java without a SCIP index), its calls are `candidate` or `ambiguous` rows, which are not edges. `analyze_impact`, `find_tests`, `trace_paths` and `impact_completeness` take `include_inferred`: `true` follows them, `false` never does, and `auto`, the default, follows them when every subject's file was analysed by the syntax tier alone (for `impact_completeness`, per changed symbol). Following walks a `candidate` site and an `ambiguous` site of at most five candidates, never one whose candidates were capped, and labels every row reached through one `inferred`; a row an observed chain also reaches stays `observed` (FR184). Auto is decided once, from the subjects: once on, the walk follows candidate sites in every file it reaches, a precise-tier file included, and the answer says so; a precise-tier subject follows none even where its walk meets a syntax-tier file. Answers for TypeScript, Python, C# and any SCIP-covered file, or a file that records no tier, are byte-identical with the default input, including where candidate sites exist. The answer says in `limitations` that candidate edges were followed and why, and how many ambiguous sites of more than five candidates it stopped at; it counts the candidate sites it did not follow only when `include_inferred` is `false`. The node budget is checked as each row is reached. Candidate imports are not followed.

## Envelopes: lean, compact and full (FR095 to FR100)

The query tools whose results are code locations (`find_symbols`, `get_symbol`, `get_relationships`, `trace_paths`, `analyze_impact` and `find_tests`) answer in the lean envelope by default over MCP. A lean answer is plain text, with no JSON and no `structuredContent`:

```
# get_relationships · 1 row · snap_4f0c2a9b1d3e5f7a current
service src/service.ts:4
```

- The header names the tool, the row count and the snapshot. It says `current` when the snapshot is the repository's current one, and `stale` when it is older (pinned by `snapshot_id` or a cursor); a stale answer is still given, with a limitation naming the current snapshot.
- Each row is `<name> <path>:<line>`, then tags: `in` or `out` when both directions are asked, `depth=<n>`, `dispatch`, `external`, `candidate`, `ambiguous`, `unresolved:<reason>`, and the relationship type when a query mixes types. A row whose relationship is inferred ends with the token `inferred` (FR186). The name is the qualified name without its module prefix (`BudgetLedger.consume`); a file or module row is `<path>:<line>` alone; a name or path with a space, a quote or `#` is quoted as JSON.
- The line is the call, import or reference site for relationship, impact and path rows (one row per site) and the declaration for symbol rows. A `trace_paths` answer lists the hops in order, each at its call to the next, then the target at its declaration.
- A `find_tests` row is the test at its first call toward the subject, with `depth=<n>` (1 for a direct call), tagged `dispatch` or `reference` when that is how it reaches the subject; a test file that only imports the subject is `<path>:<line> import_only`, at the import (FR101).
- Test code is recognised by file convention and by each symbol's roles (FR191 to FR194, see `languages.md`): `include_tests` false leaves out a symbol that is test code by either, and `find_tests` lists a test entry point where the language marks them, any symbol in test code where it does not. When the subject's language has no resolved calls it says so, and lists no test as executing it (FR199).
- `impact_completeness` answers in JSON by default and lean when asked; `proofmesh completeness` prints its lean text. A lean row is `changed <name> <path>:<line> <added|modified|deleted> <status>`, and each dependent below it `  <relation> <name> <path>:<line> <status>`, the line being the site; a status is `changed`, `neither` or `tested: <test> <path>:<line> <evidence> depth=<n>`. A `# summary:` line follows the rows. While a side has no snapshot the answer is `pending`, with no rows: call `get_job` with its job id, then ask again (FR108 to FR113).
- `get_symbol` answers `stable_key` and `body_hash` (a lean row ends `stable_key=<key> body_hash=<64 hex>`): the hash of the declaration text with line endings, common indentation, trailing whitespace and the symbol's own name normalised, so it survives a move and a rename and changes with an edit (FR130, FR131). A snapshot sealed before hashes existed answers null and says to index again (FR135). A symbol the SCIP importer declared also carries `detail.scip`, the index's own symbol (FR441).
- A symbol can be named by its `stable_key` in place of its id: `key` on `get_symbol`, `get_relationships`, `analyze_impact`, `find_tests` and `get_memory`, `source_key` and `target_key` on `trace_paths` (FR149). A key is unique in a snapshot and the same whichever tier analysed the file (FR146 to FR148); an unknown key is `NOT_FOUND` naming it. `get_memory` lists a note reference matching several symbols under `ambiguous_refs` and reports `tier_changed` when only a file's tier changed (FR150).
- Every structured row that names a symbol carries its `stable_key` as `key` (`from_key`, `symbol_key`, `source_key` and `target_key` where the row has its own `key` or names a second symbol), so it can be passed back as the subject of the next call: relationships, impact, tests and their chains, paths, symbol lists, hubs, table reach, property reads, query-source candidates, completeness and ecosystem samples. A row whose id is no symbol carries none (FR280 to FR289). `trace_paths` explored edges and `get_overview` links carry `from_key` and `to_key` for each end that is a symbol (FR440).
- `compare_snapshots` lists a removed and an added symbol of equal kind and hash as `paired` (`moved`, `renamed` or `moved_renamed`, each with both ids and keys), any other match as `ambiguous` with its candidates, never a body of fewer than 10 tokens (counted in `counts.too_small`, with a limitation), and never a symbol with no hash. A module is its file's text, so moving one function out of a file shows the old module as changed (its range) and the new file's module as added; a module pairs only when a whole file moves unchanged, and a changed symbol with `body` among `what` when its hash differs, with the ids of both sides (FR132 to FR134).
- `get_symbols_at` takes `locations`, 1 to 100 of `path:line` (a column is ignored), and answers one row per location, in order: `<location> <name> <path>:<line> <kind>` for the innermost symbol holding the line (the file's module when no inner symbol does), or `<location> - <reason>` with `not_indexed`, `no_symbol`, `not_found` or `line_out_of_range` (FR119, FR123). Envelope `full` adds each symbol's id, `stable_key` and `tier` (`precise`, `syntax` or `scip`) (FR120).
- After the rows come `# ` lines: the limitations of this answer, then `# more: cursor <c>` when there is a next page. Pass `<c>` as `cursor` to continue.
- Ids stay available: `find_symbols` with `include_ids: true` ends each row with `id=<symbol id>`, and every symbol id parameter also takes `{ "name": ..., "path": ... }`, the name as a row shows it (or the plain name), unique in the file that declares it. An outbound `get_relationships` row's path is its call site, not the callee's file. An ambiguous name is refused with `INVALID_ARGUMENT`, listing the candidates as rows with their ids.

`compact` and `full` stay selectable by name, and only they send `structuredContent`: `full` is the whole envelope, and `compact` leaves out what an earlier answer from the same snapshot gave (coverage, unresolved reasons, standing limitations, requested limits). The other tools answer in JSON as before: the first answer per snapshot on a connection is full and later ones are compact. In process and over the HTTP API, the default envelope stays `full`.
