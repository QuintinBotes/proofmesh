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
- FR107: MUST recognise test code for `find_tests` by path and project naming, and by symbol roles (FR191 to FR194), and say so in every answer, a lean answer through the tool's description.

### Test recognition

- FR191: MUST recognise test files by the conventions of each language, listed in `docs/proofmesh/languages.md`: Go `_test.go` only, Python `test_*.py`, `*_test.py` and `conftest.py`, Java and Kotlin `src/test/`, PHP `*Test.php`, Ruby `_spec.rb` and `_test.rb`, C and C++ `*_test.*` and `*_unittest.*`, Swift `Tests/`, and the TypeScript and C# patterns it already recognised. A Go directory named `test` that holds production code is not test code.
- FR192: MUST recognise test entry points by their markers, from syntax alone: Go `Test`, `Benchmark`, `Fuzz` and `Example` functions with their testing parameter; Rust `#[test]` and `#[tokio::test]`; JUnit and Kotlin `@Test`, also an annotation imported under another name; pytest `test_` functions and `unittest.TestCase` methods; PHPUnit `test*` methods, `@test` and `#[Test]`; RSpec and Minitest blocks and methods; googletest `TEST`, `TEST_F` and `TEST_P`; XCTest `test*` methods; xUnit, NUnit and MSTest attributes in C#.
- FR193: MUST let a symbol carry an optional `roles` list of `test` and `test_support`, as adapter protocol 1.1 (an optional field, A22) and an additive snapshot column (format 0.9); a symbol with none has none, and an adapter that sends none is valid.
- FR194: MUST decide `include_tests`, `find_tests`, test reach and `impact_completeness` per symbol, by its file's convention, its project and its roles, not by its file alone, so that in a source file with a `#[cfg(test)]` module the production symbol is not test code and the module's members are.
- FR195: MUST list as a test, in a file whose adapter sent roles, only a symbol with the role `test`, so a helper in a test file is not listed, and a test that calls a helper reaches the helper's callee through it; in any other file every symbol in test code is a test as before.
- FR196: MUST give the role `test_support` to test code that is no entry point by its scope: the members of a Rust `#[cfg(test)]` module, a class that holds a test or extends a test case, and the other members of such a class.
- FR197: MUST name a test block that declares no name by its call and its first string argument (`it "adds"`), and a googletest macro as written (`TEST(Calc, Adds)`).
- FR198: MUST match an annotation imported under another name through the import, and MUST NOT take one imported from outside the known test frameworks for a test annotation.
- FR199: MUST say in a `find_tests` answer, as a limitation, that calls in a language are not resolved yet when the subject's file has no resolved calls, and list no test as executing it, unless candidate calls of that language were followed (FR205).
- FR200: MUST list the conventions and markers of FR191 and FR192 and the roles of FR193 in `docs/proofmesh/languages.md`, and declare `roles` in the adapter protocol schema.

### Reach through candidate edges

