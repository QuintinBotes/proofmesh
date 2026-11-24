# Proofmesh — Product Specification and Spec Kit Source Packet

- Feature: `001-proofmesh-foundation`
- Status: Draft for maintainer review, revision 5 (amendments A1–A14 in ADR-0001 section 10 are requirements of this specification)
- Date: 2026-11-07 (revision 1: 2026-11-06)
- Scope: Local-first open-source release; execution and shared hosting are separately gated
- Normative terms: MUST, MUST NOT, SHOULD, MAY express requirement strength
- Related decisions: ADR-0001 revision 3
- Requirement IDs from revision 1 are preserved; new requirements start at FR055 and NFR013

## 1. Product definition

Proofmesh gives coding agents and the people who review their work a persistent code graph whose findings have inspectable evidence, declared coverage, and reproducible checks. It runs locally, exposes the same core capabilities through MCP and a CLI, and draws the graph in Observatory, a local visual interface that shows where analysis is complete, where it stops, and why.

The first public release supports TypeScript and JavaScript (with React), Python, Terraform, and C#. Other files are inventoried, and supported text may be searched, but semantic support MUST NOT be implied without a validated adapter.

Proofmesh is open source under Apache-2.0, developed in public from its first public release, and extensible through an out-of-process adapter protocol.

## 2. Spec Kit integration and execution

### 2.1 Artifact authority

These delivered documents are a source packet. When the repository adopts them, materialize:

```text
.specify/memory/constitution.md
specs/001-proofmesh-foundation/
  spec.md
  plan.md
  research.md
  data-model.md
  quickstart.md
  contracts/
  checklists/requirements.md
  checklists/security.md
  checklists/verification.md
  checklists/observatory.md
  checklists/open-source.md
  tasks.md
docs/adr/0001-proofmesh.md
docs/architecture.md
docs/milestones/m0-walking-skeleton.md
```

Copy this document's constitution into `constitution.md`; use its product requirements as `spec.md`. Use the architecture companion as the source for `plan.md`, data model, contracts, and quickstart. Use the M0 document for the first milestone. Preserve requirement IDs. After extraction, the canonical repository artifacts become authoritative; archive this source packet to avoid competing specifications.

Contracts are JSON Schema files in `schemas/`, validated in tests. Do not invent placeholder schemas and call contracts complete.

### 2.2 Workflow

1. Establish the constitution.
2. Specify outcomes and review user stories.
3. Clarify material ambiguity and record decisions (Orbit Inquisition).
4. Plan architecture and generate contracts and the data model.
5. Generate requirements, security, verification, Observatory, and open-source checklists.
6. Derive dependency-ordered tasks per milestone with requirement and test references.
7. Analyze cross-artifact consistency.
8. Execute one milestone at a time as an Orbit run from a committed baseline, with the milestone's acceptance criteria and verification commands as its goal.
9. Converge implementation against requirements and recorded evidence.

Installing the Spec Kit tooling is optional; the layout is what matters. Completion requires review and passing tests, not merely a tool reporting convergence.

### 2.3 Constitution text

1. Evidence before assertion: architectural findings require provenance and scope.
2. Honest uncertainty: incomplete coverage, unresolved targets, and truncation remain visible.
3. Reproducibility: version inputs, adapters, contracts, toolchains, and verification records.
4. Local by default: no telemetry, upload, account, or remote model dependency for core operation.
5. Least privilege: read operations cannot execute code; execution requires bound approval.
6. Deterministic core: model output is optional and cannot create trusted facts automatically.
7. Testable contracts: every MUST requirement maps to an acceptance test or documented manual gate.
8. Incremental equivalence: updates must converge to a clean index of identical inputs.
9. Interoperability: MCP is client-neutral; compatibility claims require recorded tests.
10. Maintainability: one embedded store, one core runtime, and a small operational surface; a database server or a new core runtime requires an ADR.
11. Accessible distribution: installation, upgrade, backup, export, and removal are documented and tested.
12. Governed changes: constitution amendments include rationale, impact, migration, and maintainer approval.
13. Open by default: Apache-2.0, public decisions, contributions under the Developer Certificate of Origin; no feature in this specification is withheld from the open-source release.
14. Honest visuals: a view never claims more than its data; limits and gaps are drawn, not hidden.
15. Explicit trust: build logic runs only for a repository a person has trusted, and every result says so.

## 3. User stories and independent acceptance

### US1 — Install privately (P1)

As a developer, I can install Proofmesh with one command, register a repository, and inspect health without creating an account or running a database server.

Acceptance: from an empty data directory, a supported installation reaches readiness; only the loopback HTTP endpoint listens, and only while serving; tokens are generated per installation; no repository source leaves the machine; no separate database service is required.

### US2 — Inspect coverage (P1)

As an investigator, I can see exactly what was indexed and which analysis capabilities are missing.

Acceptance: every discovered file has a disposition; failed, excluded, unsupported, and pending files are inspectable; symbol coverage and call-resolution coverage are separate; the analysis mode is visible.

### US3 — Trace real relationships (P1)

As a coding-agent user, I can find symbols, follow resolved relationships, inspect ambiguous and external targets, and read exact source evidence.

Acceptance: a reviewed fixture yields the expected cross-package path; unrelated same-name symbols do not acquire false edges; calls into standard libraries are marked as resolved outside scope rather than unresolved; limits are returned explicitly; a bounded search that finds nothing says whether it was stopped by a limit, by unresolved boundaries, or exhausted the resolved graph.

### US4 — Trust freshness (P1)

As a developer editing code, I can request current-working-tree evidence or understand why freshness could not be established.

