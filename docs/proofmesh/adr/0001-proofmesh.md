# Proofmesh — Architecture Decision Record

- Document: ADR-0001
- Status: Proposed, revision 4; requires maintainer approval before implementation beyond milestone M0
- Date: 2026-11-07 (revision 1: 2026-11-06; see section 9)
- Decision scope: Open-source licensing and governance, runtime, storage, indexing, adapters and build trust, MCP, visualization, verification, distribution, migration from the predecessor, testing
- Companion documents: `02-proofmesh-spec.md`, `03-proofmesh-architecture-plan.md`, `04-proofmesh-m0-walking-skeleton.md`
- Product name: Proofmesh — “A code graph that shows its work.” Visual interface: Proofmesh Observatory.
- Naming status: Working names; trademark, domain, package, and repository availability not checked.

## 1. Context

A coding agent investigating a large repository with an existing code-graph tool reportedly hit a graph-size cap, built smaller scoped graphs, and supplemented them with file reads. This is a motivating observation supplied by the project owner, not an independently reproduced defect or a claim about any particular tool.

Scoped graphs and file reads can both produce valid findings. The failure to prevent is a completeness mismatch: an answer makes a repository-wide assertion while its evidence covers only part of the repository or only certain relationship mechanisms.

Proofmesh grows out of a private predecessor that indexes a large private C# codebase with Roslyn into a local SQLite file and answers agent questions over MCP. Proofmesh generalizes it into a free, open-source, self-hostable tool under Apache-2.0. It runs on a developer's own machine with no account, no database server, and no remote model. It exposes a client-neutral MCP interface and a CLI, and it ships Observatory, a local visual interface that draws the graph together with its coverage gaps, limits, and evidence. Claude Code and Codex are certification targets; every other MCP client receives an honest, recorded compatibility status.

The first public release covers TypeScript and JavaScript (with React), Python, Terraform, and C#.

The system needs persistence, bounded retrieval, semantic relationships, reproducible evidence, explicit uncertainty, explicit trust for any analysis that executes build logic, a visual surface that never overstates the evidence, and comprehensive tests. A larger context window or an additional agent is not a substitute for these requirements.

## 2. Decision drivers

1. Evidence integrity and honest coverage outrank answer fluency and visual polish.
2. Large repositories must be indexable without constructing a complete in-memory graph.
3. Queries and views must expose truncation, unresolved relationships, scope, and freshness.
4. Structural facts, semantic resolution, documentation, inference, and runtime observation must remain distinct, in data and on screen.
5. The product must be usable without a model API, cloud account, remote embedding service, database server, or container runtime.
6. Read operations must never execute repository code, and indexing executes build logic only under an explicit, recorded trust grant.
7. Releases must be reproducible and verifiable: versioned packages and images, signatures, SBOMs, provenance.
8. Index correctness must be tested against clean rebuilds and independent expectations.
9. One maintainer must be able to operate the first release, and outside contributors must be able to extend it without core changes.
10. Client support must be evidenced, not inferred solely from MCP compliance.
11. Every component of a distributed artifact carries an OSI-approved license compatible with Apache-2.0 redistribution.
12. Exploring the graph should be fast, visual, and memorable, and never more confident than the data behind it.
13. The predecessor keeps working until Proofmesh reaches tested parity, and nothing confidential from it reaches a public artifact.

## 3. Decision summary

| Area | Decision |
|---|---|
| Runtime | TypeScript on Node.js for core, CLI, MCP, HTTP API, Observatory, and the TypeScript, React, Python, and Terraform adapters; .NET only for the C# adapter |
| Graph store | Meshstore: Proofmesh's own graph layer on embedded SQLite; one sealed, immutable file per published snapshot plus a mutable catalog |
| Evidence storage | Local content-addressed immutable objects, with configurable retention |
| External interfaces | MCP stdio and Streamable HTTP, CLI, Observatory, all over the same application services |
| Indexing | Deterministic structural extraction plus language-aware resolution, through a versioned out-of-process adapter protocol |
| Languages, first public release | TypeScript/JavaScript with a React framework adapter; Python; Terraform; C# |
| Build trust | No build evaluation by default; per-repository trust grant, made only through the CLI, enables it and is recorded on every affected fact |
| Search | SQLite FTS5 for lexical discovery; optional vector extension for discovery only |
| Visualization | Observatory: React and Vite; Sigma.js with graphology for detail views; cosmos.gl for whole-repository maps |
| Packaging | npm package as the primary native install; one OCI image as the alternative; no Compose stack or database container |
| Execution | Optional separately authorized verifier; no generic shell MCP tool |
| Snapshot model | Immutable logical snapshots, sealed as files, atomic publication, pinned queries |
| Deployment | Local and private first; shared multi-user mode deferred |
| Predecessor | Evolve the private predecessor repository in place; new core beside the old tool until parity; publish only through a fresh-history export |
| Licensing | Apache-2.0 for code, docs, schemas, and project-authored fixtures; dependency license policy enforced in CI |
| Contribution and governance | Developer Certificate of Origin, Contributor Covenant, public ADRs, maintainer-led with a written path to a maintainer group |

## 4. Decisions and consequences

### D01 — Meshstore: our own graph layer on SQLite

Proofmesh owns its graph model, traversal engine, and snapshot semantics in a component called Meshstore. Meshstore uses SQLite as its storage engine. Proofmesh does not write a storage engine: durability, crash recovery, B-tree indexing, and page caching come from SQLite, which is public domain, embedded, and available on every mainstream platform. The predecessor already stores its graph in SQLite.

On disk, one data directory holds:

- `catalog.db`: mutable, WAL mode. Repositories, trust grants, the snapshot registry and current pointers, index jobs and checkpoints, claims, verification runs, approvals, memory notes, and query records.
- `snapshots/<snapshot-id>.db`: one sealed file per published snapshot. Files, symbols, relationship assertions, materialized traversal edges, unresolved references, evidence records, coverage, visualization aggregates, full-text tables, and optional vector tables. Immutable after sealing.
- `objects/`: the content-addressed evidence store (D02).

