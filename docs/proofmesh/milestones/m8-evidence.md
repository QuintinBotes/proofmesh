# M8 evidence: release readiness, built locally

M8 as the goal states it: the npm package and OCI image built locally; SBOM, signing and provenance tooling; evidence bundles and the offline checker; backup, restore and migrations; retention and garbage collection; the open-source files of plan section 14; publication-gate tooling run against a local directory only; A12; A13; and the removal of the predecessor (A15).

Nothing in this milestone publishes: no remote, package or image leaves the machine. Every item below is proven by the test named, and `pnpm verify` runs all of them. `policy/traceability.json` maps each requirement to its tests.

## Items and proof

| Item | Proof |
|---|---|
| `pnpm release:pack`: the core and the two Node adapters as tarballs that install offline into an empty directory and index a fixture from there; the C# adapter's release build is staged into the core package (FR070, NFR007) | `packages/proofmesh/test/release.test.ts` |
| `Dockerfile` and `pnpm release:image`, which builds only when `docker` is present and otherwise reports "unverified" | manual check: `pnpm release:image` |
| `pnpm release:sbom` (CycloneDX over production dependencies), `release:provenance` (a SLSA-style statement whose subjects are the tarballs), `release:sign` and `release:verify` with `ssh-keygen -Y` and a key the person supplies, `release:notices` (generated third-party notices, with `--check`) (NFR013) | `release.test.ts`, `pnpm check:licenses` |
| The open-source files of plan section 14, under `docs/proofmesh/oss/` until A15 moves them to the root | `release.test.ts` |
| Publication gate (D12): `pnpm release:export --out <dir>` exports the Proofmesh paths into a fresh repository with one commit and no remote, then runs the leak scan (emails, hosts, secret patterns, an optional deny list the private overlay keeps); planted hits fail the export | `release.test.ts` |
| Evidence bundles (format 0.1, directory form `.pmb/`): `proofmesh bundle export` writes the manifest, each query's envelope and the evidence it cites, with source bytes only under `--include-source`; `proofmesh bundle check` verifies every hash offline with no catalog (FR032, FR052) | `packages/proofmesh/test/bundle.test.ts` |
| `proofmesh backup <dir>` (SQLite online backup of the catalog plus sealed files and the evidence store, with a hashed manifest) and `proofmesh restore <dir> --into <data-dir>`; a query after restore equals the original (FR050) | `packages/proofmesh/test/backup.test.ts` |
| `proofmesh gc [--keep N] [--dry-run]` retires snapshots beyond the newest N that are not current, pinned (`proofmesh snapshot pin|unpin`, catalog migration 0012) or members of a link file, then deletes evidence objects nothing references (FR051) | `packages/proofmesh/test/gc.test.ts` |
| A12: `pnpm eval` runs headless Claude Code sessions with and without Proofmesh on a golden question set, alike in isolation, records answers, turns, tool calls by name, tokens and reported cost, and scores correctness; it also scores sessions recorded another way | `packages/proofmesh/test/eval.test.ts` |
| A13: `proofmesh mcp-config` for Claude Code and Codex, and the `packages/proofmesh-plugin` Claude Code plugin: a skill that tells agents to ask Proofmesh before grepping and to verify absence claims, five commands (status, index, impact, trace, verify-claim), and freshness hooks that, after an edit and at session start when `proofmesh status --fresh` finds the tree moved on, run one debounced background index per repository; `claude plugin validate` passes | `packages/proofmesh/test/mcp-config.test.ts`, `packages/proofmesh/test/plugin.test.ts` |
| A15: the predecessor, its plugin and the legacy paths removed; the open-source files at the root | `pnpm verify` (the legacy check is gone) |

## Required verification runs

Repeated on 2026-11-12 after three rounds of fixes from a private trial (A31 to A34), on the final tree:

- `pnpm verify`: green (397 unit and integration tests in 87 files, both C# suites, 27 browser tests, licences, schemas, the fixture policy, and traceability, which now requires every MUST requirement, amendment and success criterion to be mapped: 168 automated items and 6 manual checks).
- `pnpm conformance`: every first-party adapter (typescript, csharp, python, terraform, syntax, scip, codeowners, the links contract adapter, the tables rules, the kit on linelang) against its hand-written fixtures; the C# entry now covers 13 fixtures and the TypeScript entry 7.
- `pnpm bench`: `bench/results/bench-2026-11-12T12-37-31-948Z.json`, with the hardware and corpus described inside.
- `docker build`: built on 2026-11-12 with OrbStack's docker (`pnpm release:image`, image `proofmesh:0.1.0`, 478 MB, then 541 MB with the Swift, SQL and Prisma grammars, whose build reads `policy/licenses.json`, now admitted to the image context); the final image also indexes `fixtures/ts-prisma` and `fixtures/syntax-tier` with their oracles' counts; the image prints its version and indexes `fixtures/cs-orders` (C# adapter) and `fixtures/ts-invoicing` mounted read-only, with the oracle's disposition counts. The first build found three defects, fixed: no `.dockerignore` (the context would have carried the gitignored evaluation results; now an allowlist), no toolchain for a native module, and the .NET runtime's system libraries missing; pnpm 10 also needed `deploy --legacy`.
- SC006: Claude Code 2.1.322 and Codex 0.163.0 answered the same snapshot-pinned investigation identically on the final build, matching the fixture oracle (see the manual entry in `policy/traceability.json`).
- The C# adapter's own `dotnet test`: 8 of 8. `dotnet build` (0 warnings, 0 errors) and `dotnet test` (127 of 127) on the old tool's solution pass on the final tree, where the old tool's solution was restored for them (ADR revision 22) and is never exported. Every other change under the M0 legacy paths since the baseline (pre-publication history) is A15's removal, which the maintainer approved on 2026-11-10, plus `scripts/update.mjs`, which Proofmesh added afterwards.
- M1 parity repeated on the final build: 20 of 20.
- `dotnet build` on the old tool's solution: no longer applies; the predecessor was removed with the maintainer's approval (A15).
- The private dogfood checks (goal criterion 6) were repeated on the final build on 2026-11-12: a full index of the private C# repository passing every condition of M0 section 13 that still applies (published; dispositions sum to the files discovered; exclusions per rule; its checkout untouched), the M1 parity checks (20 of 20), and the cross-repository run: a fresh index of the satellite service and a new link file, against which a script reproduces every claim of the findings file's cross-repository section, with every unmatched call one the findings name or one no route serves. Results stay in the gitignored `eval/results/`.

## Measured agent sessions (A12)

Run on 2026-11-12 with Claude Code 2.1.322 and the Sonnet model, one session per question and condition, `--budget-usd` capping each. The cost is what Claude Code reports for the tokens; the sessions ran on a subscription, so nothing was charged. Correctness is the containment proxy described in `docs/proofmesh/operations.md`.

| Set | Condition | Correct | Turns | Tool calls | Tokens | Reported cost |
|---|---|---|---|---|---|---|
| `fixtures/ts-invoicing`, 5 questions | Proofmesh tools offered | 5 of 5 | 14 | 9 (Grep 7, Read 2, Proofmesh 0) | 267,965 | $0.0598 |
| | without | 5 of 5 | 16 | 11 | 291,773 | $0.0637 |
| `fixtures/ts-invoicing`, 5 questions | tools and the plugin's skill | 4 of 5 | 19 | 14 (Proofmesh 2) | 382,768 | $0.2148 |
| | without | 5 of 5 | 15 | 10 | 272,141 | $0.0574 |

A five-question set on a large private C# repository, run the same way, gave the same picture; its figures stay private. On these sets Proofmesh did not help. Every question names a route, a file or a function that text search finds, the agent chose Grep, and offering the tools cost tokens for their descriptions. The one miss with the skill was a hedged answer ("no resolved call sites") that the expected facts did not anticipate; the oracle was left as written. Questions about call paths through interfaces and dependency injection, where text search cannot see the edge, are not yet in a set.

## Known limits

- Signing is SSH-key based locally; keyless signing is documented as the CI path and not exercised.
- The adapters are separate tarballs; until they are on a registry, an install needs `pnpm.overrides` pointing the adapter dependencies at their tarballs, as `docs/proofmesh/release.md` explains.
- A backup copies the data directory's tokens, so a restored directory reuses the same bearer token.
- `gc` reads every kept snapshot's evidence hash list into memory.
- The eval harness measures correctness as case-insensitive containment of expected facts: a hand-checkable proxy, documented as such.
- NFR005's Observatory budgets are published with measurements in `specs/001-proofmesh-foundation/research.md`; both measured snapshots, up to hundreds of thousands of symbols and over a million links, meet them on the final build, after fixes the first measurement called for.