- FR201: MUST accept `include_inferred` (`true`, `false` or `"auto"`, default `"auto"`) on `analyze_impact`, `find_tests`, `trace_paths` and `impact_completeness`. Auto is true when every subject's file was analysed by the syntax tier alone (`capabilities.tier` is `syntax`) and false otherwise, whether a precise adapter, a SCIP index or no recorded tier analysed it; for `impact_completeness` each changed symbol is a subject, and for `trace_paths` the source and the target are. The decision is made once, from the subjects: once on, the walk follows candidate sites in every file it reaches, a precise-tier file included, and the answer says so.
- FR202: MUST, when following, walk a `candidate` site and an `ambiguous` site that lists at most five candidates as edges (calls, inherits and implements for impact and completeness; calls for test reach and paths), read from `assertion_candidate` so the `edge` table and the snapshot format are unchanged, label every row reached through one `inferred`, and never follow an ambiguous site whose candidates were capped (`detail.more` present).
- FR203: MUST give `analyze_impact` on a function whose callers the syntax tier bound as candidates those callers as dependents at their depth with `basis` `inferred`, `totals.by_basis` counting them, and none with `include_inferred` false.
- FR204: MUST leave every answer for a subject in a file a precise adapter or a SCIP index analysed, or that records no tier, byte-identical (data and limitations) with the default input, including where candidate sites exist and where a walk from it meets a syntax-tier file through an observed edge; the count of candidate sites not followed is given only when `include_inferred` is `false` in the input.
- FR205: MUST give `find_tests` the tests that reach the subject through candidate calls as `call` or `transitive_call` rows with `basis` `inferred`, counted as executing, and MUST then not say that calls in a language are not resolved yet for a subject that has candidate call sites of its own (FR199 holds with `include_inferred` false, and for a subject with none).
- FR206: MUST give `trace_paths` the paths through candidate calls, each hop with its `basis` and the path `inferred`, and conclude `path_found`; with `include_inferred` false it concludes `no_resolved_path` and lists the candidate sites as boundaries (FR022). A site the walk followed is no boundary; one it never follows for its cap still is.
- FR207: MUST give `impact_completeness` dependents reached through candidate calls with `basis` `inferred`, count them in `totals.by_basis`, and end the lean summary with `; <n> inferred` when there are any and with nothing otherwise.
- FR208: MUST follow an ambiguous site of two to five candidates to all of them, each node it reaches inferred, and never a site of more than five, saying how many it stopped at.
- FR209: MUST say in `limitations` that candidate edges were followed and why (`include_inferred` was true, or the subject's file has no precise tier), how many sites it stopped at for their cap, or, when `include_inferred` is `false` in the input, how many candidate sites naming code on its paths it did not follow; and MUST say nothing otherwise.
- FR210: MUST keep FR184: a row an observed chain and an inferred one both reach is `observed` at its shortest observed depth, and an inferred chain never makes an observed row; the node budget counts inferred nodes like any other and is checked as each row is reached, so a hub with more callers than the budget stops at it.

### The Rosetta suite

- FR211: MUST hold one Rosetta fixture per supported language (TypeScript, Python, C#, Go, Java, Rust, PHP, Ruby, Kotlin and C++) under `fixtures/rosetta/<language>/repo/`, project-authored and described in a `PROVENANCE.md`, with one hand-written `expected.json` per language that holds a section for each tier that analyses it, and one `contract.json` naming the eight calls and the rows a complete answer has.
- FR212: MUST write each program in its language's idiom: `Shape` with `area`, `Circle` and `Square` filling it, `total` calling `s.area()` through `Shape`, `circleArea` calling `Circle(1).area()` directly, a `report` file importing the shapes file, and a test of two shapes that calls `total`.
- FR213: MUST have one contract test (`packages/proofmesh/test/rosetta.test.ts`) ask every language the same eight calls (`find_symbols` for `area`, the implementers of `Shape`, the callers of `Shape.area` and of `Circle.area`, the importers of the shapes file, `analyze_impact` on `Circle.area` to depth 2, `find_tests` on `total`, `trace_paths` from the test to `Shape.area`) and compare each answer's lean rows with the section of the language's `expected.json` for the tier that analysed it, a path's hops in order and every other answer as a set, since ties follow ids; a language with no section for its tier fails.
- FR214: MUST give, in the precise tiers (TypeScript, Python, C#), only rows with `basis` `observed`, and the callers of `Circle.area` as `circleArea` (direct) and `total` (dispatch through `Shape.area`); TypeScript, Python and C# all do, and a row a precise tier does not give is stated, not skipped.
- FR215: MUST give, in the syntax tier, only relationship rows with `basis` `inferred`, and MUST list each row of the contract its tier cannot give under `not_at_tier` with the reason, so that no row is missing without being stated and no row beyond the contract appears without an `extra` and its reason or a `known_defect` naming the tool defect; a call whose subject the tier cannot name is expected to fail with the error code the file states.
- FR216: MUST give every language's answers the same lean form: the one header, the grammar of each call (`name path:line`, then only the tags the contract lists for that call, `inferred` among them), the same field names in the full envelope, impact rows nearest first and a path's hops from the test to the target.
- FR217: MUST make a stated gap a promise: an answer that gives a row its file lists as not given, or lacks one it gives, fails the test until the file changes; every gap names a reason, and the support table in `docs/proofmesh/languages.md` is the one the expected files give.
- FR218: MUST provide `pnpm check:languages` (`scripts/check-languages.mjs`), which fails when a language `docs/proofmesh/languages.md` lists as supported for a tier has no section for that tier in `fixtures/rosetta/<language>/expected.json`, when a section is not listed, when a section does not account for every row of the contract, or when the table is not the one the files give.
- FR219: MUST run the contract test in `pnpm test` (the C# program included, through the C# adapter) and `pnpm check:languages` in `pnpm verify`.
- FR220: MUST record in `fixtures/rosetta/PROVENANCE.md` how the expected files were made (by hand, never generated by the code under test) and that a change to a row is made in the pull request of the slice whose behaviour changed it, naming the slice.
- FR224: MUST record, for Python, an `overrides` relationship from a method to the method of the same name it overrides, found through the class's resolved bases and cited at the method's name: a base that declares the name stops its branch, so a chain links one level at a time and a class with several bases links one row for each base that declares it; a method that overrides nothing, a static method, a property, and a base outside the repository give no row. A call through the base is then a dispatch caller of the overriding method, in callers and in impact, as for TypeScript and C#.

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
- FR117: MUST leave every syntax-tier `imports`, `inherits` and `implements` row unresolved with reason `outside_capability` and no target, except where constrained resolution binds it (FR171 to FR177); binding them belongs to constrained resolution (FR023).
- FR118: MUST state in `docs/proofmesh/languages.md`, per syntax-tier language, which of imports, heritage and calls the tier records.
- FR221: MUST record, in the syntax tier, one `imports` row per import statement in Kotlin (`import`, with a wildcard in `detail.module` and an `as` alias in `detail.alias`), Rust (`use`, also inside a function body, at its own line, a grouped `use` with the path as `detail.module` and the text between its braces as `detail.names`, an `as` alias in `detail.alias`; and `mod x;` as module `x`), PHP (one row per `use` clause, a group with its prefix as `detail.module` and its clauses as `detail.names`) and Ruby (`require` and `require_relative` of a string), each from the file at the statement; a file the grammar parses in part keeps the rows of the parsed part and reports syntax partial.
- FR222: MUST record, in the syntax tier, heritage rows from the declaring type at the supertype's name, with that name in `detail.name`: in Kotlin an `inherits` for each supertype, with `detail.relation` `supertype` except the one a constructor call names; in Rust an `implements` for `impl Trait for Type` (from `Type` when the file declares it, else from the file's module with the type in `detail.for`) and an `inherits` for each trait bound of a trait; in PHP an `inherits` for what a class or interface extends and an `implements` for each interface of a class; in Ruby an `inherits` for a class's superclass and an `inherits` with `detail.relation` `include` for each module an `include` names inside a class or module.
- FR223: MUST state in `docs/proofmesh/languages.md` what the tier records of imports, heritage and calls for Kotlin, Rust, PHP and Ruby.

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

- FR151: MUST declare, from each `pom.xml` read as text with a bounded XML reader that expands no entity and runs nothing, one `project` symbol named `groupId:artifactId` (the group inherited from its `parent` when the pom states none) at the line of its `artifactId`; a pom with no artifactId or no group declares none, and a pom or a Gradle file under `testdata` or `vendor` declares nothing.
- FR152: MUST record, for each `<module>` a pom lists that has no `pom.xml` on disk (a module path is read from the pom's directory, or names the pom file), an `unresolved` `depends_on` with reason `dependency_missing` and the module as written in `detail.module`, at the module's line.
- FR153: MUST record each `dependency` of a pom (not those of `dependencyManagement` or a profile) as a `resolved` `depends_on` to the project of that `groupId:artifactId` when the repository declares one (`ambiguous` with every candidate when two do), and otherwise as a `resolved_external` `depends_on_package` named `maven:<groupId>:<artifactId>` with `detail.version`; `${...}` in a group, artifact or version is resolved from `project.*` and the literal properties of the pom and its parents, and a version with no declaration takes the `dependencyManagement` version of the pom or its parents. A `${...}` that cycles, or expands past 4 KiB or 256 substitutions, is left as written and its file reports `partial` (with a diagnostic); names of `Object.prototype` are not properties. A version left as a `${...}` is recorded as `detail.version_expression`, and a group or artifact that cannot be read is an `unresolved` `depends_on_package` with reason `dynamic_specifier`, never dropped and never guessed, and its file reports `partial` symbols.
- FR154: MUST declare, from each `settings.gradle` and `settings.gradle.kts`, one `project` symbol per `include` path, named by that path with a leading `:` (`:app`, `:a:b`), at the line of the include and once however often it is listed, and only when the include is a statement of the script (one inside a block, a closure or after a condition declares nothing); `includeBuild`, `includeFlat`, a computed `include` argument, a `projectDir` assignment and `apply from` are not read and make the file report `partial`. The root project is not declared.
- FR155: MUST read, from the `dependencies` block of the `build.gradle` or `build.gradle.kts` of a declared project, the declarative forms `implementation`, `api`, `compileOnly`, `runtimeOnly`, their test and processor variants with a string coordinate (also the Groovy map form and `platform(...)`), `project(":x")` and a version-catalog alias (`libs.x`, `libs.bundles.x`) resolved from `gradle/libs.versions.toml`: a project is a `depends_on` (`resolved` when its settings include it, `unresolved` with `dependency_missing` when not), a coordinate is `maven:<group>:<artifact>` with `detail.version` when given. Every Gradle fact carries `detail.inferred` of `gradle_script_pattern`, because a Gradle script is code.
- FR156: MUST name a Gradle dependency statement it cannot read (a variable, an interpolated coordinate, a call, an alias the catalog does not give) as an `unresolved` `depends_on_package` with reason `dynamic_specifier` and `detail.configuration` and `detail.source`, at its line, and MUST report that build file as `partial` symbols so the language census says the Gradle graph is partial. A statement in an `allprojects` or `subprojects` block, a comment or a string is not read as a dependency of the project, and a build script that no settings `include` owns is reported `partial` with a diagnostic, not skipped silently.
- FR157: MUST record `contains` from each Maven module and Gradle project to the module symbol of every source file under its directory, from the nearest one (a Gradle project's directory is its include path under the settings file's directory).
- FR158: MUST NOT start Maven, Gradle, a JVM or any process, and MUST NOT evaluate a build file: a plugin, task or top-level statement that would write a marker if run leaves none (FR079).
- FR159: MUST fail a `pom.xml` that is not well-formed (including a character reference to no XML character, and nesting past 200 levels), and a Gradle script with a comment that is never closed, with a disposition detail `invalid_xml` or `invalid_gradle` naming the line, and still read every other build file.
- FR160: MUST give a Gradle script in Kotlin (`settings.gradle.kts`, `build.gradle.kts`) to the build adapter as a manifest rather than to the syntax tier as Kotlin source, and MUST answer every JVM build fact on each index, so that an incremental index equals a clean one (FR014).

### Symbol identity

- FR130: MUST record in every new snapshot, for every symbol and whatever adapter or tier declared it, `body_hash`: the SHA-256, in 64 lowercase hex characters, of the declaration's span as the snapshot records it, with line endings read as LF, the lines' common leading indentation and every line's trailing whitespace removed, and the symbol's own simple name replaced by one fixed placeholder wherever it is a whole identifier that is not a member access (`.name`), so `get` and `set` methods that differ only by name and the member they call stay apart. A module's hash is that of its file's text, with no name masked. A symbol whose span is no more than its name has a null `body_hash`, and so does one whose file content was unavailable at seal time; the snapshot records those files in its meta. The snapshot format gains the column additively (0.7), and the hash is computed at seal time in the core.
- FR131: MUST return `stable_key` and `body_hash` from `get_symbol`, in the lean row as well.
- FR132: MUST report `body` among a changed symbol's change kinds in `compare_snapshots` when its `body_hash` differs between the snapshots, and MUST return the id, `stable_key` and `body_hash` of both sides of every changed symbol. A module's text change is the file's, listed under `files.changed`, not a symbol change.
- FR133: MUST pair, in `compare_snapshots`, exactly one removed and exactly one added symbol of the same kind and `body_hash` as `moved` (the path or the container differs), `renamed` (the name differs) or `moved_renamed` (both), with both ids, both keys and the shared hash, only when the normalised text is at least 10 tokens (words, numbers and each other non-space character): a smaller match is not paired, not listed as ambiguous, and counted in `counts.too_small` with a limitation, and MUST leave a paired symbol out of the added and removed lists. A module is `moved` whatever its file is now called.
- FR134: MUST report any other match of removed and added symbols of one kind and `body_hash` (several on either side) as one `ambiguous` entry listing every candidate, and MUST leave those symbols in the added and removed lists. A symbol with a null hash is never paired.
- FR135: MUST answer a snapshot sealed before hashes existed with a null `body_hash` and a limitation saying to index again, from `get_symbol` and from `compare_snapshots` (which then pairs nothing and reports no body change), and MUST NOT compute a hash at query time from another reading of the span. A snapshot that recorded unreadable files names them in a limitation of `get_symbol` and `compare_snapshots`.

### Stable symbol keys

- FR146: MUST name every declaration, in every tier, by the qualified name of its language: for C#, Java, Kotlin, Scala and PHP the fully qualified name from the package or namespace the source declares at that point (Scala's nested and chained package clauses and PHP's several namespaces are each declaration's own; none declared, none prefixed; PHP separators are dots), and for every other language `<path without extension>:<containers>.<name>` (`go/cart:Cart.Checkout`). A member is named under its container: a Go receiver type (pointer or value alike), a Rust `impl` target and, for a trait impl, the trait after it (`X.<Display>.fmt`), a C++ class of an out-of-class definition (`A::f` is `A.f`). A Go `type X struct` is a `struct`, a `type X interface` an `interface` and only `type X = Y` a `type_alias`. A C or C++ prototype and the definition with the same parameter types in the same file are one symbol, declared at the definition (a prototype in another file stays its own symbol). A Python property is its getter, and its setter and deleter take their parameters as a suffix (`C.x(value)`); all three have kind `property`. Declarations of one callable name in a file take a `(<parameter types>)` suffix read from their declaration text with whitespace collapsed: a default value is no part of a type, varargs keep their dots, qualifiers (`const`) and pointer or reference marks stay, and Go's `a, b int` is two.
- FR147: MUST keep `stable_key` unique in a snapshot, whatever adapter wrote it: symbols that still share a key are told apart by `~` and eight hex characters of the hash of their declaration text, so a duplicate inserted above an existing one renames none; identical text, or a key an earlier batch wrote, takes `.2`, `.3` in source order (never a nested suffix), and the snapshot records every base key and its final key in its meta (`key_disambiguated`). The snapshot format gains a unique index on `stable_key` (0.8).
- FR148: MUST have the SCIP importer name each definition, give it its kind and take its span from the syntax tier's declaration of the same symbol, so that naming an index changes no key and no `body_hash`; a definition the syntax tier does not declare takes the name of its language's form from the index's own descriptors.
- FR149: MUST accept `key` (a `stable_key`) as the subject of `get_symbol`, `get_relationships`, `analyze_impact`, `find_tests` and `get_memory`, and `source_key` and `target_key` in `trace_paths`, answering as for the symbol's id; an unknown key is `NOT_FOUND` naming it, and a key given together with an id or a path is `INVALID_ARGUMENT`.
- FR150: MUST report a note reference that matches several symbols (the name as given, or else each overload of it) under `ambiguous_refs` with every matching key, and then `staleness` `ambiguous`; and MUST report `tier_changed`, not `changed`, when a referenced file's tier changed and its content did not, the fingerprint recording each referenced file's content and tier. A reference that matches nothing says, once, that qualified names changed with snapshot format 0.8 and is to be rewritten (accepted notes are not migrated).

### SCIP calls, inheritance and imports

- FR161: MUST have the SCIP importer record a `calls` (`resolved` or `resolved_external`, origin `semantic_resolver`, evidence at the callee name) where a call site the syntax tier read has, at its callee name, a reference occurrence of a function, method or constructor symbol, and a `references` for every other reference occurrence; a call is recorded once, never also as a reference. A function passed as a value is a reference. A callee that is a local variable, or a field or variable that holds a function, is no call. A callee symbol defined outside the repository is `resolved_external`, with the package from the SCIP symbol.
- FR162: MUST read SCIP's `is_implementation` relationships into `overrides` (a member to a member), `implements` (a type to an interface or trait) and `inherits` (a type to any other type), `resolved` when the target is a definition in the repository, `resolved_external` when it is outside it. A target outside the repository is an `implements` when the index records its kind as an interface or trait, and otherwise an `inherits`, which carries `detail.kind` `unknown` when the index records no kind for it. Another relationship flag records nothing.
- FR163: MUST record each import statement the syntax tier read as an `imports` from the file, resolved through the index's occurrence of the package, namespace or type the statement names: `resolved` to the file that holds the package's lowest-path definition (or the type's definition), `resolved_external` to `<ecosystem>:<package>` (Go's standard library is `go:std`), or `unresolved` with `import_unresolved` and the module as written when the index has no occurrence inside the statement. An occurrence inside an import statement stays a `references` row as before; the import is recorded in addition. The file's `imports` capability is `complete` when every statement was matched, `partial` otherwise, and `unsupported` where the syntax tier reads no imports.
- FR164: MUST read an index one document at a time: the file in chunks, one decoded document at once, and of each routed document only its definitions and the symbol information of those definitions kept (the rest is read again from the file when the document is analysed), so that memory grows with the number of definitions and not with the size of the index. `proofmesh scip add` reads the index the same way. A message whose length exceeds the bytes left in the file (or 2^53) is refused, as truncated or corrupt at its offset, before any buffer is made for it. A document read again by its offset is refused when the index file's size or modification time changed since it was read, or when the document there is not the one recorded, and its file then fails with `scip_index_changed`. An index whose bytes no longer hash to the recorded value, a truncated one, and one with a document before its metadata are refused with their reason.
- FR165: MUST keep the stable key and the `body_hash` of every symbol the syntax tier declares unchanged by naming an index, with calls, inheritance and imports recorded (FR148).
- FR166: MUST record no `calls` for a call site with no occurrence at its callee name (a stale index, another position encoding), and report the file's `resolved_calls` capability `partial`, with the count of such sites in the adapter's warning for the file; every site matched makes it `complete`.
- FR167: MUST take, where a call site's callee name holds several occurrences (a definition and a reference for a method value, or a reference to a field as well), the reference to a function, method or constructor symbol.
- FR168: MUST record a call whose callee is a type as a call to that type's constructor symbol where the index defines one, else to the type.
- FR169: MUST make `analyze_impact`, `get_relationships` and `find_tests` follow these observed edges as they follow any others: the callers of a function reached through `calls`, and the callers of an interface member reach its implementations through `overrides`.
- FR170: MUST report `resolved_calls` and `imports` `unsupported` for a SCIP file in a language the syntax tier lacks, and when the syntax tier cannot be reached (not found, crashed) with a warning naming why, and MUST keep that file's symbols and references either way. The syntax tier is asked for call sites in batches of 20 files, each with its own 15 s, and the importer reports progress between batches; the files of a batch it does not answer in time have `resolved_calls` and `imports` `partial`, with a warning naming `syntax_tier_timeout`, so that a later index reads them again.

### Constrained name matching, Go and Java

- FR171: MUST bind, for Go and Java, a call, a supertype name and an import the syntax tier read to targets by name only within the scope the language's rules allow (the module and the modules it declares a dependency on, the file's imports and package, visibility), and MUST record each such row as `candidate` (one target) or `ambiguous` (several), never `resolved`, with the rule in `detail.rule`, so that no edge is made of it and the row reads as inferred (FR181). A row no rule binds keeps the row the syntax tier wrote.
- FR172: MUST bind no row to a target in a build module the source's module has no direct, resolved `depends_on` to, for the source's own scope: a dependency of the test scope is seen by test sources only, one of the runtime scope by none, and a transitive dependency by none. A name that only such a module holds, named by an import, a qualified type or a package qualifier, is `unresolved` with `dependency_missing`, `detail.undeclared` naming the project (as the build graph names it) and `detail.packages` the same, and no candidate. The build adapter records `detail.scope` `test` or `runtime` on a `depends_on` that has one.
- FR173: MUST apply Go's rules: a qualified call `pkg.Name` binds only an exported function of the package its import names (by alias, else by the package's own name) with rule `go_package_member`, and an unexported or missing name is `unresolved` `unknown_name` with `detail.visibility` `unexported` (or `exported`); a bare call binds a function of the same package and directory (`go_same_package`) or an exported function of a dot import (`go_dot_import`); a blank import binds nothing; a local variable or parameter of the name hides the function or package (`unknown_name` with `detail.shadowed` `local` for a bare name; a qualifier it hides binds nothing); an embedded type binds as a type of its package or of an imported one (`go_same_package`, `go_package_member`); an `internal` package is reachable only from code rooted at the parent of its `internal` directory (otherwise `import_unresolved` and `unknown_name` with `detail.visibility` `internal`), and a `vendor` or `testdata` directory, or one starting with `.` or `_`, holds no package. A call into a package outside the repository, and a call on a receiver whose type the tier cannot know, keep their row.
- FR174: MUST apply Java's rules: a simple type name binds a type of the same file (`java_same_file`), else a single-type import, also of a type outside the repository, which binds nothing there and hides a same-package type of that name (`java_import`), else a type of the same package (`java_same_package`), else a type of a wildcard import's package (`java_wildcard_import`); a member is reachable by its modifier (`private` within the top-level class, package-private within the package, `protected` in the package or by inheritance, `public`, and an interface member without `private` is public); `T.m()` binds the methods named `m` of the type `T` names and of its supertypes together (`java_inherited` when only inherited), and an unknown method of a known type is `unknown_name`; a bare or `this` call binds the innermost enclosing type that has the method (`java_same_class`), else a static import (`java_static_import`), and when a supertype is not in the repository its result is `ambiguous` even with one candidate and it never reaches the static imports; a call on a receiver of unknown type, or on a name a local variable, parameter or field hides, binds to nothing; `extends` binds a class and `implements` an interface; a name no rule finds in the repository (the JDK's, a library's) keeps its row.
- FR175: MUST never bind a member name as a type or a type name as a member: `new T()` is a call whose only candidates are the types named `T`, and a method call's only candidates are methods.
- FR176: MUST list at most five candidates for a site, ranked by the rule that found each (same file, import, same package, wildcard, then path and position); a site with more is `ambiguous` with the first five and `detail.more` the count of the rest, and a site with two to five is `ambiguous` with all of them.
- FR177: MUST record a Go import whose path lies inside a module of the repository the importing module declares a dependency on as a `candidate` (`ambiguous` when the package has several files) of the module symbols of the package's non-test files, with rule `go_import_path`, `detail.package` the directory and `detail.files` the count, because an import links files and a package is a directory; a file a `//go:build ignore` constraint excludes is no part of the package, and a directory with several package names none of them a test package is not judged. MUST record a Java import by name as a `candidate` of the type it names (`java_import`), or of a static member (`java_static_import`). An import of a path or type outside the repository keeps its row.
- FR178: MUST list in `workspace_status` `data.module_cycles` each cycle among the build modules of an ecosystem whose builds forbid module cycles (Maven, Gradle, Go modules, Cargo, .NET) that resolved, candidate and ambiguous syntax-tier rows form, with its modules and the edges that form it (type, count of sites, and the path and line of one), and one warning in `limitations` naming them; empty when there is none.
- FR179: MUST state in `docs/proofmesh/languages.md` each rule of FR173 and FR174 by name, the cap of FR176, the dependency scopes of FR172 and `module_cycles`.
- FR180: MUST bind names on every index from the per-file facts the syntax tier answered, cached or not, and the whole workspace's module graph, so that an incremental index equals a clean one (FR014), and MUST make the rules' version part of a snapshot's identity, a test failing when the sources of the rules change without a new version.

### Relationship basis

- FR181: MUST give every relationship row of `get_relationships` a `basis` of `observed` or `inferred`, derived when the answer is built: `inferred` when the resolution is `candidate` or `ambiguous`, the origin is `contract_match`, `documentation` or `model_hypothesis`, or `detail.inferred` is present; `observed` otherwise. A deterministic same-file syntax fact is observed. An unresolved boundary is no relationship and has no `basis`.
- FR182: MUST give every dependent of `analyze_impact` and `impact_completeness` (and the nearest test of a changed symbol or dependent) a `basis`.
- FR183: MUST give every test of `find_tests` a `basis`, every hop of `trace_paths` its own `basis` in `relationships`, and every path a `basis` that is `inferred` when any hop is.
- FR184: MUST label a row reached through a chain `inferred` if any hop of its strongest chain is inferred, the strongest chain being the shortest all-observed chain where one exists, so a row reached by an observed and an inferred chain is `observed`, and `analyze_impact` gives its depth as that of its shortest observed chain.
- FR185: MUST give `totals.by_basis` (`observed`, `inferred`) in `get_relationships`, `analyze_impact`, `find_tests` and `impact_completeness`, counting every matching row before row and byte limits, and counting no unresolved boundary.
- FR186: MUST end a lean row with the token `inferred` when it is inferred, and change no observed lean row.
- FR187: MUST NOT let any rule produce a `resolved` executable relationship from a name match alone (FR023 is unchanged).
- FR188: MUST replace the `detail.inferred` `name_match` and `package_directory` marks that constrained name matching (FR171, FR177) wrote as a stand-in for the basis: a bound row carries its `detail.rule` and reads as inferred through its `candidate` or `ambiguous` resolution.
- FR189: MUST treat `resolved_external` rows as observed, and leave runtime observations (A9, A30) shown apart, as before, without changing a `basis`.
- FR190: MUST derive `basis` from facts the snapshot already holds, so the snapshot format and the adapter protocol are unchanged, and MUST declare it in the data schema of each tool of FR181 to FR185 and describe it in `docs/proofmesh/mcp.md`.

### Language census

- FR136: MUST classify every discovered file into exactly one language, or `unknown` with its extension (or its whole name when it has none), and one kind (`code`, `template`, `data` or `prose`; the rows of binary files and of unknown languages carry the kinds `binary` and `unknown`), with no configuration. Detection uses the file name, the longest known extension, the shebang of a file with no extension, and a content check for `.h` (C++ or Objective-C when the text says so, else C); an extension several languages share that no check settles is `unknown`, never a guess. The content check reads code, not comments or string literals, and an Objective-C header is its own language, not C. Only a short final suffix of letters and digits is an extension: extensionless files share one `(no extension)` row and implausible suffixes one `(other)` row. A language has one kind whichever of its files is looked at. Language names, kinds and detection data follow GitHub Linguist's `languages.yml`, vendored as a trimmed table with its MIT notice in `THIRD_PARTY_NOTICES.md`.
- FR137: MUST record on each indexed source file the tier that produced its facts (`precise:<adapter>`, `scip:<index>` or `syntax`) as the additive `tier` key of the file's capabilities, which no snapshot-wide capability counts. A file only captured (configuration, ownership, a service registry) has no tier.
- FR138: MUST return from `workspace_status` the language census `languages`: one row per language (per extension for `unknown`) in the order kind (`code`, `template`, `data`, `prose`, then `unknown` and `binary`), file count descending, name, with `files`, `dispositions`, `excluded` (files left out by rule, by rule), `tier` and `tiers` (each tier that read files of the row, with its file count; two tiers in one language show both), `capabilities` (for `symbols`, `imports`, `references` and `resolved_calls`, the count of the row's files at each level, each capability summing to `files`), `reason` and `remedy`. Every file is in exactly one row; past 64 rows the smallest are summed into a last `other` row. The census version is part of the manifest hash of a snapshot, so a snapshot sealed before it is stale under strict freshness. A repository with no recognised code answers data and prose rows and a limitation saying so. A snapshot sealed before the census answers no rows and a limitation saying to index again.
- FR139: MUST route a file whose language only its shebang or content gives (an extensionless script, a `.h` holding C++) to that language's syntax-tier grammar, so that an extensionless bash script is Shell and its functions are symbols.
- FR140: MUST take every remedy from one table of language to precise route (built-in adapter, SDK and build, SCIP indexer), advice only: the census runs nothing and installs nothing. It gives the indexer's real command where it is certain (and says when it needs a `compile_commands.json`) and the tool's README where it is not, always for a repository the person trusts; a mistyped `PROOFMESH_CS_ADAPTER` is named as such. `docs/proofmesh/languages.md` MUST show the same table. A stale SCIP index is the reason `scip_stale:<index>` and its remedy says to produce the index again and name it again; a C# adapter that is not present names the .NET 10 SDK and `dotnet build adapters/csharp -c Release`.
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
