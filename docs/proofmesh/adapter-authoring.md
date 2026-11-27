# Writing a Proofmesh adapter

An adapter teaches Proofmesh a language. It is a program that speaks the Proofmesh Adapter Protocol over its standard input and output, and it can be written in any language. The core never imports it: it starts the adapter as a subprocess, sends it the files to analyse, and checks everything it sends back before any of it reaches a snapshot.

This guide covers the protocol, the rules the core enforces, how a person installs an adapter, and how the conformance kit decides whether its capabilities may be called supported. The message schemas in `schemas/adapter-protocol/` are the normative definition; this guide explains them.

## The protocol

JSON-RPC 2.0, one JSON object per line. Requests and answers go over standard output; anything on standard error is a log line the core keeps at debug level. Never write source content to either outside an answer.

| Method | Direction | What it does |
|---|---|---|
| `initialize` | core to adapter | Names the protocol version, the workspace directory, the analysis mode, and every file the adapter will see, with its content hash and language. The adapter answers with its manifest: id, version, the protocol version it speaks, languages, toolchain versions, capabilities, external inputs, and optionally units. |
| `workspace` | core to adapter | Asked once per index, before any batch, and never cached: facts that span files, such as a dependency-injection container or a service registry. |
| `analyze` | core to adapter | A batch of paths. The adapter answers with symbols, relationships, one file result per path, and diagnostics, for those paths only. |
| `shutdown` | core to adapter | Answer it, then exit. |
| `log` | adapter to core | A notification with a level and a message. |

The adapter reads files from the workspace directory, which holds exactly the captured content, never from the live repository. It may read the external inputs it declares (installed packages, SDK reference assemblies) read-only, and names each in `external_inputs`, so their versions join snapshot identity.

## Versions (A22)

The core speaks protocol 1.3 and accepts any adapter that answers `1.x`. Protocol 1.1 added the optional `roles` of a symbol (see Test roles below), 1.2 its optional `detail` (see Symbol detail below), and 1.3 the optional `sites` of a relationship (see Further sites below); an adapter that never sends them is as valid as before. A minor version only adds optional fields, and each side ignores the fields it does not know. The core sends fields your adapter has never seen; accept them. An adapter that answers another major version is refused with both versions named. A breaking change to the protocol needs 2.0.

## Test roles (protocol 1.1)

