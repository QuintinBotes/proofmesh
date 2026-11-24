# Proofmesh

A local-first code graph for coding agents. Proofmesh indexes a repository on your machine, records every symbol and relationship with the file and line that proves it, and serves the graph to agents over MCP and to people in a browser view called Observatory. It runs no repository code unless you grant it, hosts no model, and calls no network service at run time.

| Status | What |
|---|---|
| Implemented | TypeScript/JavaScript with React, C#, Python, Terraform, Pulumi; the Tree-sitter syntax tier; SCIP ingestion; incremental indexing; strict freshness; MCP tools; claims and verification; Observatory; third-party adapters with a conformance kit |
| Experimental | Cross-repository links, snapshot comparison and replay, table reach, verification execution |
| Planned | See ROADMAP.md |

## Install

Requirements: Node.js 22.13 or later and pnpm 10; the .NET 10 SDK to build the C# adapter.

```
corepack enable            # gives you pnpm if it is not on your PATH
pnpm install --frozen-lockfile && pnpm build
dotnet build adapters/csharp -c Release    # only for C# repositories
alias proofmesh="node $PWD/packages/proofmesh/bin/proofmesh.mjs"
proofmesh init
proofmesh repo add ~/code/some-repo
proofmesh index ~/code/some-repo
proofmesh view
```

Without pnpm or Corepack on your PATH, run the pinned pnpm through npx instead: `npx --yes pnpm@10.14.0 install --frozen-lockfile && npx --yes pnpm@10.14.0 build`.

`proofmesh repo list` prints every registered repository with the id that tool calls need once more than one is registered. Build-evaluation trust belongs to a registration: a checkout registered again at another path must be trusted again. `proofmesh repo move <repository> <new-path>` re-roots a registration at another working tree of the same git repository and keeps its id, snapshots and trust; `proofmesh index <repository> --rev <commit-ish>` indexes a commit without touching the working tree. Both are described in `docs/proofmesh/operations.md`.

When to use it: call paths through interfaces and dependency injection, framework wiring (routes, handlers, jobs, flags, tables), ownership and impact. Use text search for string literals, configuration values and files outside the indexed languages. Every answer names the snapshot's commit and branch; check them against the branch you care about.

Connect Claude Code from inside the repository: `claude mcp add -s project proofmesh -- proofmesh mcp`.

## Updating

From the checkout:

```
git pull
node scripts/update.mjs    # or: pnpm update:all
proofmesh repo list        # then, for each repository:
proofmesh index <repository>
```

`scripts/update.mjs` runs `pnpm install --frozen-lockfile`, `pnpm build` and `dotnet build adapters/csharp -c Release`, in that order, and stops at the first step that fails; a checkout it stopped on is not updated. Without pnpm on your PATH it enables it through Corepack first (`corepack enable pnpm`). With neither pnpm nor Corepack it runs nothing and prints the commands to run instead, the same ones you would run by hand:

```
npx --yes pnpm@10.14.0 install --frozen-lockfile
npx --yes pnpm@10.14.0 build
dotnet build adapters/csharp -c Release
```

Without `dotnet` the C# adapter step is skipped when the adapter was never built, and fails when an earlier build exists, since that build would keep running against the new core. Re-index after updating: an adapter's code is part of snapshot identity, so the next index publishes a snapshot from the new build instead of reusing the old one.

Documentation: `docs/proofmesh/` (architecture, languages and their capabilities, adapter authoring, release process). Contributing: CONTRIBUTING.md. Security: SECURITY.md. License: Apache-2.0 (LICENSE, NOTICE, THIRD_PARTY_NOTICES.md).