Traversal, path search, impact analysis, and budget accounting are Proofmesh code over indexed adjacency tables, not recursion inside SQL. FR020–FR022 require per-step control of depth, time, rows, and bytes, and exact truncation reporting; owning the traversal is how Proofmesh guarantees them. Expansion is level-synchronous and batched, one indexed query per frontier batch, so no complete graph is ever loaded into memory.

Lexical discovery uses SQLite FTS5, including a trigram tokenizer for code substrings. Semantic candidate retrieval is optional, disabled by default, and uses a pinned vector extension behind an interface (candidate: sqlite-vec, pre-1.0 at the time of writing). Vector results are discovery hints and never evidence.

Proofmesh pins its SQLite build through a Node binding that bundles SQLite (candidate: better-sqlite3) rather than relying on a system library. Readiness fails when required features, such as FTS5, JSON functions, STRICT tables, or the minimum version, are missing.

Benefits: no server process, JVM, or database administration; one public-domain storage dependency; snapshot isolation enforced by file boundaries; garbage collection is deleting a file; backups and bundles are ordinary files; contributors run every non-container test without provisioning a database.

Costs: Proofmesh maintains its own traversal engine and query planning and must test them heavily; users get no general-purpose graph query language; SQLite allows one writer per database file; full per-snapshot files cost disk until structural sharing exists; a native Node module needs prebuilt binaries per platform. No claim that this is faster than a dedicated graph database for every workload. Benchmarks must establish acceptable behavior.

Mitigations: a `GraphStore` interface keeps a different engine possible if benchmarks require one. Differential tests compare the traversal engine with a simple in-memory reference on generated graphs. Incremental snapshots start from a copy-on-write clone of the previous sealed file where the filesystem supports it (APFS clones; Btrfs and XFS reflinks) and a full copy elsewhere. Retention and pinning bound disk use. One index per repository at a time is enforced by a lock file in the data directory, and indexes of different repositories run together; readers are unlimited.

### D02 — Evidence objects live outside the graph

Store source content, source excerpts where appropriate, logs, and generated reports in a content-addressed object store. Snapshot files and the catalog refer to hashes and metadata.

Write and verify an object before committing its reference. Orphan objects are tolerable and garbage-collectable; published dangling references are not. Garbage collection respects snapshot pins, retention rules, bundle exports, and active jobs.

Source objects may contain secrets. Local storage is not automatically secure; use restrictive permissions, documented retention, and explicit export consent. Redaction is best effort and must not alter the original hash-backed evidence silently.

### D03 — Immutable logical snapshots, sealed as files

Each query pins a published snapshot. Snapshot identity covers repository inventory, file hashes, analysis configuration, analysis mode, adapter manifests and versions, the snapshot file format version, and relevant build configuration. Identical inputs yield the same snapshot identity, so re-indexing unchanged inputs reuses the published snapshot.

A snapshot is a logical captured state, not necessarily an atomic filesystem capture. A pre/post reconciliation must detect relevant mutations. If stability cannot be established within budget, strict freshness fails with an explicit result.

Publication: the coordinator writes a staging file, validates it completely, finalizes its journal, records its digest, makes it read-only, renames it into `snapshots/`, then marks it published and moves the repository's current pointer in one short catalog transaction. A crash before that commit leaves an orphan file, which garbage collection removes; the prior published snapshot stays current. Partially staged records are never visible, because queries open only sealed files that the catalog names as published.

Queries open exactly one sealed file read-only, so a query cannot follow an edge from another snapshot. Comparison queries attach a second sealed file explicitly. Multi-repository queries pin one snapshot per repository and report each member; cross-repository resolution is out of scope for the first release.

Incremental indexing clones the previous sealed file into staging and applies invalidations. A normalized dump of the result must equal a clean index of identical inputs (INV08). Structural sharing between snapshots is a later optimization that requires equivalence tests.

A sealed file is never rewritten. When the snapshot file format changes, Proofmesh either reads the old format through an explicit compatibility path or reports the snapshot as needing re-indexing. It never reinterprets an old file silently.

Published means consistent under declared checks. It does not mean semantically complete.

### D04 — Extraction and resolution are distinct

Structural parsing identifies declarations and syntax. Compiler or language-service adapters resolve targets where supported. Framework adapters resolve configuration mechanisms using documented rules. All of them run through the adapter protocol (D13).

An extracted call expression is not automatically a resolved call edge. Candidate targets and unresolved sites remain inspectable. A target declared outside the indexed scope, such as a standard-library method, is recorded as resolved outside scope, which is distinct from unresolved. Documentation and model hypotheses cannot create trusted executable edges.

First public release ecosystems:

- TypeScript and JavaScript, including JSX and TSX: the TypeScript compiler API over the captured workspace. It does not load language-service plugins named in configuration, run package scripts, or install dependencies.
- React: a framework adapter over the TypeScript facts for component render relationships, props, hooks, and context providers and consumers.
- Python: semantic resolution through Pyright, which runs on Node and does not execute Python code. A spike confirms throughput and the integration surface before the adapter is built; the fallback is syntax plus import resolution with candidate call edges.
- Terraform: static HCL parsing with Proofmesh's own reference resolver for resources, data sources, variables, locals, outputs, and local module calls. Proofmesh never runs `terraform init`; modules that are not present locally remain unresolved with a reason.
- C#: Roslyn, in the two modes defined by D14.

Unsupported syntax, external dependencies, generated sources, and unresolved dynamic behavior remain explicitly reported. Additional languages require an adapter, conformance fixtures, and a coverage statement before support is advertised.

### D05 — MCP is primary and client-neutral

Implement MCP through the maintained TypeScript SDK. Pin a stable protocol and SDK combination in the release manifest; do not adopt an unversioned draft automatically.

In a native install, a client-launched stdio process runs the application services in process against the shared data directory. `proofmesh serve` provides Streamable HTTP on loopback for clients that connect over HTTP and for Observatory. For the container image, a thin host-side stdio bridge forwards to the container's HTTP endpoint. Logs never contaminate stdout.

No model provider is embedded in core query behavior. Skills and prompts improve workflows but do not enforce correctness. Every required capability is reachable with tools alone.

Claude Code and Codex are certification targets, not currently certified integrations. A public compatibility document records tested client versions and transport combinations.

