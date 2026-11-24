# Changelog

All notable changes are listed here. The format follows Keep a Changelog; versions follow semantic versioning.

## Unreleased

From the Graphify replacement roadmap (#39):

- TypeScript `implements` and `inherits` from heritage clauses, cited at the clause; `references` for every use of a repository class, interface, enum or type alias other than imports and exports; interface members are `method` symbols, so a call through an interface resolves to its member (FR083 to FR088). A concrete member `implements` or `overrides` the members above it, so a caller query on it lists the calls that reach it by dispatch, marked `via`, and `analyze_impact` and `trace_paths` follow them; abstract and static members are not dispatch targets. Enums are symbols, an overloaded member is one symbol (static and instance members apart), and every TypeScript file reports references as partial.

File questions by path (#40):

- `get_relationships`, `analyze_impact`, `trace_paths`, `get_symbol`, `get_memory` and `find_tests` take a file by its repository-relative path; a path the snapshot does not index is `INVALID_ARGUMENT` naming its disposition. A file's module symbol answers its imports and dependents as the file does.
- `analyze_impact` with `imports` walks file to file and reports each file once with the import that reached it.
- TypeScript imports carry a kind (`static`, `re_export`, `type_only`, `dynamic`); `import()` is recorded, a computed specifier is unresolved with `dynamic_specifier`, Node.js built-ins resolve to `node:<name>`, and an import of a repository file that is not indexed is unresolved, with `not_indexed` where the adapter can see the file (a JSON data file); a path that is not indexed (excluded, unsupported, failed or absent) is refused by every tool.

From the Graphify replacement roadmap (#41):

- Lean answers (FR095 to FR100): `find_symbols`, `get_symbol`, `get_relationships`, `trace_paths`, `analyze_impact` and `find_tests` take `envelope: "lean"`, plain text with a header naming the snapshot as current or stale, one `<name> <path>:<line>` row per result (the call, import or reference site; the declaration for a symbol) with tags, then `# ` lines for the answer's limitations and `# more: cursor <c>`. It is their default over MCP, with no `structuredContent`; `compact` and `full` are asked for by name. `trace_paths` rows name every hop, so a path needs no `get_symbol` per node. Every symbol id parameter also takes `{ name, path }`; `find_symbols` adds `id=` to lean rows with `include_ids: true`.
- `bench/graph-bench/run.mjs` asks ProofMesh in its default envelope and reports, per question, the answering calls' bytes, the symbol lookup apart, and bytes per correct row beside Graphify's.

From the Graphify replacement roadmap (#42):

- `find_tests` says how it knows each test reaches the subject (`call`, `transitive_call`, `dispatch` with `via`, `reference`, `import_only`) and gives the shortest chain as `name file:line` hops. Only calls, renders and hook uses carry execution; heritage and injection edges do not, and a reference ends its chain. Rows come strongest evidence first, a test once; totals split `executing` from `not_executing`; the rows page by cursor. Where the snapshot records no `implements` or `overrides` for the subject's language, the answer says calls through interfaces and base classes are not followed. A lean row is the test at its first call toward the subject, tagged `dispatch`, `reference` or `import_only` (FR101, FR103 to FR105, FR107).
- `proofmesh tests <repository> <path | path#name> [--json]` prints those rows and exits 0 when a test executes the subject, 1 when none does, 2 on a usage error or an unknown subject (FR106).
- TypeScript `references` for each use of a repository variable (read or assigned) and each function or method used as a value without being called, with use `value`, cited at the first use per user (FR102).

FR093 amended (owner's decision on #45):

- An explicit tsconfig `paths` entry that maps a Node.js built-in's name to a repository file wins, as tsc and editors resolve it: `events` mapped to `src/events.ts` records that file. Without such an entry the built-in still wins, even over a repository file of the same name.

From the Graphify replacement roadmap (#43):

- `impact_completeness` and `proofmesh completeness <repository> <base>[..<head>] [--depth N] [--json]`: every symbol the diff from base to head (or the working tree) changed, each with its callers (dispatch included), implementers, overriders, subclasses, references and importers, each marked `changed`, `tested` (a test executes it, by `find_tests`' evidence, naming the nearest test) or `neither`, with totals and a `# summary:` line. A side with no snapshot is indexed: over MCP the answer is `pending` with the job id, and a commit indexed so (`index --rev --keep-current`) leaves the current snapshot as it was; the CLI waits, and exits 1 while any dependent is `neither` (FR108 to FR114). An index job's result now names its commit.

From the traceability audit:

- `pnpm check:traceability` requires every MUST requirement, amendments A1 to A13 and every success criterion to map to a test or a manual check; `pnpm check:fixtures` (in `pnpm verify`) requires every fixture and eval sample to state its origin and Apache-2.0 and passes the leak scan.
- Tools are classed read, management or execution; every answer is validated against its envelope and data schema before it is returned (an answer that breaks its schema is an INTERNAL_ERROR); `list_queries` publishes a versioned contract manifest; `COMPATIBILITY.md` is current and a test ties it to the code.
- An MCP call cancelled before it runs is not run. `verify_claim` has a scope layer: an external symbol or a symbol of another snapshot is not supported.
- `list_snapshots` and `list_workspaces`; the Observatory's snapshot and workspace routes are those tools. `workspace_status` reports the analysis configuration, the generated-source policy and each adapter's external inputs.
- Every file row reports all seven capabilities; snapshots record their analysis configuration; `proofmesh status` prints it.
- Observatory: every bidirectional and invisible character is shown as a token, also on graph labels; lines carry words for origin and resolution; candidate and ambiguous callers draw thin; every graph view says position carries no meaning; Galaxy point lookups name the repository.
- Refusals name the repository that owns a snapshot, and a path prefix that names no indexed file says so.

From the trial's third round (A34):

- `list_repositories` needs no repository; with several registered, a refusal lists every id, name and root, and `list_queries` answers across repositories. `get_job` answers from the catalog, so a first index can be followed.
- `workspace_status` gives `file_summary`, files grouped by disposition, reason and extension, and lists file rows only when asked with `files` (by disposition and path prefix), paged by cursor.
- Compact envelopes (`envelope: "compact"`): coverage, unresolved reasons, standing limitations and requested limits are left out; the MCP server sends them once per snapshot per connection; an envelope that alone overflows `max_bytes` is compacted. The standing references limitation follows the snapshot's capability.
- Outbound `get_relationships` lists code in the repository by default; `include_external: true` adds framework and library calls, and `totals.out_external` counts them.
- `behind_remote` names the branch it counts against (`behind_ref`, falling back to `origin/main` or `origin/master`) and when it was last fetched (`fetched_at`); a detached head or a fetch older than a day says so.
- Index jobs record `progress_at`, `phase_started_at`, `elapsed_ms` and a `plan` per adapter (incremental or full, files to analyse and to reuse); a finished job keeps its counts (catalog migration 0017).
- `proofmesh --version`, `-v`; `repo add` and `repo list` warn about temporary or missing roots and names that differ from the directory; `dependency_missing_by_package` counts per package.

Changes from the second round of a private trial (A31 to A33):

- C# `references`: uses of repository declarations other than calls (types, property and field reads and writes, constants, enum members, object creation, attributes, method groups, `nameof`), one per user and target with its uses. Enum members are `field` symbols. `nameof` is no longer a call.
- A call that does not bind records its callee name and argument count in all adapters, and in C# the compiler's first error; a call that fails only because a name does not bind is blamed on that name. Candidate and ambiguous C# calls say why they did not bind.
- Inbound `get_relationships` on an implementation includes calls and references to the members it implements or overrides, each marked `via`. Its boundaries list unresolved sites that call the subject's name first, its parameter count first, and `totals.boundaries_calling_name` counts them; a site inside the subject is listed only when it calls the subject's name.
- Snapshot format 0.6 indexes symbols by file, so `search_sources` maps a hit file's lines to symbols without reading every symbol; a scan stopped by the time limit says how many more calls the rest would take.
- EF6 lightweight conventions (`Types().Configure(c => c.ToTable(...))`) are evaluated when the name is constants around `c.ClrType.Name`, and marked inferred through a helper. `get_table_reach` reaches a table through code reading its entity's DbSet property and lists those `accessors`.
- `proofmesh repo conventions` registers a conventions file (`schemas/conventions/0.1.schema.json`): job base classes, feature flag keys and team enums, for `job`, `feature_flag` and code-declared `team` symbols with `runs`, `evaluates_flag` and `owned_by`.
- `get_property_reads` with an endpoint adds `static_reads`, `static_bound` and a `comparison` with imported application reads.
- `get_external_usage` counts call sites into external code per module, type or member, with files, projects and samples, folding closed generics; `analyze_impact` accepts an external symbol.
- Notes may list `patterns` (catalog migration 0016); `search_sources` names the accepted notes a text matches. `find_query_source` ranks the endpoints and jobs behind a SQL statement by tables, owner, compared columns and helpers.

Changes from a maintainer's session over a large private repository:

- Paths follow `implements` and `overrides` in both directions, so a call to an interface or virtual member reaches its implementations; `trace_paths` follows calls, implements and overrides by default, and `verify_claim` says when a path claim was checked along calls only.
- Every envelope names the snapshot's `commit`, `ref` and `behind_remote` (local refs only, never a fetch).
- A rejected input names the properties the tool accepts.
- `get_relationships` accepts an external symbol as subject and lists the calls into it.
- `dependency_missing` sites name the packages their project lacks; `workspace_status` groups them by package, and the missing-input limitation says how many sites are blamed on them.
- Observations 0.3: `read_kind` (orm or application), `declaring_type`, `calls` and `callers` per property read; catalog migration 0015. `get_property_reads` answers by endpoint or entity, with `loaded_not_used` and `unread_mapped_properties`. `proofmesh observe validate` checks a file; `observe import` accepts a repository name; `docs/proofmesh/observations.md` holds the format and a .NET recording recipe.
- `node dist/cli.mjs` runs the CLI directly.
- `find_symbols` and `get_relationships` take `include_tests: false` to leave out test code; `find_symbols` takes `path_prefix`.
- C# signatures are written as the source writes them, so an alias stays an alias; parameter defaults and attributes are dropped.
- A member a known receiver type does not have (an extension method from a package that is not in the cache) is `unknown_name` or `dependency_missing`, not `outside_capability`; a member that exists but does not bind says why in its detail.
- EF6 entities without an explicit mapping get their pluralised table, marked inferred, unless the context removes the pluralizing convention; a bare `builder.Entity<T>()` registers an EF Core entity; `get_table_reach` lists table-per-hierarchy subtypes through `inherits` with `via`.

- `trace_paths` cuts the explored edges, then the boundaries, then paths beyond the first under the byte budget, and prunes `nodes` and `relationships` to what remains. It no longer reports `path_found` with an empty `paths` list.
- `search_sources` pages: a page is whole files within the row and byte limits, and `completion.next_cursor` continues at the next file, also after a timeout. A file that alone overflows a page is named in the limitations.
- `get_relationships` with `owned_by` on any symbol returns the owners recorded on its file module. Inbound boundaries list at most ten unresolved call sites, the nearest by path; the count and the reasons still cover the whole snapshot.
- Snapshot-scope `unresolved` carries the count and the reasons, not a sample of sites from files the query never touched.
- `proofmesh repo list` prints every registered repository with its id, root and trust.
- The byte budget now covers the whole envelope, and `trace_paths` also cuts its horizon before any path, so a reply stays within `max_bytes`.
- `get_relationships` no longer reports `max_rows` for the boundary count, which is a sample by design; truncation means the relationship list itself overflowed, and then a cursor follows.
- An adapter crash names its cause: the exit error carries the adapter's last stderr lines, and a launcher that cannot start says which command failed.
- A C# package reference written with an MSBuild property (`$(Name).Core`) is recorded as an unevaluated input rather than a missing one, so it no longer marks every unbound symbol in its project `dependency_missing`.
- `get_table_reach` on an unknown table says how many tables the snapshot has and where tables come from, including installed extensions.
- Observations schema 0.2 adds `property_reads`: entity properties observed read per endpoint in an instrumented run. `get_table_reach` reports them per table beside the static reach, with the property symbol when the snapshot has one, as the input for moving a full entity fetch to a projection. A property absent from them was not seen read, which the limitation says is not evidence that nothing reads it.
- `node scripts/update.mjs` (or `pnpm update:all`) installs, builds and builds the C# adapter, stopping at the first failure; without pnpm or Corepack it runs nothing and prints the `npx --yes pnpm@10.14.0` commands to run instead. The README has an Updating section.
- `proofmesh index <repository> --rev <commit-ish>` indexes a commit from git objects in a private temporary tree, leaving the working tree, HEAD and index untouched; the snapshot records the resolved commit and its own `behind_remote`, and becomes current. `proofmesh repo move <repository> <new-path>` re-roots a registration at another working tree of the same git repository, keeping its id and everything recorded under it.
- Every `proofmesh index` is an index job: `proofmesh status`, `workspace_status` (`data.jobs`) and `get_job` show it while it runs, with its phase, and a killed run reads `interrupted`. The CLI writes a progress line to stderr per phase (per adapter for `initialize` and `analyze`) and repeats it every minute; the summary adds phase durations and each adapter's peak resident memory.

First public release candidate. See ROADMAP.md for what is implemented and what is experimental, and `docs/proofmesh/milestones/` for the evidence behind each milestone.