Acceptance: edits, deletes, renames, configuration changes, and branch switches are reflected or explicitly block strict freshness; old snapshots remain distinct.

### US5 — Check a finding (P1)

As a reviewer, I can validate a structured claim without trusting the agent's prose.

Acceptance: source tampering fails integrity checks; replay and independent corroboration are labeled separately; missing evidence cannot pass.

### US6 — Use multiple clients (P1)

As a Claude Code or Codex user, I can run the same core investigation through MCP.

Acceptance: certified client and transport combinations complete symbol → path → evidence → claim verification against the same snapshot. Other clients have honest compatibility status.

### US7 — Export an investigation (P1)

As a maintainer, I can export a portable evidence bundle and validate its integrity without a running Proofmesh service.

Acceptance: export previews included source; an offline checker validates hashes and references, and reports semantic checks it cannot perform.

### US8 — Run approved checks (P2; execution release)

As a developer, I can approve an exact verification recipe without giving the agent arbitrary host execution.

Acceptance: changing the command, snapshot, environment, or policy invalidates approval; execution occurs outside original source; replay is rejected.

### US9 — Analyze application wiring (P2)

As an investigator, I can trace domain connections through supported events, routes, jobs, or dependency injection.

Acceptance: each adapter has fixtures and capability coverage; unsupported mechanisms remain unresolved rather than absent.

### US10 — Operate and upgrade (P1)

As an operator, I can back up, upgrade, restore, inspect failures, and remove local data.

Acceptance: supported migration paths pass restore tests; a failed migration does not publish incompatible state; removal requires explicit confirmation.

### US11 — See the system (P1)

As an investigator, I can explore the indexed graph visually, from a whole-repository map down to one call site, and see where analysis is incomplete.

Acceptance: on a reviewed fixture, the overview shows every package with its counts and coverage; zooming reaches individual symbols; a traced path renders with resolution styles; a truncated trace ends at a horizon with the unexplored count; unsupported and failed files appear as fog, not as empty space; every rendered node and edge opens its evidence; every view has a table equivalent.

### US12 — Read a claim at a glance (P1)

As a reviewer, I can see a claim's evidence and each verification layer in one view.

Acceptance: a tampered-evidence fixture shows an integrity failure in the claim view and in the evidence panel; a failed or unavailable layer is never drawn smaller, dimmer, or later than passed layers.

### US13 — Replay an investigation (P2)

As a reviewer, I can replay which parts of the graph an agent's queries actually reached, against the scope its claim declares.

Acceptance: on a recorded fixture session, nodes returned by the session's queries light up in order; truncated query frontiers show as horizons; the claim's declared scope boundary is drawn; regions inside the scope that no query reached remain visibly unreached.

### US14 — Compare snapshots (P2)

As a developer, I can see what changed in the graph between two snapshots.

Acceptance: added, removed, and changed symbols and relationships render distinctly; the comparison names both snapshots and their analysis modes.

### US15 — Share a view (P2)

As a maintainer, I can export a view as an image or a self-contained offline HTML page.

Acceptance: every export carries snapshot, scope, limits, analysis mode, and legend inside the artifact; exports containing source require explicit consent; the HTML export makes no network requests.

### US16 — Analyze my stack (P1)

As a developer, I can index a repository that mixes TypeScript or JavaScript with React, Python, Terraform, and C#, and get per-ecosystem coverage.

Acceptance: each ecosystem has reviewed fixtures and a published capability statement; React components resolve render relationships to their definitions; Python calls resolve across modules; Terraform references resolve across resources, variables, locals, outputs, and local modules, with remote modules reported unresolved; C# in no-execution mode resolves symbols declared in the repository and reports targets that need restore or generated code as unresolved.

### US17 — Trust a build explicitly (P1)

As a C# developer, I can opt one repository into build evaluation for precise analysis, and see that choice everywhere its results appear.

Acceptance: without a grant, no MSBuild evaluation, restore, analyzer, or source generator runs; a grant can be made and revoked only through the CLI; snapshots and facts record the mode; MCP envelopes, exports, and Observatory display it; revoking a grant makes the next index run without build evaluation.

### US18 — Add a language (P1)

As a contributor, I can build an adapter for another language with the published protocol and conformance kit, without changing the core.

Acceptance: the first-party adapters use only the public protocol and pass the public kit; an adapter that fails the kit cannot be labeled supported.

### US19 — Contribute safely (P1 for the first public release)

As an outside contributor, I can propose a change through the public process.

Acceptance: CI runs my pull request without secrets or release credentials; licensing and sign-off requirements are documented and checked; security reports have a private channel.

## 4. Functional requirements

### Discovery and coverage

- FR001: MUST inventory configured repository roots and account for each discovered file.
- FR002: MUST assign exactly one disposition: indexed, excluded_by_rule, unsupported, failed, pending.
- FR003: MUST report capability status separately: text, syntax, symbols, imports, references, resolved calls, framework relationships.
- FR004: MUST expose exclusion rules, oversized files, generated-source policy, external dependency policy, and errors.
- FR005: MUST prevent symlink cycles and reads outside authorized roots.
- FR006: MUST support non-Git repositories and explicitly identify unavailable Git metadata.

### Indexing and freshness

- FR007: MUST persist indexing checkpoints and permit resumption.
- FR008: MUST hash content and invalidate dependent facts when source, configuration, adapters, or analysis mode change.
- FR009: MUST reconcile watcher events; correctness MUST NOT depend on commits or filesystem notifications alone.
- FR010: MUST pin queries to a published snapshot.
- FR011: MUST stage, validate, then atomically publish snapshots.
- FR012: MUST distinguish indexed-snapshot queries from strict working-tree freshness.
- FR013: MUST report unstable capture rather than fabricate atomicity.
- FR014: MUST converge incrementally to normalized clean-index results for equivalent inputs.
- FR015: MUST expose finite resource limits and never silently replace a requested repository scope with a smaller graph.