### D06 — Verification is a set of recorded checks

Separate integrity, replay, semantic resolution, independent corroboration, executed checks, and optional formal analysis. A composite verdict must retain individual outcomes and limitations.

A high embedding score is not evidence of a call. A passing test is not proof of safety. A path is not proof of runtime execution. Replaying the same parser is reproducibility rather than independent corroboration.

Negative claims require declared scope, relationship types, coverage, and unresolved boundaries. Unbounded “no consumers” conclusions are rejected unless a validated closed-world contract supports them.

### D07 — Verification execution is optional and isolated

Read tools cannot start tests, run build scripts, install packages, or mutate source. An approved verification recipe runs in a disposable checkout, not a writable view of the original repository.

Approval binds command arguments, snapshot, recipe and toolchain image, working directory, environment, network and filesystem policy, expiration, and resource limits. The service revalidates the binding before execution and records consumption to prevent replay.

The Proofmesh service never talks to a container runtime; only a separate host-side launcher does, and it creates a fresh constrained container per job. When Proofmesh itself runs in its container image, the host runtime socket is never mounted into it. The launcher is disabled by default. Rootless execution is preferred where supported. The launcher is still a privileged trust boundary and is documented as one.

Containers are not perfect sandboxes. Do not execute hostile repositories on a sensitive host merely because container limits exist.

Build evaluation during indexing (D14) is a different capability from verification execution and is governed by its own trust grant.

### D08 — Native-first distribution, optional container, local-first security

The primary install is a versioned npm package that runs natively on a supported Node.js LTS release and keeps all state in one data directory. The C# adapter additionally needs a .NET runtime, or ships as a self-contained executable; `proofmesh doctor` reports which adapters are runnable. An OCI image with the complete toolchain is the alternative for container users and for CI. There is no Compose stack and no database container.

Publish packages, images, checksums, SBOMs, signatures, provenance, supported versions, and upgrade instructions. Test native installs on the declared operating-system matrix (macOS and Linux first; Windows only after its matrix passes), and test images on Linux AMD64 and ARM64.

The HTTP endpoint binds to loopback. There is no database port to expose. Repository access is read-only. In native mode that rests on application policy and file permissions, because the service never opens repository files for writing. In container mode it is additionally enforced by read-only mounts. Native mode therefore has less defense in depth than container mode, and the documentation says so. API and session tokens are generated per installation and never committed. No telemetry or remote model calls.

Shared mode requires a separate security ADR covering identity, repository authorization, tenant leakage, TLS, quotas, and audit retention. It is not supported by simply changing the bind address.

### D09 — Comprehensive tests are release requirements

Require reviewed golden fixtures, real-store integration tests, property tests, differential traversal tests, incremental and clean equivalence, MCP contracts, adapter conformance, visual contract and browser security tests, package and container E2E, security tests, fault injection, and versioned benchmarks.

Coverage is a diagnostic, not a substitute for assertions. Critical decisions have positive, negative, and failure-path tests. Test expectations must not be generated by the extractor under test.

### D10 — Spec Kit layout, Orbit execution

Keep the Spec Kit artifact layout (constitution, feature specification, implementation plan, data model, contracts, checklists, tasks) as plain files in the repository. Installing the Spec Kit tooling is optional. Orbit executes each milestone as a run against a goal that names its acceptance criteria and verification commands, in isolated worktrees from a committed baseline.

These four delivered documents are the source packet. On materialization, the canonical repository artifacts become authoritative and this packet is archived.

### D11 — Observatory: a visual interface that shows its work

Proofmesh ships Observatory, a browser interface served by the local service on its loopback endpoint. Observatory is a client of the same application services as MCP and the CLI. It has no private data path and creates no facts.

Views: Galaxy (whole-snapshot map with hierarchical aggregation), Trace (neighborhoods and paths, with the bounded search animated as it expands), the Evidence panel (exact source behind any node or edge), Claims (verification layers drawn as rings), Replay (an agent session's queries against its claim's declared scope; P2), and Diff (two snapshots compared; P2).

Visual honesty is a feature, not a disclaimer. Incomplete coverage renders as fog. A truncated search ends at a visible horizon that carries the count of unexplored items. An unresolved call is an edge that frays into fog with its reason. Model hypotheses never share the style of resolved edges. Facts analysed with build execution carry a visible mark. Exported images carry their snapshot, scope, limits, and legend inside the image, so a screenshot cannot travel without its caveats.

Stack: React and Vite. Sigma.js with graphology renders interactive detail views; cosmos.gl (an OpenJS Foundation incubating project) computes and renders GPU force layouts for Galaxy. All three are MIT-licensed. A spike on reviewed fixtures confirms Galaxy rendering before that view is built; each library sits behind a view boundary and can be replaced.

Aggregation follows the repository's own structure (repository, package, directory, file, symbol), because that grouping is deterministic and explainable. Algorithmic community detection may be offered as a labelled alternative grouping. It is never evidence.

Layout is derived data. It is cached per browser and snapshot and seeded from the previous snapshot's positions, so the map stays stable while code changes. Layout is never evidence and need not be reproducible across machines. Spatial proximity never implies a relationship, and the legend says so.

Security: repository content is untrusted input to a browser. Observatory renders source and identifiers as text only, ships every asset inside the package under a strict Content Security Policy with no remote scripts, fonts, or analytics, shows bidirectional and invisible characters visibly, and authenticates the browser with a per-launch token, passed in the URL fragment and exchanged for an HttpOnly, SameSite=Strict session cookie. Host and Origin checks reject DNS-rebinding and cross-site requests.

Costs: a frontend toolchain; WebGL availability and GPU variance; visual regression testing. Without WebGL, Observatory falls back to its table views.

The name avoids clashes with existing tool names.

### D12 — Open source: license, governance, contribution, publication

