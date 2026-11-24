# Operations: index progress and jobs, indexing a commit, moving a repository, backup, restore, retention, client configuration

## Index progress and jobs

`proofmesh index` writes a progress line to stderr each time the phase changes, with done and total where they are known: `discover`, `capture`, `initialize` and `analyze` for each adapter, `write` (resolving and writing relationships, with progress every 25,000 of them), `check` (validating the snapshot, filling aggregates and planner statistics) and `seal`. While a phase runs it repeats the latest line every minute, so a long run is never silent; stdout keeps only the summary. The summary adds how long each phase took and the peak resident memory of each adapter process, sampled with `ps` every three seconds and once at the end. Where `ps` is missing the memory line is left out, and processes an adapter starts itself, such as build servers, are not counted.

Every index the CLI runs is an index job, requested by the operating-system user, like the jobs `request_index` starts. `proofmesh status` and `workspace_status` (in `data.jobs`) list the repository's jobs that are queued or running, with start time and phase, and `get_job` reads one. Before a repository has its first snapshot, a tool's `SNAPSHOT_UNAVAILABLE` refusal names the running job and its phase instead. A job is running only while its process holds the index lease, so a job whose process crashed or was killed reads `interrupted` and is no longer listed.

A job records `progress_at`, the last time it reported progress, and `phase_started_at`; a running job reports at least once a minute (capture every thousand files), so a `progress_at` that stops moving means the run is stuck, not slow. `elapsed_ms` is the time since it started, or its whole run once finished. When analysis starts, `plan` says per adapter whether the run is `incremental` or `full`, how many files it re-analyses and how many replay cached facts. A finished job keeps the number of files indexed in `done` and `total`, and its result says how many files were reused and analysed. `get_job` reads the catalog, so it answers before the repository has a snapshot.

## Registered roots

`proofmesh repo add` and `repo list` warn on stderr when a root is under a temporary directory and may disappear, when it no longer exists, and when the registered name differs from the root's directory name; stdout keeps the id or the list. `proofmesh --version` prints the version.

## Indexing a commit

`proofmesh index <repository> --rev <commit-ish>` indexes a commit instead of the working tree. It resolves the name with `git rev-parse --verify <rev>^{commit}`, writes that commit's files into a private directory under the data directory's `staging/` through a temporary index file (`git read-tree`, then `git checkout-index --prefix`), indexes that directory, and deletes it afterwards, also when the index fails. Nothing is written to the registered working tree, its HEAD or its index, and none of its files is read, so uncommitted edits and untracked files stay out of the snapshot. Git LFS files are indexed as their pointer files, since fetching their content could reach the network; submodules are not included.

The snapshot keeps the registered repository's id and becomes current, because it is what the person asked for. Its `commit` is the resolved sha, its `ref` is the branch or tag the name pointed to (`detached` for a sha or an expression such as `HEAD~1`), and `behind_remote` counts how far that commit, not the working tree's HEAD, is behind the remote default branch. `proofmesh status` prints the commit. Strict freshness compares the snapshot with the working tree as always, so while the working tree is elsewhere a strict query is refused as stale and starts an index of the working tree, and `proofmesh watch` re-indexes the working tree on its next check. Installed packages and other external inputs are read from the registered working tree, as for any index.

With `--keep-current`, the repository's current snapshot stays the one it was before; when it had none, the commit's becomes current. `impact_completeness` indexes a commit this way, and so does `proofmesh completeness`, which indexes the head before the base. The index job's result names the commit, which is how a later query finds that commit's snapshot (FR109).

## Moving a repository

`proofmesh repo move <repository> <new-path>` re-roots a registration, for a checkout that moved or a second clone you want to index instead. The new path must be the top of a working tree of the same git repository: it shares the registered root's git directory (`git rev-parse --git-common-dir`), or, when the old root is gone or another clone is named, it holds the commit of the current snapshot. Otherwise the move is refused. The repository keeps its id, and with it its snapshots, notes, observations, SCIP indexes and workspaces. Build-evaluation trust does not move: it was granted for the old checkout, so the move revokes it, and a person grants it again for the new one. The old root can then be registered again with `proofmesh repo add`, as a new repository with another id.

## Backup and restore (FR050)

`proofmesh backup <dir>` copies the catalog through SQLite's online backup API, so it is consistent while a server or watcher runs, then every sealed snapshot, link file, evidence object and token, and writes `backup-manifest.json` with a sha256 per file. Staging files and temporary objects are not backed up.

`proofmesh restore <dir> --into <data-dir>` verifies every hash first and copies nothing if one fails; the target must be empty. The restored directory is a full data directory: queries answer from it at once.

## Retention and garbage collection (FR051)

`proofmesh gc [--keep N] [--dry-run]` keeps the newest N published snapshots per repository (default 3) and retires the rest, deleting their sealed files, then deletes evidence objects no remaining snapshot references. It never retires the current snapshot, a pinned one (`proofmesh snapshot pin <id>`), or a member of a recorded workspace link file, and it refuses to run while an index lease is live. `--dry-run` lists what would go. A retired snapshot keeps its catalog row, so its id still names what existed.

## Client configuration (A13, FR041)

`proofmesh mcp-config [--client claude-code|codex] [--scope project|user]` prints the registration for this installation. It writes only when asked, and only a Claude Code `.mcp.json` (`--write .mcp.json`), keeping the other servers in it. `packages/proofmesh-plugin/` is the Claude Code plugin: a skill that sends agents to Proofmesh before searching by hand, and the MCP registration.

## Evaluation harness (A12)

`pnpm eval -- sessions <set.json> --repo <dir> --data-dir <dir> --out <dir> [--model M] [--budget-usd N]` runs one headless Claude Code session (`claude -p`, streamed output) per question in each of two conditions, in `<repo>`: with Read, Grep, Glob and the Proofmesh MCP tools over `<data-dir>`, and with Read, Grep and Glob only. With `--with-skill`, the first condition also gets the plugin's skill appended to its system prompt, as installing the plugin would give it; without it, an agent offered the tools on a small repository may never call them. Both conditions read no user-level settings, so no personal plugins or hooks run, take MCP servers only from the command line, and keep no session. Each session's own result supplies the answer, turns, tokens (input, cache and output) and the cost Claude Code reports; the stream supplies each tool call by name. The run writes `with.json`, `without.json` and `method.json` (agent version, model, times, isolation, correctness rule) to `<out>`, then scores them.

`pnpm eval -- <set.json> <with.json> <without.json>` scores two recorded sessions again, or sessions recorded some other way. A question is correct when every expected fact, or one of a fact's listed alternatives, appears in the answer, ignoring case: a proxy a reader can check by hand, not a judgment. The report holds only what the sessions recorded.

`bench/eval/samples/ts-invoicing-golden.json` is a public golden set for `fixtures/ts-invoicing`, written by hand from its source; measured runs on it are in `bench/results/eval-ts-invoicing-*`. A private set about a large private repository lives in the gitignored `eval/results/`. On a subscription sign-in, the reported cost is what the same tokens would cost on the API, not a charge.