### Relationships and queries

- FR016: MUST distinguish syntax, semantic resolver, configuration adapter, framework adapter, runtime observation, documentation, human assertion, and model hypothesis origins.
- FR017: MUST distinguish resolved, resolved-outside-scope, candidate, ambiguous, and unresolved targets.
- FR018: MUST preserve unresolved call sites and resolution reasons.
- FR019: MUST provide symbol, reference, relationship, path, impact, test-discovery, source-search, overview, and snapshot-comparison queries.
- FR020: MUST bound traversal depth, time, rows, and output bytes independently.
- FR021: MUST return truncation, timeouts, unresolved boundaries, and continuation constraints.
- FR022: MUST distinguish shortest paths, bounded discovered paths, and exhaustive claims; a negative path result MUST state whether limits, unresolved boundaries, or exhaustion of the resolved graph ended the search.
- FR023: MUST NOT infer executable relationships from name similarity or embeddings alone.
- FR024: MUST keep static test links separate from observed execution coverage.
- FR089: MUST let every tool that takes `subject_id`, `subject_ids`, `source_id`, `target_id` or `symbol_id` also take a file by its repository-relative path (`path`, `paths`, `source_path`, `target_path`), meaning the file itself; at least `get_relationships`, `analyze_impact`, `trace_paths`, `get_symbol`, `get_memory` and `find_tests`. `..`, absolute paths inside the repository and backslashes are normalised to repository-relative forward slashes; a path leaving the repository is refused.
- FR090: MUST answer file questions (imports in and out, dependents) for the module symbol `find_symbols` returns for a file exactly as for the file, so no tool needs a `file_` id an agent cannot get.
- FR091: MUST walk `analyze_impact` with `types` including `imports` file to file, breadth first and bounded by `max_depth`, reporting each file once at its shortest depth with the `file:line` of the import that reached it; an import cycle ends the walk.
- FR092: MUST record each import's kind: `static`, `re_export` (`export ... from`), `type_only` (`import type`, `export type`), and `dynamic` for `import()` with a string-literal or no-substitution template specifier; an `import()` with a computed specifier is `unresolved` with reason `dynamic_specifier`, and an import of a repository file that is not indexed is `unresolved`, never `resolved_external`: with reason `not_indexed` where the adapter can see the file (a JSON data file, or a file another adapter reads), else `import_unresolved`.
- FR093: MUST resolve a specifier naming a Node.js built-in (`node:x`, or a bare name in `module.builtinModules`) to the external module `node:<name>` as `resolved_external`, with or without `@types/node`, unless an explicit tsconfig `paths` entry maps the specifier to a repository file: then it is that file, as tsc and editors resolve it. A repository file of a built-in's name that no `paths` entry maps to does not count.
- FR094: MUST refuse a path that is not indexed in the snapshot with `INVALID_ARGUMENT` naming the path and its disposition (`excluded`, `unsupported`, `failed` or `not found`), never an empty success.

### Test reach

- FR101: MUST give every `find_tests` row one evidence kind: `call` (the test calls or constructs the subject), `transitive_call` (through two or more resolved calls, depth being the number of calls), `dispatch` (the chain includes a call resolved to an interface or base member that the subject implements or overrides, named in `via`), `reference` (the test reads or passes the subject without calling it), or `import_only` (a test file imports the subject, or for a file subject the file, and nothing in it calls or references the subject; the row is the file and the import line). Only calls, and a React render or hook use, carry execution: an `implements`, `overrides`, `inherits` or injection edge does not, and a reference ends its chain. Where the snapshot records no `implements` or `overrides` for the subject's language, the answer MUST say that calls through interfaces and base classes are not followed. A lean row is the test at its first call toward the subject with `depth=<n>`, tagged `dispatch` or `reference` for those kinds; an `import_only` row is `<path>:<line> import_only`.
- FR102: MUST record a TypeScript use of a repository variable (read or assigned), and a function or method used as a value without being called, as a `references` with use `value`, one per user and target at its first site; a call stays a `calls` and a JSX tag a `renders`.
- FR103: MUST give each `find_tests` row the shortest chain of its evidence, from the test's first call site to the subject at its declaration, as `name file:line` hops.
- FR104: MUST order `find_tests` rows by evidence (`call`, `transitive_call`, `dispatch`, `reference`, `import_only`), then depth, then path and line, list a test once per answer at its strongest evidence, and page the rows by `max_rows` with a cursor and totals over every row.
- FR105: MUST split `find_tests` totals into `executing` (`call`, `transitive_call`, `dispatch`, observed) and `not_executing` (`reference`, `import_only`).
- FR106: MUST provide `proofmesh tests <repository> <path | path#name> [--json]`, which prints the `find_tests` rows of the file or of the symbol `name` declared in it (with `--json`, the answer), exits 0 when at least one test executes the subject, 1 when none does, and 2 on a usage error or an unknown subject.
- FR107: MUST recognise test code for `find_tests` by path and project naming, and say so in every answer, a lean answer through the tool's description.

### Impact completeness