- License: Apache-2.0 for code, documentation, schemas, and fixtures the project authors. Every artifact ships `LICENSE`, `NOTICE`, and generated third-party notices.
- Dependency license policy, enforced in CI on every change: permissive licenses (for example MIT, BSD, Apache-2.0, ISC, Zlib, 0BSD, BlueOak-1.0.0, PSF, public domain) are allowed; file-level weak copyleft (for example MPL-2.0, EPL-2.0) needs listed review; strong or network copyleft (GPL, AGPL), source-available (BSL, SSPL, Elastic License, Commons Clause), and non-commercial licenses are not allowed in distributed artifacts, including aggregated images. Exceptions require an ADR. The policy is stricter than the legal minimum so that downstream packagers inherit no surprises.
- Contribution: Developer Certificate of Origin sign-off on every commit; no contributor license agreement. Contributor Covenant code of conduct with a named enforcement contact.
- Governance: maintainer-led at launch, with a written path to a maintainer group: criteria for commit rights, decisions through public ADRs and lazy consensus, conflict resolution, and succession if a maintainer leaves.
- Security: private vulnerability reporting, a coordinated disclosure policy, and a supported-versions table.
- Development in public, from the first public release: issues, roadmap, ADRs, benchmarks, threat model, and compatibility matrix are public. Every documented feature carries one status label: implemented, experimental, or planned.
- Fixtures and corpora are project-authored or carry a compatible license with recorded provenance. No proprietary code enters fixtures, benchmarks, examples, issues, or screenshots.
- Publication gate: the evolved repository's history contains confidential details of the large private C# codebase the predecessor indexes. It is never pushed to a public remote. The first public repository is created from a fresh-history export that passes an automated leak scan and a manual review, after the maintainer confirms ownership of every exported line and the names are cleared.
- Every feature specified in these documents ships under Apache-2.0. Any commercial offering is outside this ADR.

### D13 — Adapters are out-of-process plugins behind a versioned protocol

Language and framework adapters run as subprocesses speaking a versioned JSON-RPC protocol over stdio, the Proofmesh Adapter Protocol, whose messages are defined by JSON Schema files in the repository. The TypeScript, React, Python, and Terraform adapters are Node processes; the C# adapter is a .NET process. First-party adapters use only the public protocol.

Adapters receive captured content from the snapshot's materialized workspace, never live repository paths, and return symbols, relationships, candidates, unresolved sites, capability declarations, and failures. Ranges cross the protocol as UTF-8 byte offsets plus 1-based line numbers; adapters convert from their compiler's native offsets. The protocol has no operation that executes repository code; build evaluation is a separate mode that the core enables only under D14. Each adapter declares its identity, version, and capabilities in a manifest that becomes part of snapshot identity.

A public conformance kit (fixtures, reviewed expected facts, and a runner) decides whether a capability may be advertised as supported. Third-party adapters are installed explicitly by the user. Installing an adapter means trusting its code, and the documentation says so. Adapter processes run with a minimal environment, resource limits, and no network where the platform can enforce it.

Benefits: contributors write adapters in the language whose compiler they need; an adapter crash cannot corrupt the core; the core never imports compiler toolchains. Costs: serialization overhead, protocol versioning, and process supervision.

### D14 — Build evaluation requires a per-repository trust grant

Some ecosystems resolve precisely only after their build system runs. For C#, MSBuild evaluation, package restore, analyzers, and source generators execute code from the repository and its packages. Proofmesh treats this as execution.

Default, no-execution mode: the C# adapter reads project files as static XML, compiles source files with Roslyn against framework reference assemblies and any package assemblies already present on disk, and loads no analyzers or generators. Symbols declared in the repository resolve; targets that need restore or generated code remain unresolved with a reason.

Trusted-build mode: a person grants trust to one repository with `proofmesh repo trust <repository> --build-evaluation`. Only the CLI can grant or revoke trust; MCP and HTTP have no operation for it. The grant is stored in the catalog with its time and the identity of the granting user, and it can be revoked. With a grant, the C# adapter may run MSBuild evaluation, restore, analyzers, and source generators with the user's permissions and network access, equivalent to running a build locally.

Every snapshot records its analysis mode in its identity. Every fact produced under trusted-build mode carries that mode in its provenance. Envelopes, exports, and Observatory show it. A snapshot built with execution is never presented as a no-execution result.

Trusted-build mode is not sandboxed. Running it inside the OCI image adds isolation and is documented as the safer option. The same mechanism covers any future ecosystem whose precise resolution needs build execution; Terraform, Python, TypeScript, and React adapters do not use it in the first release.

### D15 — Evolve the predecessor in place

The private predecessor repository becomes the Proofmesh repository. The TypeScript core grows beside the existing .NET tool, which keeps working unchanged. The predecessor's Roslyn indexer is re-hosted as the C# adapter behind the adapter protocol. Rules specific to the large private C# codebase it indexes, along with its curated notes and evaluation questions, move into a private overlay adapter that the public core loads like any third-party adapter. When the predecessor's golden questions pass on Proofmesh with the overlay, the old tool surface is removed in one change.

Benefits: working semantic C# analysis and an evaluation harness carry forward; one repository to maintain. Costs: the repository holds two toolchains during the transition; its history can never be published (D12).

## 5. Alternatives considered