A symbol may carry `roles`, a list of `test` (a test entry point, by its framework's marker) and `test_support` (test code that is none: the members of a test-only scope, the helpers of a test class). It is optional: an adapter that never sends it is valid, and its symbols are test code only by their file's convention. The core stores it, answers it in `find_symbols` and `get_symbol`, and uses it to leave a symbol out of `include_tests: false` answers and to decide which symbols `find_tests` lists. Read the marker from syntax; do not run the framework.

## Symbol detail (protocol 1.2)

A symbol may carry `detail`, an object of facts kept beside its name. Its one field is `scip`: the SCIP importer puts the index's own symbol there, since the qualified name is the language's form and not the index's (FR441). The core stores it and answers it in `get_symbol`. Other adapters need not send it.

## Further sites (protocol 1.3)

A relationship may carry `sites`, further ranges in the same file as its `site` that are evidence of the same relationship: every later use of a type that one function names on several lines, say. The core writes each as one more evidence row of the one assertion, which `site` still names and orders, so `get_relationships` answers one row with every site among its evidence and `plan_rename` can list every line. Send it where your adapter folds several uses into one relationship; otherwise leave it out.

## Facts

Symbols carry an opaque `local_id`, unique within the answer, their path, kind, name, qualified name, declaration range, and signature (or null). Relationships carry a type, an origin, a source and a target by local id, the site where the relationship is written, and a resolution:

| Resolution | Meaning | Carries |
|---|---|---|
| `resolved` | The target is a symbol or file in the snapshot | a target (required) |
| `resolved_external` | The target is outside the repository, such as a standard library method | an external target, module and name (required) |
| `candidate`, `ambiguous` | Several symbols could be the target | the symbols it could be, ranked, as `candidates` |
| `unresolved` | The target is unknown | a reason (required) |

The reasons are `dynamic_element_access`, `untyped_receiver`, `unknown_name`, `chained_callee`, `import_unresolved`, `dynamic_specifier` (an `import()` whose specifier is computed), `not_indexed` (an import of a repository file that is not indexed), `dependency_missing`, `configuration_error`, and `outside_capability`. An `imports` relationship may carry its kind in `detail.kind`: `static`, `dynamic`, `re_export` or `type_only`; the core merges the statements between two files into one assertion of the strongest of their kinds (`static`, then `re_export`, then `type_only`), and keeps an `import()` of the same file as an assertion of its own. Any other relationship is one assertion per type, source, site (path, start and end byte) and target, so each call of a chain such as `a.map(f).collect()`, whose sites all start at `a`, is its own assertion; report each call with the span of its own call expression. An unresolved site is a fact, not a failure: report it with its reason rather than leaving it out, because Proofmesh shows every unresolved boundary to the person reading the graph.

Ranges are UTF-8 byte offsets into the captured file, with 1-based line numbers. Convert from your compiler's native offsets; a range that does not fit its file fails the batch.

Each file result names the file, `ok` or `failed`, and what you could do for it, per capability: `complete`, `partial`, `unsupported`, `failed`, or `not_run`. This is your coverage statement; Proofmesh shows it, and it is how a person knows what the graph cannot see.

## Units and incremental indexing (A16)

An adapter may declare units in its `initialize` answer: groups of files whose per-file facts depend only on the group's id and files, the groups it depends on, the adapter's configuration files, its external inputs, and its identity. The core then reuses a file's cached facts while all of those are unchanged and asks you only about the rest. Put in the id anything else the facts depend on: the Python adapter adds a hash of every module path, because a new module can change what an import resolves to. Declare no units and any change reanalyses every file. Facts that depend on more than one unit belong in the `workspace` answer.

## What the core enforces

The core validates every message against the schemas, every range against its captured file, and every reference against a declared symbol. Facts for a file it did not ask about, a resolved relationship without a target, an unresolved one without a reason, or a duplicate symbol each fail the batch, and the snapshot does not publish. Nothing is silently dropped.

Adapters run with a minimal environment (`PATH`, `HOME`, and a log level), and the core restarts a crashed adapter once before failing the index. An adapter has no operation that executes repository code, and must not run build logic: build evaluation is a separate mode a person grants per repository (D14).

## Installing an adapter

Only a person installs an adapter, and installing one is trusting its code: it runs with their permissions whenever a repository with its files is indexed.

```
proofmesh adapter add ./ruby-adapter.mjs --id ruby --extension .rb=ruby --extension .rake=ruby --config Gemfile
proofmesh adapter list
proofmesh adapter remove ruby
```

A `.js` or `.mjs` entry runs on the Node that runs Proofmesh, a `.dll` on .NET, and anything else as an executable. The entry file's hash is recorded at installation; if the file changes, Proofmesh refuses to run it and reports its files as `adapter_changed` until a person installs it again. Ship one bundled file or a small launcher, because only the entry file is hashed. An installed adapter may not take a built-in adapter's name or an extension another adapter analyses.

## The conformance kit

The kit decides whether an adapter's capabilities may be called supported (FR072). Run it on a fixture, with reviewed expected facts when you have them:

```
proofmesh adapter check ruby --fixture fixtures/ruby-basics/repo --expected fixtures/ruby-basics/expected.json
```

| Check | What passes |
|---|---|
| `protocol.initialize` | The adapter answers with a valid manifest, speaks 1.x, and accepts a field it does not know |
| `protocol.workspace` | The adapter answers `workspace` |
| `protocol.analyze` | Facts only for the files asked, and a file result for each |
| `protocol.shutdown` | The adapter answers `shutdown` and exits by itself within 5 seconds |
| `index.publishes` | The core's own indexing accepts every fact and publishes a snapshot |
| `index.deterministic` | Two indexes of the same tree seal the same facts |
| `golden.<section>` | Each section of the expected facts holds exactly, as a closed world |

The expected facts use the format of `fixtures/*/expected.json`: `dispositions` (path to disposition and detail), `symbols` (kind, qualified name, lines, signature), `calls` (from, line, site text, resolution, and the target or reason), `imports`, and `structure`. Write them by hand from the fixture, never from the adapter's output; a fact you did not review is not evidence. For an installed adapter the verdict is recorded and shown by `adapter list`, and lapses when its entry changes.

The built-in TypeScript and C# adapters pass the same kit on their fixtures in every build.

## A minimal adapter

`packages/proofmesh/test/fake-adapters/linelang.mjs` is a complete adapter for a made-up language in about sixty lines: it declares functions, resolves calls by name, and reports the calls it cannot resolve as `unknown_name`. Its fixture and hand-written expected facts are in `fixtures/linelang`.