- FR108: MUST provide `impact_completeness` with `base`, a commit-ish, optional `head` (omitted, the working tree), `depth` (default 1, at most 5), `include_tests` and the usual limits, and the CLI `proofmesh completeness <repository> <base>[..<head>] [--depth N] [--json]`.
- FR109: MUST answer each side from the sealed snapshot its commit's last index produced, or for the working tree from the current snapshot while it matches the tree. Over MCP a side with no snapshot starts its index job, a commit's with `--keep-current` so the current snapshot stays as it was, and the answer is `pending` with the job ids for `get_job`; starting a job makes the tool a management tool (FR036). The CLI indexes the head first, then the base, and waits.
- FR110: MUST take the changed symbols from `git diff --unified=0` between base and head, untracked files of the working tree counting as wholly added. The innermost symbol of each changed head line (a method, not its class) is `modified` when base has a symbol of that kind and qualified name, else `added`. A base symbol with a removed line and no such counterpart in head is `deleted`. Lines that only moved are no change. A changed top-level line that is a statement, not blank, a comment, an import, an export list or `export default` of a name, makes the module changed, whose dependents are its importers. A file renamed with no other change is its module, `modified`. Test code is no changed symbol unless `include_tests`.
- FR111: MUST list the dependents of each changed symbol from the head snapshot, or the base snapshot for a deleted one: callers, a call dispatched through an interface or base member included `via` that member; implementers and overriders; subclasses; references; importers. Each is one row per dependent and relation (`calls`, `implements`, `overrides`, `inherits`, `references`, `imports`) at its first site. An importer is a file row only when its import binds the symbol's name or the whole module and nothing else in the file has a row. A `depth` above 1 adds callers of callers, `via` the caller they reach the change through. Dependents are ordered by relation in that order, then path and line, and test code is no dependent unless `include_tests`.
- FR112: MUST give each dependent one status, the first that holds: `changed` when its declaration overlaps a changed hunk (a file row when the diff touches the file); `tested` when a test executes it by `find_tests`' `call`, `transitive_call`, `dispatch` or observed evidence, naming the nearest test as `name file:line` with its evidence and depth, and saying when the diff changed that test; else `neither`. A changed symbol is `tested` or `neither`.
- FR113: MUST answer `changed[]` (`id`, `name`, `path`, `line`, `change`, `status`, `test`, `dependents[]` of `id`, `name`, `path`, `line`, `relation`, `via`, `status`, `test`) by path and line, with `totals` (`changed_symbols`, `dependents`, `changed`, `tested`, `neither`) over every changed symbol, paged by `max_rows` with a cursor. A lean row is `changed <name> <path>:<line> <change> <status>`, each dependent below it `  <relation> <name> <path>:<line> <status>`, then a `# summary:` line. The answer MUST name the files the diff touches that no snapshot analyses, say when a test search behind a `neither` stopped at the depth limit or could not follow dispatch, and say that dependents in other repositories of a workspace are not searched.
- FR114: MUST exit `proofmesh completeness` 0 when no dependent is `neither`, 1 when one is, and 2 on a usage error, an unknown commit or a failed index.

### Syntax-tier structure

- FR115: MUST record, in the syntax tier, one `imports` row per import statement in Go and Java, from the file at the statement, with the module exactly as written in `detail.module` (a Java wildcard ends in `.*`) and a Go alias in `detail.alias`.
- FR116: MUST record, in the syntax tier, an `inherits` row for each class a Java class extends and each type a Go struct embeds (`detail.relation` `embedding`), and an `implements` row for each interface a Java class, enum or record implements, from the declaring type at the supertype's name, with that name in `detail.name`.
- FR117: MUST leave every syntax-tier `imports`, `inherits` and `implements` row unresolved with reason `outside_capability` and no target; binding them belongs to constrained resolution (FR023).
- FR118: MUST state in `docs/proofmesh/languages.md`, per syntax-tier language, which of imports, heritage and calls the tier records.

### Locating symbols

- FR119: MUST provide `get_symbols_at`, which takes 1 to 100 locations `path:line` (a `path:line:column` is read by its line, and the answer says so) and returns one result per location, in order: the innermost symbol whose declaration span holds the line, or the file's module symbol when no inner symbol holds it. A location it cannot answer (`not_found`, `line_out_of_range`, a file the snapshot does not index, a file with no symbol) is a null symbol with its own reason or error and does not fail the call; more than 100 locations, or one that is not `path:line`, is `INVALID_ARGUMENT`, and a call cut by `max_rows` or `max_bytes` gives a cursor for the locations not yet answered. When two symbols have equal spans, the choice is by kind (function or method, then property or variable, then type) and then id, the same on every run.
- FR120: MUST give each symbol it returns as `id`, `stable_key`, `name`, `qualified_name`, `kind`, `path`, `start_line`, `end_line` and `tier` (`precise`, `syntax` or `scip`: the tier of the adapter that declared it).
- FR121: MUST take the span of a SCIP definition that has no enclosing range from the syntax tier's parse of the same declaration, so that every tier's declaration span covers the declaration's body. When the syntax tier cannot give it (its adapter is missing, fails or times out, or does not cover the language), the definition keeps its name's span and the file reports its symbols `partial`.
- FR122: MUST answer a single-location call in 20 ms or less at p95 and a 100-location call in 100 ms or less at p95 on the warm graph-bench snapshot over MCP stdio, and the graph benchmark MUST record both figures in its results file.
- FR123: MUST answer in the lean form on request, and over MCP by default: one row per location, the location then the symbol as `name path:line kind`, or `-` and the reason.

### Build graph

