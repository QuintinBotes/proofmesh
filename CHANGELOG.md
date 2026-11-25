# Changelog

All notable changes are listed here. The format follows Keep a Changelog; versions follow semantic versioning.

## Unreleased

Pinned SCIP indexers for a trusted repository (closes #23, option B; amends A24 as A38; FR224 to FR227):

- `proofmesh scip run <repository> [--language L]` refuses with `TRUST_REQUIRED` without a build-evaluation grant (printing the grant command and the indexer command to run by hand) and starts nothing. With the grant it runs scip-go, scip-java or rust-analyzer (build scripts and procedural macros off), whose executable must have the pinned digest, in a disposable copy of the current snapshot: no shell, an allowlisted environment, a private HOME, dependencies from a declared module cache only, SIGKILL on a time or memory limit, capped output, `--container` for `--network none`. Partial output is discarded, never named. No MCP or HTTP tool can start a run.
- The index records the indexer, version, digest and grant (catalog migration 0019); its facts carry `trusted_build` and its identity is part of snapshot identity. `proofmesh repo untrust` stops it being read: files return to their usual tier with unchanged keys and the census names `scip_revoked:<index>:<grant>`.
- Not done: the indexer table ships no sha256 for any platform, so a run needs the installed build pinned in `<data dir>/indexers.json` until a maintainer records the vendors' digests; the table's versions are to be confirmed. The container run is covered by its argv only (no Docker in the test), and the module cache is declared by offline settings per indexer, not enforced without `--container`.

Syntax-tier structure, Kotlin, Rust, PHP and Ruby (#59, part 1):

- The syntax tier records each Kotlin `import`, Rust `use` (a grouped one with `detail.names`, also inside a function body) and `mod x;`, PHP `use` clause and Ruby `require` or `require_relative` of a string as an unresolved `imports` row, and each Kotlin supertype, Rust `impl Trait for Type` and trait bound, PHP `extends` and `implements`, and Ruby superclass and `include` as an unresolved `inherits` or `implements` row from the declaring type (FR221 to FR223). The Rosetta gaps for these languages now state that the rows exist and have no target. Swift, Scala, C, C++ and Bash follow in part 2.

Rosetta suite (closes #20, SC-1 for the ten languages at the tiers they have; SC-2 is a rule for later slices):

- `fixtures/rosetta/` holds one small program in each of ten languages (TypeScript, Python, C#, Go, Java, Rust, PHP, Ruby, Kotlin, C++), a hand-written `expected.json` per language and tier, and a `contract.json` of the eight calls. `packages/proofmesh/test/rosetta.test.ts` asks every language the same calls and compares the lean rows with the tier that analysed it (FR211 to FR216, FR219).
- A row a tier cannot give is stated under `not_at_tier` with its reason, never skipped, and a stated gap that closes fails the test (FR215, FR217). `docs/proofmesh/languages.md` prints the per-language support table the files give.
- `pnpm check:languages` fails when a language is listed as supported for a tier without its section, when a section does not account for every row, or when the table differs from the files (FR218); `pnpm verify` runs it.
- Gaps the suite now states include: Python records no dispatch rows (known defect: issue 20 scenario 2 is not met for Python); C# records no imports; Go, Rust and C++ have no symbol for an interface, trait or abstract method; Rust, PHP, Ruby, Kotlin and C++ bind no calls; known defects the suite records as `known_defect` rows, not support: `include_tests` false does not leave out a test file that imports the subject, and `analyze_impact` lists a sibling implementation as a dependent.

Reach through inferred edges (part of #21; SC-2, the per-language benchmark, and SC-3, the graph-bench run, are not run; candidate imports are not followed):

- `analyze_impact`, `find_tests`, `trace_paths` and `impact_completeness` take `include_inferred` (`true`, `false` or `auto`, the default). Auto follows candidate edges where every subject's file was analysed by the syntax tier alone, so Go and Java without an index now answer impact, test reach and paths; every row reached through one is `inferred` (FR201, FR202).
- A `candidate` site and an `ambiguous` site of at most five candidates are walked; a site with more is never followed, and the answer says how many it stopped at. The answer also says that candidate edges were followed and why, or how many candidate sites it did not follow (FR208, FR209).
- Answers for a subject a precise adapter or a SCIP index analysed, or whose file records no tier, are byte-identical with the default input, including where candidate sites exist: the count of candidate sites not followed is given only with `include_inferred` false. Auto is decided from the subjects; once on, the walk follows candidate sites in every file it reaches, and says so. A row an observed chain also reaches stays `observed` (FR201, FR204, FR210).
- The node budget is checked as each row is reached, so a hub with more callers than the budget stops at it and says so (FR210).
- `trace_paths` lists a candidate site as a boundary only when it did not follow it; the lean `impact_completeness` summary ends with `; <n> inferred` when a dependent is inferred (FR206, FR207).
- Existing expectations that change: `find_tests` on Go `Add` in `fixtures/tests-polyglot` now lists its three Go tests (`TestAdd` among them) as inferred calls and no longer says `Calls in Go are not resolved yet`; the note goes only for a subject with candidate call sites of its own (FR199 holds with `include_inferred` false, and for a subject with none); the Go and Java syntax-tier answers of the four tools that were empty are no longer empty.

Relationship basis (part of #10; the graph-bench scenario SC-2 is not run):

- Every relationship row of `get_relationships`, every dependent of `analyze_impact` and `impact_completeness`, every test of `find_tests` and every hop of `trace_paths` carries `basis`, `observed` or `inferred`, derived when the answer is built from the resolution, the origin and `detail.inferred`. An unresolved boundary has none (FR181 to FR183, FR189).
- A row reached through a chain is `inferred` when any hop of its strongest chain is; the strongest chain is the shortest all-observed one where one exists, so a dependent that an observed and an inferred chain both reach is `observed`, at the depth of that chain. A path is `inferred` when any hop is (FR184).
- The answers' totals give `by_basis`, and an inferred lean row ends with the token `inferred` (FR185, FR186). The snapshot format and the adapter protocol are unchanged (FR190).
- The constrained name matching of #16 no longer writes `detail.inferred` `name_match` or `package_directory` on the rows it binds: that was a stand-in for this label, and a `candidate` or `ambiguous` row reads as inferred through its resolution (FR188). `RESOLUTION_VERSION` is 3, so earlier snapshots are not reused.
- Existing expectations that change: the `constrained` fixture's five Go import rows and the `syntax-structure` fixture's Go embedding row lose `detail.inferred`, and the two #16 tests that named it now read `basis`; in `analyze_impact` a dependent that an observed chain reaches deeper than an inferred one is reported at the observed chain's depth (this arises only where an inferred relationship is resolved, such as an ORM convention table or an adapter's guessed call); a lean candidate or ambiguous row of `get_relationships` now ends with `inferred`.

Test recognition in every language (closes #11 apart from SC-2, which needs the pinned public samples; a JavaScript `test('name', fn)` callback is still not a symbol):

- Test files are recognised by each language's convention: Go `_test.go` (and only that, so a Go directory named `test` that holds production code is not test code), Python `test_*.py`, `*_test.py` and `conftest.py`, PHP `*Test.php`, Ruby `_spec.rb` and `_test.rb`, C and C++ `*_test.*` and `*_unittest.*`, with the existing TypeScript, C#, Java, Kotlin and Swift patterns (FR191).
- Test entry points are recognised by their markers, from syntax alone: Go `Test`, `Benchmark`, `Fuzz` and `Example` functions, Rust `#[test]` and `#[tokio::test]`, JUnit and Kotlin `@Test` (also under another import name), pytest and `unittest.TestCase`, PHPUnit, RSpec `it` blocks and Minitest methods, googletest `TEST`, `TEST_F` and `TEST_P`, XCTest, and xUnit, NUnit and MSTest attributes in C# (FR192, FR197, FR198).
- A symbol carries optional `roles`: `test` for an entry point and `test_support` for test code that is none (a `#[cfg(test)]` module's members, the helpers of a test class). Adapter protocol 1.1 and snapshot format 0.9; an adapter that sends none is as valid as before, and an older snapshot is decided by its paths (FR193, FR196).
- `include_tests`, `find_tests`, test reach and `impact_completeness` decide per symbol, so a Rust source file with a `#[cfg(test)]` module keeps its production symbols when tests are left out (FR194). Where the adapter marks entry points, `find_tests` lists only those: a helper in a test file is no longer a test, but a test that calls it reaches the subject through it (FR195).
- `find_tests` says, as a limitation, when the subject's language has no resolved calls yet (Go and Java without an index): `Calls in Go are not resolved yet`, and no test is listed as executing it (FR199).
- A test class may reach its test-case base through the repository (up to two bases), or be one by convention when the base is outside it and the class is named `*Test`, `*Tests` or `Test*` in a test file: PHP, Python, Java, Kotlin and Ruby (Ruby also takes `ActionDispatch::IntegrationTest`, `ApplicationSystemTestCase`, `ActiveSupport::TestCase` and any base ending in `Test` or `TestCase`). pytest functions match the prefix `test`, so `testAdd` is a test. An RSpec `it` or `describe` block is a test or a group only in a spec file. A Rust module a parent declares as `#[cfg(test)] mod tests;` is test support. `find_tests` takes the entry-point rule per file, where the adapter sent roles, not per language (FR192, FR194, FR195).
- Existing expectations that change: the limitation `Test code is recognised by path and project naming, not by test framework attributes.` of `find_tests` now says `by file convention and project naming, and by the roles an adapter gave each symbol (a test entry point, or code in a test-only scope)`, and its second note (every symbol in test code is a test) now applies only where the language has no markers; the Go test-file rule no longer counts a `test/` or `tests/` directory; FR107 says roles too; the protocol and format versions in `COMPATIBILITY.md` are 1.1 and 0.9. A Ruby `def` inside a `describe` block is now qualified by the group (`spec/a_spec:Calc.make`). For C#, a type with a test attribute is now test code wherever it sits, and in a C# file that has one `find_tests` lists only the attributed methods; both were decided by path and project before (see COMPATIBILITY.md).

Constrained name matching in Go and Java (part of #16; Rust, PHP, Ruby, Kotlin, C and C++ stay open):

- The syntax tier binds a call, a supertype name and an import where the language's rules allow it: the file's package and imports, the modules the build graph says the source depends on, and visibility. One reachable target is a `candidate`, several are `ambiguous` (five listed, the rest in `detail.more`), each with `detail.rule` and `detail.inferred` `name_match`; none is `resolved`, so no edge is made of a name match (FR171, FR173 to FR176).
- A name only a module the source does not directly depend on (in the scope of its own sources) holds is `unresolved` with `dependency_missing` and `detail.undeclared`, never a candidate (FR172). A Go import of a package of a module the importer depends on is a `candidate` listing the package's files, because an import links files and a package is a directory; a Java import is a `candidate` (FR177). An `internal` package outside its parent, and `vendor` and `testdata` packages, are not matched (FR173).
- A call on a receiver whose type the tier cannot know binds to nothing (`buf.Write()`, `err.Error()`); an inherited method counts among the overloads, and a supertype outside the repository makes a bare call ambiguous and never reaches a static import (FR174). The build adapter records `detail.scope` on a test or runtime `depends_on` (FR172).
- Java `new T()` is now a call row, and Go and Java calls carry `qualifier`, `receiver`, `shadowed` and `form` details; a Java static import carries `static`.
- `workspace_status` gives `module_cycles`, and a warning, for a cycle among build modules that these rows form where the build forbids one (FR178).
- Existing expectations that change: a same-package or same-class call in a repository with no build manifest is now a candidate (the `syntax-tier` fixture's Go and Java `helper()` calls), a Go struct embedding a type of its own package is a candidate (the `syntax-structure` fixture's `Shape`), and the snapshot identity gains the version of the rules.

SCIP calls, inheritance and imports (#19):

- The SCIP importer records `calls` by joining the syntax tier's call sites with the index's occurrences at each callee name (`resolved`, or `resolved_external` with the package from the symbol), where it recorded only `references`. A call is no longer also a `references` row; a function passed as a value, and a field or variable that holds one, stay references (FR161, FR167, FR168).
- It reads the index's `is_implementation` relationships into `implements`, `inherits` and `overrides` (FR162), and records each import statement, resolved to the package's file or to `<ecosystem>:<package>` (`go:std` for Go's standard library) (FR163). `analyze_impact` and `find_tests` follow them like any other edge (FR169).
- A file reports `resolved_calls` `partial` when a call site matches no occurrence, and `unsupported` with `imports` where the syntax tier lacks the language or cannot be reached (FR166, FR170).
- The index is read one document at a time, in memory that grows with its definitions, not its size; `proofmesh scip add` too (FR164). An index with a document before its metadata, or a length longer than the file, is refused; a document is read again only while the index file is unchanged.

Build graph, Maven and Gradle (part of #13):

- The build adapter reads `pom.xml`, `settings.gradle(.kts)`, `build.gradle(.kts)` and `gradle/libs.versions.toml` as captured text and never runs a build tool, a JVM or a script. A pom is a `project` named `groupId:artifactId` and a Gradle `include` a project named by its path; each contains the source files under its directory, `depends_on` records the modules a dependency names, and `depends_on_package` records the others as `maven:<group>:<artifact>` with their version. Gradle facts are marked `inferred`. A dependency a Gradle script computes is named as unresolved (`dynamic_specifier`) at its line and its file reports `partial` in the census (FR151 to FR160). Bazel and Buck stay open on #13.
- `settings.gradle.kts` and `build.gradle.kts` go to the build adapter as manifests, no longer to the syntax tier as Kotlin source.

Stable symbol keys (#15):

- Every tier names a declaration by one qualified name per language: the declared package or namespace for C#, Java, Kotlin, Scala and PHP (`com.acme.Shop.add(int)`), `<path>:<containers>.<name>` for the rest, with a Go receiver, a Rust `impl` target (and its trait, `X.<Display>.fmt`) and a C++ out-of-class owner as the container, a Go struct or interface kept as such, parameter types on overloads, and a C or C++ prototype merged into its definition (FR146). A Python property setter is `C.x(value)`.
- `stable_key` is unique in a snapshot: the core tells any remaining duplicates apart by `~` and a hash of their text, so a new duplicate renames none, and records every one in the snapshot meta. Snapshot format 0.8 adds a unique index on it, so the next index of every repository rebuilds, and the keys of syntax-tier and SCIP symbols change once (FR147).
- The SCIP importer takes each definition's name, kind and span from the syntax tier's declaration of it, so naming an index changes no key and no `body_hash` (FR148).
- `get_symbol`, `get_relationships`, `analyze_impact`, `find_tests` and `get_memory` take `key`, and `trace_paths` takes `source_key` and `target_key` (FR149).
- `get_memory` lists a reference that matches several symbols under `ambiguous_refs` with their keys (staleness `ambiguous`), and reports `tier_changed` when only the tier that analysed a referenced file changed (FR150). A fingerprint accepted before still reads: it is the relationships part alone. Names changed with format 0.8, so a note reference written in the older form reports as missing, once, with that explanation; rewrite it (notes are not migrated).

Language census (#3):

- `workspace_status` returns `languages`, and `proofmesh status` prints it: every file in exactly one language row (Linguist's names; `unknown` names its extension), with kind, file counts by disposition, the tier that read it (`precise:<adapter>`, `scip:<index>`, `syntax`, `none`), capability counts per level, why it stops there, and a remedy from one table that `docs/proofmesh/languages.md` shows (FR136 to FR141).
- Each indexed source file records its tier as the `tier` key of its capabilities. An extensionless script with a shebang, and a `.h` that holds C++, are routed to their syntax-tier grammar.
- A Linguist language table, trimmed, is vendored as data under the MIT licence (`THIRD_PARTY_NOTICES.md`).
- The census version derives from the remedy table, the Linguist data and the detection rules, and is part of a snapshot's manifest hash, so older snapshots are stale under strict freshness and get rebuilt. Unknown files are bounded: `(no extension)`, `(other)` and a 64-row cap with a last `other` row; Objective-C headers are their own row; header detection ignores comments and strings.
- `PROOFMESH_CS_ADAPTER` naming a file that does not exist now leaves the C# adapter unavailable (`adapter_unavailable:csharp`) instead of trying to start it. `proofmesh status` accepts a repository path as well as its id.

Symbol identity across change (#7):

- Every symbol records `body_hash`, the hash of its declaration text with line endings, common indentation, trailing whitespace and its own name normalised, in every tier; a module's is its file's text (FR130). Snapshot format 0.7 adds the column, so the next index of every repository rebuilds; a snapshot sealed before answers a null hash and says to index again (FR135).
- `get_symbol` returns `stable_key` and `body_hash`, in the lean row too (FR131).
- `compare_snapshots` reports `body` among a changed symbol's change kinds with the ids, keys and hashes of both sides (FR132), pairs one removed and one added symbol of equal kind and hash as `moved`, `renamed` or `moved_renamed`, and lists any other match as `ambiguous` with its candidates (FR133, FR134). Bodies below 10 tokens are never paired, and a method moved to another class of its file pairs as `moved`. A paired symbol is no longer both removed and added.

The symbol at a location (#8):

- `get_symbols_at` takes 1 to 100 locations `path:line` and returns, for each in order, the innermost symbol whose declaration span holds the line, with its id, `stable_key`, kind, lines and tier, or the file's module; a location it cannot answer has its own reason or error. A SCIP definition with no enclosing range takes its span from the syntax tier's parse of the declaration, and the graph benchmark records the tool's p95 latency (FR119 to FR123).

Build graph, JavaScript and Go (part of #5):

- A build adapter reads `package.json`, `tsconfig.json`, `go.mod` and `go.work` as captured text, never running a script or tool. A named package or Go module is a `project` symbol that `contains` the module symbol of each file under it (nearest manifest first), so `analyze_impact` groups dependents by project; it records `depends_on` between projects in the repository (workspace members, `tsconfig` references, `go.work` and local `replace`) and `depends_on_package` for other dependencies with their versions (FR124 to FR129). Cargo, pyproject, Composer and gemspec manifests stay open on #5.

Syntax-tier structure, Go and Java (#4):

- The syntax tier records each Go and Java import statement with the module as written (and a Go alias), each Java `extends` and `implements` and each Go struct embedding as `inherits` or `implements` from the declaring type, all unresolved with `outside_capability` (FR115 to FR117). `languages.md` states per language which of imports, heritage and calls the tier records (FR118).

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