| Alternative | Strengths | Why not selected initially |
|---|---|---|
| Neo4j Community Edition (revision 1 choice) | Mature graph database, Cypher, full-text and vector indexes | A JVM server to install, size, and operate on every laptop; GPLv3 inside the distributed stack conflicts with D12; online backup is not part of Community Edition |
| Kùzu (embedded, Cypher, MIT) | Embedded graph engine, close functional fit | Upstream repository archived in October 2025; several community forks exist and no successor is settled. Revisit if one consolidates |
| DuckDB with the DuckPGQ extension | Embedded, MIT, fast analytics, SQL/PGQ | The graph extension is a community research extension; the engine targets analytics rather than point lookups; single writer process |
| Apache AGE on PostgreSQL | Apache-2.0, openCypher | Requires a PostgreSQL server |
| Memgraph, FalkorDB, ArangoDB | Capable graph engines | Source-available licenses (BSL or SSPL) at the time of writing conflict with D12 |
| Custom storage engine | Full control of layout | Durability, recovery, and indexing are years of work unrelated to the product's value; SQLite supplies them |
| In-memory graph library (graphology, NetworkX) | Simple, rich algorithms | Violates driver 2 at repository scale; graphology serves Observatory views and the traversal test oracle only |
| Python core (revision 1 and 2 choice) | Strong property testing and typed models | Two runtimes for users, since the TypeScript adapter and Observatory need Node; schemas duplicated across languages |
| .NET core | Self-contained binaries, Roslyn in process, matches the predecessor | Node still required for the TypeScript adapter and Observatory; smaller contributor pool for an agent tool |
| Fresh repository instead of evolving the predecessor | Clean public history from day one | Loses the working C# indexer and evaluation harness; the fresh-history export at publication gives the same clean history later |
| Syntax-only C# without trust grants | Absolute no-execution rule | Drops the precision that DI wiring, handler dispatch, and interface resolution need |
| Build evaluation for every repository | Simplest | Any indexed repository could run code on the user's machine |
| PostgreSQL plus pgvector | Relational integrity, broad tooling, vector discovery | A database server, and two query abstractions |
| JSON graph files as primary store | Easy inspection and export | Poor fit for bounded persistent querying and atomic publication; kept as a normalized export format |
| Embedding-only retrieval | Useful approximate discovery | Cannot establish code relationships or exhaustive absence |
| LLM-generated graph | Can suggest domain links | Nondeterministic extraction and provenance risks; hypotheses only |
| Language server only | Strong navigation and diagnostics | Does not alone supply a persistent graph, snapshot ledger, or evidence bundles |
| Hosted-first service | Easy centralized updates | Violates privacy and operational simplicity goals |
| Static diagram output (Graphviz and similar) | Simple, deterministic | Not interactive at repository scale; kept for small exported diagrams |
| 3D force-directed graph | Striking first impression | Occlusion hides edges and limits, which conflicts with INV13; harder to read and to make accessible; may return as an optional mode |
| Cytoscape.js for detail views | Mature, MIT, rich layouts | Viable; Sigma.js chosen to keep one WebGL renderer and one data model (graphology) across detail views |

## 6. Architectural invariants

- INV01: No published snapshot references missing evidence at publication time.
- INV02: A query never mixes snapshots unless explicitly performing a comparison.
- INV03: Every discovered file has exactly one top-level disposition.
- INV04: Unsupported analysis is never reported as complete.
- INV05: Limits and truncation are machine-readable.
- INV06: Read-only requests cannot initiate execution or source mutation.
- INV07: Hypotheses cannot silently become resolved facts.
- INV08: Incremental indexing converges to clean-index normalized facts.
- INV09: Approvals cannot be reused or expanded.
- INV10: Stale evidence cannot pass a current-working-tree check.
- INV11: Workspace and repository identifiers do not themselves grant access.
- INV12: Removal under retention produces unavailable evidence, not fabricated validity.
- INV13: No view or export hides truncation, unresolved boundaries, or incomplete coverage present in its data.
- INV14: A sealed snapshot file is never modified after publication, and modification is detectable from its recorded digest.
- INV15: Observatory has no capability beyond the read and management tools available to other clients, and it creates no facts.
- INV16: No build logic is evaluated for a repository without a recorded trust grant, and every fact produced with build evaluation carries that mode.
- INV17: No content from the evolved repository's history reaches a public artifact except through the fresh-history export and its leak scan.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Traversal engine defects | Differential tests against an in-memory reference, property tests, mutation tests on budget and truncation logic |
| SQLite single writer limits indexing throughput | One staging file per job, batched transactions, benchmark before release candidate |
| Snapshot file duplication | Copy-on-write clones, retention and pinning first, structural sharing later |
| Native SQLite binding missing for a platform | Supported-platform matrix, readiness check, OCI image as fallback |
| UTF-16 versus UTF-8 offset bugs in adapters | Protocol fixes byte offsets; fixtures place multi-byte characters before symbols |
| Python semantic engine too slow or too internal | Spike before the adapter; syntax plus import resolution fallback with candidate edges |
| Trusted builds run hostile code | Off by default, CLI-only grants, visible mode on every fact, container option documented |
| Confidential predecessor content leaks | Never push the evolved history; fresh-history export, automated leak scan, manual review, private overlay for codebase-specific rules |
| The old tool stops working during migration | Old tool untouched until parity on its golden questions |
| Dynamic and framework wiring gaps | Adapter coverage and unresolved-boundary reporting |
| Agent ignores evidence | Structured findings, deterministic report validation, explicit unverified prose |
| Visuals overstate evidence | Visual honesty invariant, encoding contract tests, caveats embedded in exports |
| Malicious repository content in the browser | Text-only rendering, strict CSP, XSS and bidi-character fixtures |
| WebGL missing or slow | Table fallback, aggregation by level of detail, frame budgets set on declared hardware |
| Third-party adapter compromise | Explicit installation, subprocess limits, documented trust model |
| Supply-chain compromise | Pinned dependencies, signed releases, SBOM, provenance, scanning, fork-safe CI |
| License drift through transitive dependencies | CI license gate and SBOM review on every release |
| Maintainer bandwidth and bus factor | Governance path to a maintainer group, automation, milestone scoping |
| Verification escapes isolation | Restricted launcher, disposable environments, honest threat model |
| Product name implies universal proof | Precisely label verification layers and avoid blanket verified badges |
| Stale or conflicting docs | Dependency-aware staleness and retained conflicting evidence |

## 8. Approval and revision policy

Milestone M0 (the walking skeleton) may proceed on this proposal, because it is the prototype that approval depends on. Approval beyond M0 requires review of the specification, threat model, M0 results including sealing and crash tests, the incremental-equivalence experiment, the Python and Galaxy spikes, the dependency and license inventory, and the acceptance-test design. This document is not approved solely because an agent generated it.

Revisit if benchmarks show Meshstore traversal or snapshot disk cost outside agreed budgets, if a maintained embedded graph engine with a compatible license becomes a clear improvement, if the launch ecosystems change, if shared hosting is introduced, or if execution isolation or build trust changes. After approval, record superseding decisions rather than rewriting history silently.

## 9. Revision history

