# Proofmesh

A local-first code graph for coding agents. Proofmesh indexes a repository on your machine, records every symbol and relationship with the file and line that proves it, and serves the graph to agents over MCP and to people in a browser view called Observatory. It runs no repository code unless you grant it, hosts no model, and calls no network service at run time.

| Status | What |
|---|---|
| Implemented | TypeScript/JavaScript with React, C#, Python, Terraform, Pulumi; the Tree-sitter syntax tier; SCIP ingestion; incremental indexing; strict freshness; MCP tools; claims and verification; Observatory; third-party adapters with a conformance kit |
| Experimental | Cross-repository links, snapshot comparison and replay, table reach, verification execution |
| Planned | See ROADMAP.md |

## Install

Requirements: Node.js 22.13 or later and pnpm 10; the .NET 10 SDK to build the C# adapter. The CLI is not published to a package registry yet, so install it from a clone:

```
git clone https://github.com/QuintinBotes/proofmesh && cd proofmesh
corepack enable            # gives you pnpm if it is not on your PATH
pnpm install --frozen-lockfile && pnpm build    # also builds the C# adapter when dotnet is on PATH
cd packages/proofmesh && npm link && cd ../..    # puts proofmesh on PATH for every shell, Claude Code and the plugin
proofmesh init
proofmesh repo add ~/code/some-repo
proofmesh index ~/code/some-repo
proofmesh view
```

Without pnpm or Corepack on your PATH, run the pinned pnpm through npx instead: `npx --yes pnpm@10.14.0 install --frozen-lockfile && npx --yes pnpm@10.14.0 build`.

`npm link` links this checkout into npm's global bin folder, so a program that does not read your shell's aliases, such as Claude Code or the plugin's MCP server, finds `proofmesh` too, and the updating steps below update it in place. `npm rm -g proofmesh` removes the link.

`pnpm build` ends with `dotnet build adapters/csharp -c Release -m:1` when `dotnet` is on your PATH. Without it the build prints `skipped: build the C# adapter` and C# files are read by the syntax tier; install the .NET 10 SDK and run `pnpm build` again, or run that `dotnet build` yourself. `proofmesh status` lists the adapters this install can run, and for each it cannot, why: for C#, `not built: looked in` and the paths.

`proofmesh repo list` prints every registered repository with the id that tool calls need once more than one is registered. Build-evaluation trust belongs to a registration: a checkout registered again at another path must be trusted again. `proofmesh repo move <repository> <new-path>` re-roots a registration at another working tree of the same git repository and keeps its id, snapshots and trust; `proofmesh index <repository> --rev <commit-ish>` indexes a commit without touching the working tree. Both are described in `docs/proofmesh/operations.md`.

When to use it: call paths through interfaces and dependency injection, framework wiring (routes, handlers, jobs, flags, tables), ownership and impact. Use text search for string literals, configuration values and files outside the indexed languages. Every answer names the snapshot's commit and branch; check them against the branch you care about.

In Observatory, `Control+K`, `⌘K` or `/` opens a command palette: type part of a symbol or file name and press Enter to open it with its evidence, or run a command (switch view, show or hide the Diff overlay, pin a snapshot, trace a path, export). `1` to `6` open the views and `?` lists every key.

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