- FR124: MUST declare, from the manifests of the JavaScript and Go ecosystems read as captured text, one `project` symbol per `package.json` that names a package and per `go.mod`, named by the npm name or the Go module path and declared at the line of that name; a manifest that names nothing declares none, and a manifest under `testdata` or `vendor` declares nothing.
- FR125: MUST record `contains` from each project to the module symbol of every source file under it, from the nearest enclosing manifest that declares a project; a file under none is contained by none, and `analyze_impact` groups its dependents under the project (never `(no project)`) when one contains it.
- FR126: MUST record `depends_on` between projects in the repository, `resolved` and from the configuration adapter, at the line that declares each: a `package.json` dependency on a workspace member (listed by a `package.json` `workspaces` or a `pnpm-workspace.yaml` `packages`; a `workspace:` dependency with no list at all means any named package; a `file:` or `link:` to a project directory), a `tsconfig.json` `references` entry, and a `go.mod` `require` that a local `replace` or a module a `go.work` above it uses satisfies. A path outside the repository, or a replace into a directory without a manifest, is `unresolved` with reason `dependency_missing` naming the path; two projects of one name make a dependency on it `ambiguous` with both as candidates.
- FR127: MUST record `depends_on_package` to every other declared dependency (a `file:` or `link:` to a tarball or a non-project directory included; `tsconfig.json` `extends` is not read) as `resolved_external` `<ecosystem>:<name>` (`npm`, `go`) with the declared version in `detail.version`.
- FR128: MUST fail a manifest that does not parse, with a disposition detail naming the line, and still read every other manifest.
- FR129: MUST keep every `package.json` and `tsconfig.json` reaching the TypeScript adapter as configuration as well as the build adapter, and MUST answer every build fact on each index, so that an incremental index equals a clean one (FR014).

### Symbol identity

- FR130: MUST record in every new snapshot, for every symbol and whatever adapter or tier declared it, `body_hash`: the SHA-256, in 64 lowercase hex characters, of the declaration's span as the snapshot records it, with line endings read as LF, the lines' common leading indentation and every line's trailing whitespace removed, and the symbol's own simple name replaced by one fixed placeholder wherever it is a whole identifier that is not a member access (`.name`), so `get` and `set` methods that differ only by name and the member they call stay apart. A module's hash is that of its file's text, with no name masked. A symbol whose span is no more than its name has a null `body_hash`, and so does one whose file content was unavailable at seal time; the snapshot records those files in its meta. The snapshot format gains the column additively (0.7), and the hash is computed at seal time in the core.
- FR131: MUST return `stable_key` and `body_hash` from `get_symbol`, in the lean row as well.
- FR132: MUST report `body` among a changed symbol's change kinds in `compare_snapshots` when its `body_hash` differs between the snapshots, and MUST return the id, `stable_key` and `body_hash` of both sides of every changed symbol. A module's text change is the file's, listed under `files.changed`, not a symbol change.
- FR133: MUST pair, in `compare_snapshots`, exactly one removed and exactly one added symbol of the same kind and `body_hash` as `moved` (the path or the container differs), `renamed` (the name differs) or `moved_renamed` (both), with both ids, both keys and the shared hash, only when the normalised text is at least 10 tokens (words, numbers and each other non-space character): a smaller match is not paired, not listed as ambiguous, and counted in `counts.too_small` with a limitation, and MUST leave a paired symbol out of the added and removed lists. A module is `moved` whatever its file is now called.
- FR134: MUST report any other match of removed and added symbols of one kind and `body_hash` (several on either side) as one `ambiguous` entry listing every candidate, and MUST leave those symbols in the added and removed lists. A symbol with a null hash is never paired.
- FR135: MUST answer a snapshot sealed before hashes existed with a null `body_hash` and a limitation saying to index again, from `get_symbol` and from `compare_snapshots` (which then pairs nothing and reports no body change), and MUST NOT compute a hash at query time from another reading of the span. A snapshot that recorded unreadable files names them in a limitation of `get_symbol` and `compare_snapshots`.

### Language census