- Revision 1, 2026-11-06: initial proposal with Neo4j Community Edition as the graph store, a Python core, and a Docker Compose stack.
- Revision 2, 2026-11-07: replaced Neo4j with Meshstore (D01, D03); native install primary and container optional (D05, D08); added the visual interface (D11), open-source licensing and governance (D12), and the out-of-process adapter protocol (D13); added INV13–INV15.
- Revision 3, 2026-11-07, after the maintainer's Orbit Inquisition: TypeScript on Node replaces Python as the core runtime; first public release covers TypeScript/JavaScript with React, Python, Terraform, and C#; build evaluation requires a per-repository trust grant (D14); the private predecessor evolves in place (D15) with a publication gate (D12); Spec Kit layout with Orbit execution (D10); the visual interface is renamed Observatory; added INV16–INV17.
- Revision 4, 2026-11-07: amendments A1–A13 (section 10) from the Galaxy prototype; cross-repository linking moves into scope.
- Revision 5, 2026-11-07: amendment A14, decided by the maintainer during M1: framework rules that need a language's semantic model run inside that language adapter.
- Revision 6, 2026-11-08: amendments A15 and A16, decided by the maintainer during M1 and M2: the predecessor stays until M8, and incremental indexing replays cached per-file facts.
- Revision 7, 2026-11-08: amendments A17 and A18, decided by the maintainer during M1: a symbol kind for downstream services, and inbound candidate calls that name the subject are reported as such.
- Revision 8, 2026-11-08: amendment A19, decided by the maintainer during M2: discovery honours git's ignore rules.
- Revision 9, 2026-11-08: amendment A20, for M3: relationship types for React.
- Revision 10, 2026-11-08: amendment A21, decided by the maintainer during M3: files excluded for their location are not part of snapshot identity.
- Revision 11, 2026-11-09: amendments A22 to A24, decided by the maintainer for M4: adapter protocol 1 under semantic versioning, the Tree-sitter syntax tier on WebAssembly, and SCIP indexes produced by a person.
- Revision 12, 2026-11-09: amendment A25, decided by the maintainer for M4: symbol kinds for infrastructure code.
- Revision 13, 2026-11-09: amendments A26 and A27, decided by the maintainer for M4: the link from cloud resources to services waits for M6, and how a SCIP index meets first-party adapters and goes stale.
- Revision 14, 2026-11-09: amendments A28 to A30, decided by the maintainer for M5: where cross-repository links live, named workspaces, and the format runtime observations are imported in.
- Revision 15, 2026-11-12: amendments A31 to A33, decided by the maintainer after a private trial: C# references and the static property reads built on them, repository conventions as data, and notes that map text to the code writing it.
- Revision 16, 2026-11-12: amendment A34, decided by the maintainer after a private trial: catalog-scoped answers and compact envelopes.
- Revision 17, 2026-11-12: amendment A35, decided by the lead to close A8 as A26 deferred it, and accepted by the maintainer in revision 19: links from cloud resources to the services that deploy to or use them, in link format 0.2.
- Revision 18, 2026-11-12: amendment A36, decided by the lead so that Prisma tables have reach, and accepted by the maintainer in revision 19: a table is its name.
- Revision 19, 2026-11-12: the maintainer accepted amendments A35 and A36 as built.
- Revision 20, 2026-11-12: the maintainer approved the AC34 Trace view screenshot baselines in both themes (`docs/proofmesh/milestones/ac34/`).
- Revision 21, 2026-11-12: the maintainer ruled that `dotnet build` and `dotnet test` on the old tool's solution, which the goal requires while the old tool exists, are met by their passing on the old tool's last state (in pre-publication history: 0 warnings, 0 errors; all tests passing), the removal (A15) having taken the solution out of the final tree.
- Revision 22, 2026-11-13: at the maintainer's direction, the old tool's solution, its build settings, its code, its tests and its seeded registry are restored to the working tree so the goal's `dotnet build` and `dotnet test` on the old tool's solution run on the final tree. They are never exported: the publication export lists only Proofmesh's paths, and the image context is an allowlist. The rest of A15's removal stands.
- Revision 23, 2026-11-20: amendment A37, specified by the maintainer in issue #41: lean answers, the default envelope over MCP for the query tools.
- Revision 24, 2026-11-25: amendment A38, decided by the maintainer in issue #23 (option B): Proofmesh may run pinned SCIP indexers for a repository trusted for build evaluation.

## 10. Amendments A1–A34 (revisions 4 to 16, 2026-11-07 to 2026-11-12)

Decided after a working prototype; each is implemented and tested in the milestone named.

