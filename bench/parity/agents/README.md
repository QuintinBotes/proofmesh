# Comparing direct callers on TypeORM

Run `pnpm install --frozen-lockfile` at the repository root and put the three pinned executables on PATH. Run `node bench/parity/agents/run.mjs` on macOS or Linux. Each run writes its own directory under `bench/parity/out/agents/`. Set `PARITY_AGENT_OUT` to choose another parent. The runner names a missing executable or a version mismatch in both reports and continues with the other tools.

| Comparator | Pinned release | Optional executable override |
|---|---|---|
| Gortex | 0.64.11 | `PARITY_GORTEX` |
| GitNexus | 1.6.12 | `PARITY_GITNEXUS` |
| Codebase-Memory | 0.12.1 | `PARITY_CODEBASE_MEMORY_MCP` |

Use the upstream Gortex and Codebase-Memory binaries for your platform and verify their release checksums. GitNexus is available as `gitnexus@1.6.12` on npm. On the measurement Mac its LadybugDB binary required the OpenSSL 3 libraries. The run used the Homebrew 3.5.9 bottle through a process-local `DYLD_LIBRARY_PATH`. [Gortex release](https://github.com/zzet/gortex/releases/tag/v0.64.11) · [GitNexus release](https://github.com/abhigyanpatwari/GitNexus/releases/tag/v1.6.12) · [Codebase-Memory release](https://github.com/DeusData/codebase-memory-mcp/releases/tag/v0.12.1)

Each comparator receives a clean clone of the same TypeORM fixture. The runner checks the upstream commit, source tree and compiler configuration against the frozen identities. It computes the existing TypeScript-checker oracle before launching a comparator and verifies the hand-reviewed positive and negative sites. Configurations and indexes live in temporary directories. The run uses the embedded Gortex MCP server with semantic enrichment off, GitNexus's local index with FTS and embeddings off, and Codebase-Memory's local index with cross-language LSP disabled. Index and query commands are recorded. The saved run abbreviates temporary paths as `<repo>` and `<cache>`.

For complete replies, the machine-readable files for each tool and question contain the MCP requests, responses and normalized facts. `results.json` records separate counts and the full missing and extra sets for callers, sites, and caller/site pairs. An unresolved target is an abstention; a resolved target may have zero incoming calls. The stale-source check inserts a comment before the audited call and immediately asks the same question again. It captures what a client sees at that moment, including the possibility that the tool reports only caller identities.

Cold time runs from launching the indexer through graph readiness and MCP initialization. The RSS sampler sums resident memory of the index processes and their descendants at 50 ms intervals, including workers running the benchmark's private Codebase-Memory executable. Shared pages can count more than once, and peaks between samples may be missed. Tool discovery is measured separately. After one warm-up, each target gets five queries by default (`PARITY_RUNS` changes the count). The p50 and p95 are nearest-rank wall times for the complete retrieval, including target lookup. Repeated queries must return the same normalized facts. Reply bytes and o200k_base tokens cover every complete MCP result in a retrieval, including explanatory text; requests and framing are excluded.

On November 28, 2026, two fresh runs on macOS arm64 agreed on all nine tool/question combinations. Only exact caller/site answers qualify for comparing answer cost. No tool met that bar on these three questions. [Per-question results and source audit](measured.md) · [Missing and extra results](measured.json) · [Reviewed sites](reviewed.json)