- FR136: MUST classify every discovered file into exactly one language, or `unknown` with its extension (or its whole name when it has none), and one kind (`code`, `template`, `data` or `prose`; the rows of binary files and of unknown languages carry the kinds `binary` and `unknown`), with no configuration. Detection uses the file name, the longest known extension, the shebang of a file with no extension, and a content check for `.h` (C++ or Objective-C when the text says so, else C); an extension several languages share that no check settles is `unknown`, never a guess. Language names, kinds and detection data follow GitHub Linguist's `languages.yml`, vendored as a trimmed table with its MIT notice in `THIRD_PARTY_NOTICES.md`.
- FR137: MUST record on each indexed source file the tier that produced its facts (`precise:<adapter>`, `scip:<index>` or `syntax`) as the additive `tier` key of the file's capabilities, which no snapshot-wide capability counts. A file only captured (configuration, ownership, a service registry) has no tier.
- FR138: MUST return from `workspace_status` the language census `languages`: one row per language (per extension for `unknown`) in the order kind (`code`, `template`, `data`, `prose`, then `unknown` and `binary`), file count descending, name, with `files`, `dispositions`, `excluded` (files left out by rule, by rule), `tier` and `tiers` (each tier that read files of the row, with its file count; two tiers in one language show both), `capabilities` (for `symbols`, `imports`, `references` and `resolved_calls`, the count of the row's files at each level, each capability summing to `files`), `reason` and `remedy`. Every file is in exactly one row. A repository with no recognised code answers data and prose rows and a limitation saying so. A snapshot sealed before the census answers no rows and a limitation saying to index again.
- FR139: MUST route a file whose language only its shebang or content gives (an extensionless script, a `.h` holding C++) to that language's syntax-tier grammar, so that an extensionless bash script is Shell and its functions are symbols.
- FR140: MUST take every remedy from one table of language to precise route (built-in adapter, SDK and build, SCIP indexer), advice only: the census runs nothing and installs nothing. `docs/proofmesh/languages.md` MUST show the same table. A stale SCIP index is the reason `scip_stale:<index>` and its remedy says to produce the index again and name it again; a C# adapter that is not present names the .NET 10 SDK and `dotnet build adapters/csharp -c Release`.
- FR141: MUST print from `proofmesh status` one line per census row in the tool's order (language, files, tier, the weakest capability, and the remedy when there is one), and the tool's `languages` array unchanged with `--json`. A repository may be named by its path as well as its id.

### Evidence and claims

- FR025: MUST link reported graph facts to source evidence, hashes, extractor versions, and analysis mode.
- FR026: MUST preserve conflicting observations and multiple supporting evidence records.
- FR027: MUST represent claims structurally with statement, proposition type, scope, snapshot, dependencies, checks, verdict, and limitations.
- FR028: MUST expose individual verification-layer outcomes.
- FR029: MUST validate evidence integrity and support extractor replay where the adapter supports it.
- FR030: MUST qualify or reject absence and safety claims unsupported by coverage and a closed-world contract.
- FR031: MUST mark stale or unavailable evidence explicitly.
- FR032: MUST provide offline bundle integrity verification.
- FR033: MUST NOT describe free-form unvalidated agent prose as a verified report.

### MCP and management

- FR034: MUST implement stdio and Streamable HTTP over the same application logic.
- FR035: MUST provide tools for all required read capabilities without requiring client-specific prompts or resources.
- FR036: MUST separate read, management, and execution capabilities.
- FR037: MUST validate input and output schemas and publish a versioned contract manifest.
- FR038: MUST support cancellation, deadlines, bounded payloads, and structured errors.
- FR039: MUST prevent logs on protocol stdout.
- FR040: MUST report tested client and transport versions and avoid untested compatibility claims.
- FR041: MUST generate configuration proposals without silently editing client settings.
- FR095: MUST offer a lean envelope (`envelope: "lean"`) on the query tools whose results are code locations (`find_symbols`, `get_symbol`, `get_relationships`, `trace_paths`, `analyze_impact`, `find_tests`): plain text with no JSON and no `structuredContent`, made of a header `# <tool> · <n> rows · <snapshot id> current|stale`, one row per result, then `# ` lines for the limitations of that answer and, when a next page exists, `# more: cursor <c>`, which continues it with no row repeated or skipped. An answer from a snapshot older than the repository's current one still answers, and its header says `stale`.
- FR096: MUST write a lean row as `<name> <path>:<line>` followed by optional space-separated tags: `in` or `out` when both directions are asked, `depth=<n>`, `dispatch`, `external`, `candidate`, `ambiguous`, `unresolved:<reason>`, and the relationship type when a query mixes types. `<name>` is the qualified name without its module prefix; a file or module row is `<path>:<line>` alone; a name or path holding a space, a quote or `#` is quoted as JSON; a row with no site in the repository is `<name> external`.
- FR097: MUST make a lean row's `<line>` the site for relationship, impact and path rows (the call, import or reference line; for an impact row, that of the relationship that first reached it) and the declaration for symbol rows. Every in-repository row has one, and a caller has one row per call site.
- FR098: MUST make `trace_paths` lean rows the hops of the path in order: each node at its call to the next (at its declaration for a dispatch hop), then the target at its declaration, so reading the path needs no follow-up call.
- FR099: MUST make lean the default envelope over MCP for the tools of FR095; `compact` and `full` stay selectable by name, and only they send `structuredContent`.
- FR100: MUST keep ids available without bloating rows: `find_symbols` lean rows end with `id=<symbol id>` only with `include_ids: true`; every symbol id parameter also accepts `{ name, path }`, a name unique in that file (the name a row shows, or the plain name); an ambiguous name is `INVALID_ARGUMENT` listing the candidates as lean rows with their ids.

### Execution, optional release gate

- FR042: MUST NOT execute repository code from read tools, parsing hooks, or source instructions.
- FR043: MUST prepare an exact verification plan before approval.
- FR044: MUST bind approval to snapshot, recipe and image, argv, directory, environment policy, network and filesystem policy, limits, identity, and expiry.
- FR045: MUST reject reused, expired, modified, or unauthorized approval.
- FR046: MUST execute in a disposable workspace with explicit limits and captured output.
- FR047: MUST disclose sandbox limitations and record generated changes.
- FR048: MUST NOT give the query or index service access to a container runtime.

### Distribution and lifecycle

- FR049: MUST publish versioned installable packages and an OCI image, with checksums, SBOM, signatures, provenance, and release notes.
- FR050: MUST supply health, readiness, diagnostics, backup and restore, migration, and removal workflows.
- FR051: MUST enforce retention without deleting pinned or active evidence.
- FR052: MUST require explicit consent for source-containing exports and destructive operations.
- FR053: MUST default to local and private access, no telemetry, and no remote model requests.
- FR054: MUST NOT advertise shared multi-user deployment until a separate security design is approved.

### Observatory

- FR055: MUST provide Observatory, a local web interface served by the Proofmesh process on its loopback endpoint, built only on the capabilities available to other clients.
- FR056: MUST render a whole-snapshot overview with hierarchical aggregation (repository, package or directory, file, symbol) whose aggregates show contained counts and coverage.
- FR057: MUST render neighborhoods and traced paths with encodings that distinguish origin, resolution status, and analysis mode without relying on color alone.
- FR058: MUST draw truncation, budget limits, timeouts, and unresolved boundaries in every view; no setting hides them.
- FR059: MUST render incomplete coverage (unsupported, failed, pending, excluded, and unresolved-heavy regions) visibly and distinctly from empty space.
- FR060: MUST open exact evidence (range, hash, extractor, analysis mode, integrity status) for any rendered node or edge.
- FR061: MUST render claims with their per-layer verification outcomes; a failed or unavailable layer is never visually subordinate to passed layers.
- FR062: SHOULD replay a recorded agent session's queries against its claims' declared scope (P2).
- FR063: SHOULD compare two snapshots visually (P2).
- FR064: MUST label every exported image or HTML page with snapshot, scope, limits, analysis mode, and legend; source-containing exports require consent (FR052).
- FR065: MUST treat repository content as untrusted in the browser: text-only rendering, strict Content Security Policy, no remote assets, visible escaping of bidirectional and invisible characters.
- FR066: MUST authenticate the browser session to the local installation and reject cross-origin and DNS-rebinding requests.
- FR067: MUST offer a non-visual equivalent for every view and honor reduced-motion, color-scheme, and contrast preferences.
- FR068: MUST keep layout derived and non-evidential; spatial proximity is never presented as a relationship.

### Open source and extensibility

- FR069: MUST publish source under Apache-2.0 with `LICENSE`, `NOTICE`, and third-party notices for bundled dependencies.
- FR070: MUST enforce a dependency license policy in CI; distributed artifacts contain no strong-copyleft, network-copyleft, source-available, or non-commercial components.
- FR071: MUST define adapters through a versioned, language-neutral, out-of-process protocol with JSON Schema contracts and a public conformance kit; adapters receive captured content and have no operation that executes repository code.
- FR072: MUST NOT advertise an adapter capability as supported until it passes the conformance kit and declares coverage.
- FR073: MUST document governance, contribution with Developer Certificate of Origin sign-off, code of conduct, security disclosure, and release policies in the repository.
- FR074: MUST run untrusted contributions in CI without secrets or release credentials.
- FR075: MUST keep fixtures, benchmarks, and examples free of proprietary code; each fixture records its origin and license.
- FR076: MUST version public contracts (MCP schemas, adapter protocol, bundle format, snapshot file format) with documented compatibility and deprecation policy.

### Ecosystems and build trust

- FR077: MUST support TypeScript and JavaScript (including JSX and TSX), Python, Terraform, and C# with a capability statement per ecosystem, plus the language tiers of amendment A6.
- FR082: MUST implement amendments A1–A14 of ADR-0001 section 10, each with tests.
- FR078: MUST resolve React component render relationships, props passing, hook usage, and context provider and consumer relationships as framework-adapter facts.
- FR079: MUST NOT evaluate build logic (MSBuild evaluation, package restore, analyzers, source generators, `terraform init`, package scripts) for a repository without a recorded trust grant.
- FR080: MUST record the analysis mode in snapshot identity and in the provenance of every fact, and show it in envelopes, exports, and Observatory.
- FR081: MUST allow trust grants and revocations only through the CLI, and record who granted trust and when.
- FR083: MUST make TypeScript interface members (method signatures, and property signatures holding a function type) symbols of kind `method`, qualified `<module>:<Interface>.<member>` as class members are; one symbol per member name, which every overload of it resolves to.
- FR084: MUST resolve a TypeScript call through a value typed as an interface or abstract class to that interface or class member, as the TypeScript checker does.
- FR085: MUST emit TypeScript `implements` (class to interface, from `implements` clauses) and `inherits` (class to class and interface to interface, from `extends` clauses), each cited at the heritage clause's file and line.
- FR086: MUST emit a TypeScript `references` for every non-declaration use of a repository class, interface, enum or type alias, cited at the use's file and line: type annotations, generics, `implements` and `extends`, `satisfies` and `typeof` count; import and export specifiers do not.
- FR087: MUST include by default, in a caller query on a concrete member, the calls that reach it by dispatch: calls resolved to an interface or base member that it implements or overrides through any chain of `implements` and `extends`, each marked `via` the member the call resolved to. Abstract members are not dispatch targets.
- FR088: MUST make `analyze_impact` and `trace_paths` follow dispatch as caller queries do, or say in their limitations where they do not.

## 5. Nonfunctional requirements

- NFR001 Correctness: critical invariants in ADR-0001 are mandatory release gates.
- NFR002 Security: all trust boundaries have explicit positive and negative authorization tests.
- NFR003 Durability: interrupted jobs do not corrupt the previous published snapshot.
- NFR004 Reproducibility: results identify input, toolchain, adapter, and analysis-mode versions; nondeterministic fields are documented.
- NFR005 Performance: publish cold and warm benchmark results, including Observatory frame and interaction budgets, with hardware and fixture descriptions; no invented speedup claims.
- NFR006 Resources: provide configurable worker, memory, disk, query, and output budgets.
- NFR007 Portability: test native installs on the declared operating systems and architectures, and the OCI image on Linux AMD64 and ARM64.
- NFR008 Observability: structured logs and metrics omit source and secrets by default; diagnostic export is explicit.
- NFR009 Maintainability: type checks, lint, contract tests, schema drift checks, and migration checks run in CI.
- NFR010 Test depth: deterministic core targets at least 90% branch coverage; critical validators require mutation testing and explicit failure-path tests.
- NFR011 Availability: publish readiness only after required dependencies and schema are usable; liveness is separate.
- NFR012 Accessibility: CLI offers plain text and JSON; color is optional; every visual has a textual equivalent; Observatory meets WCAG 2.2 AA for its non-canvas interface and supports keyboard-only operation.
- NFR013 License compliance: every release passes the license policy and ships third-party notices.
- NFR014 Contributor experience: a contributor on a supported OS builds and runs every non-container test suite with documented commands and no database server; CI runs the same commands.

## 6. Key entities

Workspace, Repository, TrustGrant, Snapshot, FileVersion, SymbolVersion, ExternalSymbol, RelationshipAssertion, Evidence, Claim, VerificationRun, UnresolvedReference, IndexJob, Approval, MemoryNote, QueryRecord, Aggregate, AdapterManifest, BundleManifest.

Identity rules: paths and line numbers alone are not identities; use content hashes and snapshot-scoped symbol IDs. Cross-snapshot symbol continuity (used by Observatory layout and comparison) is best effort and records its matching method.

## 7. Acceptance and test matrix

| Requirement group | Required test evidence |
|---|---|
| FR001–006 | Discovery fixtures, permission and symlink tests, unsupported-file accounting |
| FR007–015 | Kill and resume tests, branch and config changes, incremental equivalence, unstable-tree tests, sealing fault injection |
| FR016–024 | Reviewed golden facts, ambiguous and external targets, independent resolver comparison, differential traversal tests, traversal budgets |
| FR025–033 | Tampering, stale objects, contradictory evidence, negative claims, offline bundles |
| FR034–041 | Both-transport contract suite and certified-client smoke tests |
| FR042–048 | Approval replay, policy changes, hostile fixtures, execution isolation tests |
| FR049–054 | Clean package and image E2E, release verification, upgrade and restore, retention, privacy checks |
| FR055–068 | Scene-model contract tests, visual regression baselines, browser security suite, accessibility audit, export caveat tests |
| FR069–076 | License gate, notices generation, conformance kit self-tests, fork CI permission tests, fixture provenance check, contract compatibility tests |
| FR077–081 | Per-ecosystem golden fixtures, React framework fixtures, trust-grant authorization tests, analysis-mode propagation tests, no-execution sentinel tests |
| NFR001–014 | Invariant suite, security suite, benchmarks, type, coverage and mutation gates, diagnostics checks, contributor setup check |

## 8. Success criteria

- SC001: All inventoried files have a disposition; all unresolved coverage is inspectable.
- SC002: Every structured published finding includes valid evidence references or is explicitly unverified.
- SC003: Reviewed fixture relationships are recovered without unexplained extra resolved relationships.
- SC004: Incremental and clean equivalence passes for edit, rename, delete, branch, configuration, dependency, and analysis-mode transitions.
- SC005: Both MCP transports complete the same core scenario.
- SC006: Certified Claude Code and Codex combinations complete the same snapshot-based investigation.
- SC007: Tampered, missing, stale, or out-of-scope evidence cannot receive a current supported verdict.
- SC008: Interrupted indexing preserves prior published queryability.
- SC009: Offline integrity verification succeeds for valid bundles and fails for altered bundles.
- SC010: Every MUST maps to an automated test or an approved documented manual release check.
- SC011: On reviewed fixtures, every Observatory view and export renders the truncation, unresolved boundaries, and incomplete coverage present in its data.
- SC012: Malicious-content fixtures produce no script execution or markup injection in Observatory.
- SC013: Every Observatory view has a non-visual equivalent that passes the accessibility checklist.
- SC014: Every first-party adapter runs only through the public protocol and passes the public conformance kit.
- SC015: Without a trust grant, a sentinel fixture whose build logic would write a marker file indexes without the marker appearing.
- SC016: Release artifacts pass the license policy, carry signatures, SBOM, and provenance, and build from a public tag of the fresh-history repository.

Latency and repository-size promises are intentionally not invented. Benchmark milestones set hardware-specific performance budgets before a public release candidate.

## 9. Edge cases

Continuous edits; missing Git metadata; nested repositories; symlinks; case-sensitive and case-insensitive paths; Unicode, including multi-byte characters before symbols; CRLF; generated files; compiler configuration inheritance; missing dependencies; huge source files; unreadable files; disk full, including during sealing; unavailable or corrupted snapshot file; malformed evidence; duplicate symbol names; dynamic registration; expired cursors; canceled requests; unsupported client features; deleted historical evidence; adapters producing conflicting facts; adapter crash, hang, or protocol version mismatch; concurrent CLI and server processes on one data directory; filesystems without copy-on-write clones; WebGL unavailable; very high fan-in hubs in views; identifiers or source with bidirectional or invisible characters; extremely long names and paths; reused or leaked browser session tokens; a trust grant revoked while an index runs; Terraform modules that are not present locally; Python environments without installed packages.

Each must produce a tested result or an explicit unsupported limitation, never silent success.

## 10. Scope and readiness checklist

- [ ] Maintainer approves launch ecosystems and working names.
- [ ] ADR approved beyond M0 and exact dependency versions and licenses reviewed.
- [ ] Canonical Spec Kit artifacts materialized in the repository and cross-checked.
- [ ] Executable JSON Schema contracts replace illustrative examples.
- [ ] Python semantic-engine spike and Galaxy rendering spike recorded in `research.md`.
- [ ] Benchmark budgets agreed before release candidate.
- [ ] Client version matrix completed.
- [ ] All P1 scenarios independently pass.
- [ ] Predecessor golden questions pass on Proofmesh with the private overlay before the old tool is removed.
- [ ] Publication gate passed: fresh-history export, leak scan, manual review, ownership confirmation, name clearance.
- [ ] Execution features remain disabled until P2 security gates pass.
- [ ] Shared hosting remains unsupported until its own ADR and tests pass.
