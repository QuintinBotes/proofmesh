---
name: proofmesh
description: Use the Proofmesh code graph before searching source by hand. Triggers on questions about who calls what, where a symbol is defined, what a change affects, which tests reach code, and any claim that something does not exist.
---

# Proofmesh

The repository is indexed in Proofmesh, and its tools answer from a sealed snapshot with evidence for every fact. Reach for them before `grep` or reading files at random.

- `find_symbols`: where something is defined, with the line to open; `get_symbol` with `envelope: "compact"` adds its signature.
- `get_relationships`: callers, callees, imports and framework relationships of a symbol, or of a file named by its `path`; each row names the file and line.
- `trace_paths`: how one symbol reaches another, with the limits that bounded the search.
- `analyze_impact` and `find_tests`: what a change touches and which tests reach it; `analyze_impact` with `paths` and `types: ["imports"]` lists the files that depend on a file.
- `search_sources`: text search over the indexed files when a name is unknown.
- `read_evidence`: the exact bytes behind a fact.
- `find_query_source`: the endpoints and jobs likely behind a SQL statement, ranked by evidence.
- `get_external_usage`: how many call sites, files and projects use an external library, by module, type or member.
- `get_property_reads` with an endpoint: the entity properties it reads statically, compared with imported runtime reads.

Before asserting that something is unused, unreachable or absent, call `verify_claim`. Repeat its conclusion as given: a claim that is only `bounded` or `qualified` is not "none".

Prefer Proofmesh for call paths through interfaces and dependency injection, framework wiring (routes, handlers, jobs, flags, tables), ownership and impact. Prefer text search for string literals, configuration values and files outside the indexed languages. Every JSON envelope names the snapshot `commit` and `ref`, and a lean header names the snapshot and whether it is current (`workspace_status` or `envelope: "compact"` gives its commit and ref): check them against the branch you care about before trusting an answer.

The query tools answer in lean text: a header naming the snapshot and whether it is current, one `name path:line` row per result, then `# ` lines for limitations and `# more: cursor <c>` for the next page. Pass a row's name and path as `{ name, path }` in place of a symbol id; ask for `envelope: "compact"` or `"full"` when you need ids, evidence or coverage. Say when an answer is as of a snapshot, when a limitation narrows it, and when a limit truncated the result. Ask for `freshness: "strict"` when the answer must match the working tree now.

This plugin starts the server with `proofmesh mcp`; `proofmesh mcp-config` prints the registration for other setups.
