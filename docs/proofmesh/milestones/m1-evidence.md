# M1 evidence: the C# adapter, trust modes, the private overlay, and parity

M1 as the goal states it: the C# adapter re-hosted from the predecessor's Roslyn indexer behind the adapter protocol; no-execution and trusted-build modes with trust granted only through the CLI (D14); codebase-specific rules, notes, and evaluation questions moved into a private overlay in its own local repository; and a parity run on the large private C# codebase the predecessor indexes, against its evaluation sets, with results only in `eval/results/`. Removing the old tool (plan M1.7) moved to M8 under amendment A15.

Every item below is proven by the test named, and `pnpm verify` runs all of them. `policy/traceability.json` maps each requirement to its tests.

## Items and proof

| Item | Proof |
|---|---|
| Snapshot format 0.2, the adapter registry, and CLI-only trust grants (D14, FR081) | `packages/proofmesh/test/cli.e2e.test.ts` |
| C# adapter on Roslyn, no-execution and trusted-build modes (FR077, FR079, FR080) | `packages/proofmesh/test/csharp.golden.test.ts` |
| The adapter's own unit tests in `pnpm verify` | `adapters/csharp/test/` |
| A file linked into several projects is indexed once | `packages/proofmesh/test/csharp.golden.test.ts` (`cs-linked`) |
| Built-in framework rules for widely used .NET frameworks: EF, ASP.NET Core attribute and conventional routes, DI, MediatR, Kafka, Refit, hosted services, configuration (A14) | `packages/proofmesh/test/csharp.frameworks.test.ts`, `packages/proofmesh/test/csharp.dotnet-frameworks.test.ts`, `packages/proofmesh/test/csharp.mvc-routes.test.ts` |
| Rules extensions installed only through the CLI, recorded by hash, refused once changed (A14) | `packages/proofmesh/test/cli.e2e.test.ts` |
| The adapter build and every extension's hash in snapshot identity (NFR004) | `packages/proofmesh/test/csharp.golden.test.ts` |
| References flow transitively, as MSBuild flows them | `packages/proofmesh/test/csharp.golden.test.ts` (`cs-transitive`) |
| Shared registries extensions report into: DI registrations and request dispatch | `adapters/csharp/test/ServiceRegistryTests.cs`, `adapters/csharp/test/DispatchRegistryTests.cs` |
| Impact follows interface dispatch from an implementation to its callers | `packages/proofmesh/test/impact.test.ts` |
| Inbound candidate and ambiguous callers are relationships (A18) | `packages/proofmesh/test/candidates.test.ts` |
| A symbol kind for downstream services, snapshot format 0.3 (A17) | `packages/proofmesh/test/services.test.ts` |
| Packages a `Directory.Build.props` file adds to every project | `packages/proofmesh/test/csharp.golden.test.ts` (`cs-inherited`) |

## The private overlay

Codebase-specific rules, notes, evaluation questions, and the parity harness live in a separate local repository with no remote, built as a rules extension that a person installs through the CLI (A14). Its fixture is checked against a hand-written oracle with decoys that must produce no facts. None of it is in this repository.

## Parity

Plan section 15 defines parity as answering the predecessor's question sets at least as correctly as the old tool. The run used the predecessor's automated checks, its golden questions judged by hand against answers verified in the source, and its agent arm. Results are kept in `eval/results/`, outside version control, because they describe a private codebase.

Parity is met on all three question sets, on the final snapshot built with the packages restored:

- The predecessor's automated checks all pass, including the outgoing service call that needed the `service` kind (A17).
- On the golden questions, Proofmesh answers every question at least as well as the predecessor. The questions where the predecessor first answered better (configuration readers, message queues and topics, dispatch through a custom framework, and downstream services) were closed by overlay rules and A17 and A18, and re-judged by hand. One question needs M6's snapshot diff.
- The agent arm answered every question correctly with Proofmesh connected over MCP, but its agent never called a Proofmesh tool, so it measures the model and text search, not Proofmesh. The predecessor's plugin pointed its agent at the graph from a hook; the M8 plugin needs the same.

The result files are `proofmesh-m1-parity-*.json`, `proofmesh-m1-golden-evidence-*.json`, `proofmesh-m1-golden-judgments-*.json`, `proofmesh-m1-golden-baseline-*.json`, and `proofmesh-agent-*.jsonl`, all in `eval/results/`.

Two loader gaps surfaced during the run and are fixed with fixtures: a package added to every project by a `Directory.Build.props` file was ignored (fixture `cs-inherited`), and an implementation reached through its interface was cut off from impact (`packages/proofmesh/test/impact.test.ts`).

## Amendments made during M1

A14 (rules extensions), A15 (the predecessor stays until M8), A17 (the `service` kind), and A18 (inbound candidate callers) are recorded in `docs/proofmesh/adr/0001-proofmesh.md`, section 10.

## Known limits

- An implementation inherited from a base class is not linked to the interface member it implements.
- The C# adapter in trusted-build mode declares no units, so any change reanalyses every file there.
- Agents connected over MCP did not call Proofmesh unprompted in the agent arm; the M8 plugin needs a prompt that points them to it, as the predecessor's plugin had.