- A1 (M0). Pin `typescript` 6.x for the TypeScript adapter; 7.x no longer exports the classic compiler API.
- A2 (M2). Adapters may read declared external inputs (installed type declarations, Python site-packages, NuGet caches) read-only. Each is listed in the adapter manifest and hashed into snapshot identity; a missing one is a capability failure with a reason.
- A3 (M0). Every unresolved site carries one reason: dynamic_element_access, untyped_receiver, unknown_name, chained_callee, import_unresolved, dependency_missing, configuration_error, outside_capability. Envelopes and views show the breakdown.
- A4 (M2). Fog shows counts with percentages and suppresses percentages below 20 sites.
- A5 (M0). Function-valued variables are functions. Each file has a `module` symbol that owns top-level code.
- A6 (M4). Languages in tiers: a Tree-sitter syntax tier for TypeScript/JavaScript, Python, C#, Java, Kotlin, Go, Rust, Ruby, PHP, Swift, C, C++, Scala, Bash, SQL and HCL; a semantic tier from first-party adapters and SCIP index ingestion, each indexer tagged no_execution or trusted_build under D14.
- A7 (M5). Cross-repository linking is in scope, superseding D03's first-release exclusion. Contract adapters for HTTP routes, service registries, messaging and packages produce cross-repository assertions with a match confidence; unmatched client paths are unresolved boundaries.
- A8 (M4). Terraform adapter (static HCL, no `terraform init`) and Pulumi framework adapter produce a cloud resource graph linked to services.
- A9 (M5). Entity-to-table adapters and per-table static reach (a lower bound when the search hits its horizon, labelled "static reach, not load"); a runtime-observation adapter imports exported metric files and never connects to a cloud service.
- A10 (M5). `proofmesh discover` ranks repositories related to an anchor by evidence through read-only `gh` queries; cloning is an explicit per-repository command.
- A11 (M3, M5). Observatory: ecosystem overview with per-repository drill-down that loads only the selected repository; settle-once layouts cached by snapshot and seed hash; build-stamped assets; state initialized before renderers; truncation shown everywhere; prototype bugs B1–B24 regression-tested where they apply.
- A12 (M8). An evaluation harness measures agent sessions with and without Proofmesh on golden question sets and reports only measured results.
- A13 (M8). `proofmesh mcp-config` for Claude Code and Codex, and a Claude Code plugin that can replace the predecessor's plugin surface after parity.
- A14 (M1). Refines D13. Framework rules that need a language's semantic model run inside that language's adapter process, so the workspace is compiled once. Rules for widely used frameworks ship with the adapter and match types by namespace and name, so they fire on any repository that uses the framework and stay silent otherwise. Other rule packs, including the private overlay, are extension assemblies that a person installs through the CLI; installing one is trusting its code, and each one's identity and hash are part of snapshot identity. The core still sees one out-of-process adapter, so D13's isolation of the core holds; an extension crash loses that adapter's facts for the run. Each rule records which rule produced a fact, and Observatory shows it.
- A15 (M1, M8). Supersedes the plan's M1.7 exit "plugin replaced". The predecessor, its plugin, and the legacy paths stay until M8, where A13's plugin replaces them; M1 closes on parity evidence without the removal step.
- A16 (M2). Supersedes the plan's "clone the previous sealed file and invalidate facts", which cannot work because fact IDs include the snapshot ID. Adapter protocol 0.3 splits an adapter's output into workspace facts, answered by a `workspace` request on every index, and per-file facts, answered by `analyze`. An adapter may declare units in `initialize`: groups of files whose per-file facts depend only on the unit's files, the units it depends on, the adapter's configuration files, and its identity. The core keys each file's per-file facts by that closure, replays cached facts for files whose key is unchanged, and analyses only the rest; an adapter that declares no units is one unit, so any change reanalyses all its files. Replayed facts are written in the order a clean index writes them, so an incremental index of a tree seals the same rows as a clean index of it (FR014, SC004).
- A17 (M1). Snapshot format 0.3 adds the symbol kind `service`: a downstream service that code calls over the network, named by the client registration that targets it. Clients relate to it with `calls_service`. Within one repository this answers which service a client calls; M5's contract adapters later match a service to the repository that implements it.
- A18 (M1). Refines the M0 contract for `get_relationships`: inbound `candidate` and `ambiguous` calls whose candidates include the subject are returned as relationships with that resolution, besides being counted among the boundaries. An agent can then see the one candidate caller of a symbol instead of searching every unresolved call in the snapshot.
- A19 (M2). Adds to M0's default exclusion rules: a file git ignores is `excluded_by_rule` with detail `gitignore`, asked of git itself so `.gitignore` files, `.git/info/exclude` and the global excludes apply as git applies them, and tracked files are never ignored. Ignored files stay in the inventory and are never read. Outside a git work tree nothing is ignored. Without it, generated output and agent worktrees were analysed as source; one repository's ignored worktrees held 17,931 duplicate files.
- A20 (M3). Snapshot format 0.4 adds four relationship types for FR078, produced by the TypeScript adapter's React rules: `renders` (a component renders a component; detail names the props it passes), `uses_hook` (a component or hook calls a hook), `provides_context` (a component provides a context's value), and `uses_context` (a component reads a context). Impact follows all four, because a change to a component, hook, or context reaches whatever renders, calls, provides, or reads it.
- A21 (M3). Refines snapshot identity and A19. A file excluded for where it sits, under a path git ignores or in a default excluded directory (`node_modules`, `dist`, `build`, `bin`, `obj`), stays in the inventory and in coverage as of the index, but not in snapshot identity. So build output, generated graphs and local state never make a snapshot stale: strict freshness stays current and the watcher does not re-index when only they change. Tracked files Proofmesh cannot analyse remain part of identity. A strict query that finds the tree changed while another process holds the index lease names that index (`indexing_by`) instead of starting a job that could only fail on the lease. Found while recording the internal demo: a code-graph tool rewrote its ignored output after each commit, and every strict query was refused with no changed file named.
- A22 (M4). Adapter protocol 1 is protocol 0.3 frozen as 1.0 under semantic versioning. The core sends the version it speaks and accepts any adapter that answers 1.x; another major version is refused with both versions named. A minor version only adds optional fields, and each side ignores fields it does not know: the core removes them from an adapter's messages before validating the rest, and an adapter must accept them in the core's. A breaking change needs 2.0. The conformance kit checks these rules.
- A23 (M4). The Tree-sitter syntax tier runs on WebAssembly (web-tree-sitter) with grammars pinned as `.wasm` files whose hashes join the adapter's identity, so no grammar adds a native module per platform.
- A24 (M4). SCIP indexes are produced by a person running the indexer, then named to Proofmesh, which ingests the file and adds its hash to snapshot identity. Proofmesh never runs a SCIP indexer, so SCIP adds no execution path under D14. Amended by A38: for a repository trusted for build evaluation, `proofmesh scip run` may run a pinned indexer.
- A25 (M4). Snapshot format 0.5 adds three symbol kinds for infrastructure code: `resource` (a managed resource or data source, its mode and type in the signature), `output`, and `module_call`. Variables and locals use `variable`; references and explicit `depends_on` use the existing relationship types. The Terraform adapter names each symbol by its Terraform address within its module directory, and Pulumi's rules use the same `resource` kind.
- A26 (M4). The link from cloud resources to services that A8 names moves to M6, with the other wiring adapters. In M4, Terraform and Pulumi produce the resource graph alone: resources, outputs, module calls, references and `depends_on`.
- A27 (M4). A SCIP index fills only files that no first-party semantic adapter analyses, so each file has one source of semantic facts. `proofmesh scip add` records the content hash of every file the index covers, as the tree stands when the person names it. At index time a file whose content no longer has that hash falls back to its usual adapter, and its disposition names the stale index.
- A28 (M5). Cross-repository links (A7) live in a sealed workspace link file, apart from the member snapshots. Proofmesh builds it by reading the members' published snapshots, and its identity is the member snapshot ids and the contract rules' versions. A workspace query pins the link file and the member snapshots it was built from, so D03 holds: each file is sealed and opened read-only, and re-indexing one repository leaves the others' snapshots untouched.
- A29 (M5). An ecosystem is a named workspace: a person creates it and adds repositories, and a repository may belong to several. Links and the ecosystem overview (A11) are per workspace.
- A30 (M5). Runtime observations (A9) are imported from a file in a Proofmesh JSON schema, published under `schemas/`: observed counts per endpoint, table or channel over a time window. People convert their own exports to it; Proofmesh reads no vendor format and connects to no service.
- A31 (after M8). The C# adapter records `references`: a use of a repository declaration other than a call, as a type, a read, a write, an object creation, an attribute, a method passed as a delegate, or a `nameof`. One reference per user and target, cited at its first site, with every use in its detail; a name that binds outside the repository, or not at all, is not recorded. Enum members are `field` symbols, and `nameof` is no longer a call. Static entity property reads per endpoint (`get_property_reads`) and table reach through a context's DbSet property derive from these references, with no new relationship type. Snapshot format 0.6 adds an index of symbols by file.
- A32 (after M8). A repository's conventions file names types only the repository can name: job base classes, feature flag keys and the enum whose members name owning teams. It is data: registering it runs nothing and grants no trust, so any caller of the CLI may register it. It is stored in the C# adapter's configuration for the repository and is therefore part of snapshot identity.
- A33 (after M8). A note may list text patterns, regular expressions for text the code it targets writes, such as a SQL clause a query helper adds (catalog migration 0016). `search_sources` names the accepted notes a searched text matches, and `find_query_source` ranks the endpoints and jobs reaching a statement's tables by the evidence each has. `get_external_usage` counts call sites into code outside the repository.
- A34 (after M8). Two envelope variants. A catalog tool (`list_repositories`, `get_job`, and `list_queries` with no repository) answers from the catalog, not a snapshot: its `snapshot` and `coverage` are null and its freshness status is `catalog`. A compact envelope (`envelope: "compact"`) leaves out what an earlier answer from the same snapshot gave (coverage, unresolved reasons, standing limitations, requested limits) and keeps the query's own limits and limitations; the MCP server sends compact after the first full answer per snapshot on a connection, and any envelope that alone overflows `max_bytes` is compacted. Catalog migration 0017 adds progress times and the run plan to index jobs.
- A35 (after M8). Closes A8's "linked to the services that declare or deploy to it", which A26 deferred. A service declares the resources its own repository's Terraform or Pulumi code declares; that needs no link. Across a workspace, link format 0.2 adds two link types, built by the link builder from the member snapshots alone. `deploys`: a hosting resource (a web, container or function app, an App Service, a Lambda function, an ECS service or task definition, a Cloud Run service, a Kubernetes deployment or a Helm release) links to the member repository that its name, or the repository part of its container image, names: 0.9 for an exact name, 0.7 for a service-name match. `uses_resource`: a channel a member publishes or consumes links to a messaging resource (a topic, queue, subscription, event hub, SNS topic, SQS queue, Kafka topic or Pub/Sub topic) another member declares with that name: 1.0 exact, 0.9 ignoring case. A resource's attribute values are read from its own block in the declaring member's sealed snapshot, through the evidence store, never from a working tree; a value that is not a literal is not matched. Rule versions join the link file's identity as before.
- A36 (after M8). A table is its name in the database. `get_table_reach` treats every `table` symbol of a snapshot that shares one qualified name, ignoring case, as one table, whichever adapter declared it: their entities are listed together and the reach search starts from all of them. So an EF entity and a SQL `CREATE TABLE` of the same table, or a Prisma model and the TypeScript code that queries it, meet without one adapter naming another's symbols, and adapter protocol 1 is unchanged. The TypeScript adapter reads the repository's `schema.prisma` files as configuration, names each model's table as the Prisma rule does (`@@map`, `@@schema`), and makes each Prisma Client model access (`prisma.user.findMany(...)`, the client recognised by its import from `@prisma/client`) a `references` from the enclosing function to its own `table` symbol of that name.
- A37 (after M8). Lean answers (FR095 to FR100). The query tools whose results are code locations (`find_symbols`, `get_symbol`, `get_relationships`, `trace_paths`, `analyze_impact`, `find_tests`) take `envelope: "lean"`: plain text, a header naming the snapshot as current or stale, one `<name> <path>:<line>` row per result with tags, then `# ` lines for that answer's limitations and the next cursor, with no JSON and no `structuredContent`. Over MCP it replaces A34's compact-after-first-full as those tools' default; `compact` and `full` stay selectable by name. Every symbol id parameter also takes `{ name, path }`.
- A38 (after M8). Amends A24 and extends D14's grant from C# to every language. `proofmesh scip run <repository> [--language L]` runs a pinned SCIP indexer (scip-go, scip-java, rust-analyzer with build scripts and procedural macros off) only for a repository with a build-evaluation grant, and refuses with `TRUST_REQUIRED` otherwise, printing the grant command and the indexer command a person could run, and running nothing. The indexer is the version and digest pinned in the indexer table (a person may pin the build they installed in the data directory's `indexers.json`); Proofmesh never downloads one and says the install command when it is missing. It runs in a disposable copy of the current snapshot with no shell, an allowlisted environment, a private HOME, the network limited to a declared module cache (offline settings; `--network none` and a read-only cache inside a container where `--container` names an image pinned by digest), SIGKILL on a time or memory limit and capped output; the run stops at a limit and its partial output is never named. The result is named as a SCIP index recording the indexer, its version and digest and the grant, and joins snapshot identity; its facts record analysis mode `trusted_build`. Revoking the grant stops the index being read: its files return to their usual tier with unchanged keys and the census names the revoked grant. A grant revoked while a run is in progress discards that run's result; one made meanwhile applies to the next run. Only the CLI can start a run (D14, FR036). A24 stays the default for a repository that is not trusted: an index a person produced and named is read as before.
