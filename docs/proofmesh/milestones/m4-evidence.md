# M4 evidence: Python, Terraform, Pulumi, SCIP, and adapters from anyone

M4 as the goal states it: the Python semantic-engine spike and the Python adapter, the Terraform adapter, adapter protocol 1, the public conformance kit and authoring guide, the Tree-sitter syntax tier, Pulumi framework rules, and SCIP ingestion.

Every item below is proven by the test named, and `pnpm verify` runs all of them. `policy/traceability.json` maps each requirement to its tests, and `pnpm check:traceability` checks the mapping. `docs/proofmesh/languages.md` is the capability statement for each ecosystem (FR077).

## Items and proof

| Item | Proof |
|---|---|
| Adapter protocol 1: 0.3 frozen under semantic versioning; a newer 1.x adapter's unknown fields are stripped, another major version is refused (A22) | `packages/proofmesh/test/adapter-host.test.ts` |
| Adapters for other languages, installed by a person and pinned by the hash of their entry file; the conformance kit and `proofmesh adapter check`; the authoring guide (US18, FR071, FR072, SC014) | `packages/proofmesh/test/adapter-install.test.ts`, `packages/proofmesh/test/conformance.test.ts` |
| The Tree-sitter syntax tier on WebAssembly for ten languages, with pinned grammars (A6, A23) | `packages/proofmesh/test/syntax-tier.test.ts` |
| The Terraform adapter and snapshot format 0.5 (A8, A25) | `packages/proofmesh/test/terraform.test.ts` |
| The Python adapter on Pyright, with import-graph units (A16, A2, D14) | `packages/proofmesh/test/python.test.ts`, `packages/proofmesh/test/incremental.test.ts` |
| Pulumi resources, references and `depends_on` from TypeScript, Python and C# programs, named alike (A8, A25) | `packages/proofmesh/test/pulumi.test.ts`, `packages/proofmesh/test/python.frameworks.test.ts`, `packages/proofmesh/test/csharp.pulumi.test.ts` |
| SCIP indexes a person produced, covering only what no semantic adapter covers, and stale per file (A24, A27) | `packages/proofmesh/test/scip.test.ts` |
| An adapter's own code is part of snapshot identity and of every cache key (NFR004) | `packages/proofmesh/test/incremental.test.ts` |
| Empty files have no symbol in the Tree-sitter adapters | `packages/proofmesh/test/syntax-tier.test.ts` |

## The Python spike

Recorded in `specs/001-proofmesh-foundation/research.md`: the spike on a private Python service, the defects it found, and why Pyright was chosen over the fallback.

## Amendments made during M4

A22 to A27, revisions 11 to 13 of the ADR, each decided by the maintainer: protocol 1 under semantic versioning; Tree-sitter on WebAssembly; SCIP files produced by a person; symbol kinds for infrastructure code; the link from cloud resources to services moved to M6; and how a SCIP index meets first-party adapters and goes stale.

## Known limits

- Swift and SQL joined the syntax tier later, built reproducibly from their packages' source because those ship no WebAssembly (`packages/proofmesh/test/syntax-tier.test.ts`); Prisma schemas too (`packages/proofmesh/test/prisma.test.ts`).
- Python asks Pyright for each call site's definition, so a cold index of a large service takes minutes, and an edit to a module much of the service imports reanalyses everything that imports it.
- A `.pth` directory outside the repository is not searched, so what it holds resolves as `outside_capability`.
- If the core kills the Python adapter, the temporary site-packages view it made is left in the system's temporary directory; it holds only links.
- SCIP does not tell a call from another reference, so SCIP files report references and no calls.
- TypeScript prints a union type's members in the order its checker created them, so a rule that asks for types earlier can reorder signatures. Output is the same for the same build; the build is part of identity.
- No separate Galaxy rendering spike was recorded, and frame and interaction budgets (NFR005) are still to be published.
- The link from cloud resources to services is M6 work (A26).
