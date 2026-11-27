# Proofmesh plugin for Claude Code

A skill that tells agents to call Proofmesh before searching by hand and to verify absence claims; an MCP registration that starts `proofmesh mcp --tools core,data,claims`, the tool profiles its skill and commands call; commands (`/proofmesh:status`, `/proofmesh:index`, `/proofmesh:impact`, `/proofmesh:trace`, `/proofmesh:verify-claim`); and freshness hooks. After an Edit or Write inside a registered repository, and at session start when `proofmesh status --fresh` finds the working tree differs from the snapshot, the hook records the change and one background runner per repository runs `proofmesh index` once edits have been quiet for four seconds; the agent is told that answers are as of the previous snapshot until it publishes. The runner's state and log live under the system temporary directory (`proofmesh-hooks-<uid>`). The plugin needs the `proofmesh` CLI on your PATH, and the CLI is not published to a package registry yet, so install it from a clone first (Node.js 22.13 or later and pnpm 10): `git clone https://github.com/QuintinBotes/proofmesh && cd proofmesh && pnpm install --frozen-lockfile && pnpm build && cd packages/proofmesh && npm link`. Without it the MCP server cannot start, and at session start the hook says `proofmesh: not installed` with that command. This plugin replaces the predecessor's plugin surface.

## Status line and /pm-status (Claude Code 2.1.287 and later)

`hooks/register.mjs` is a hooks module (a [mod](https://code.claude.com/docs/en/plugins/mods/overview)), listed under `modules` in `hooks/hooks.json`; tested with Claude Code 2.1.332. Under the prompt it shows the snapshot's state for the session's repository (the deepest registered root that holds the working directory, as the freshness hook picks it): `proofmesh: current <snapshot id> (<age>)`, `behind (<n> files edited)` after an edit, `indexing <stage>` while the background index runs, `missing`, `not registered here`, `not installed` or `unknown (<reason>)`. While the snapshot is not current it asks `proofmesh status` every 5 seconds, and once a minute while it is, one process at a time; it stops after 10 minutes with no tool call, prompt or command. Sessions with nothing to draw on (`claude -p`, the Agent SDK) show nothing, and the freshness hook still tells Claude as before.

`/pm-status` answers at once, also while Claude is working, and starts no model turn: the state, the repository, the snapshot's id, mode, commit and age, the files edited since, and the adapters that are unavailable. `/proofmesh:status` stays for older Claude Code versions, which ignore `modules`.

## Session trail and /pm-trail (off by default)

The module can record a session trail: what a session searched, opened, changed and claimed. It records nothing until a person runs `proofmesh trail on <repo>` for the repository. `proofmesh trail off <repo>` stops it. The module learns the setting from the `proofmesh status` it already polls, so the change takes effect within a minute, or at once on `/pm-trail`. Once recording is on, it records each completed call of these tools:

- `opened`: Read, ProofMesh's `get_symbol`, and `cat`, `head`, `tail` and `sed -n` run through Bash
- `searched`: Grep, Glob, the other ProofMesh tools, and `grep`, `rg` and `find` run through Bash
- `changed`: Edit, Write, MultiEdit and NotebookEdit
- `claimed`: `verify_claim`

Each entry holds the repository-relative path or symbol id, the tool, the time, the subagent's id if a subagent made the call, and whether the call succeeded. It never holds a pattern, a match, an edit's text or a result. Paths outside the repository are not recorded. A Bash command is recorded only as the paths it names that exist, resolved against the shell's directory, never the command, its pattern or its output. A command the module cannot read with confidence is recorded as nothing: one with a variable, a glob, a redirect, `;` or `&&`, a pipe into anything but `head` or `tail`, an option it does not know, a search that names no path, a path with `..` after a name, `sed` without `-n`, and `find` with `-exec` or `-delete`. At the end of each turn and at session end, the module hands its entries to `proofmesh trail record`, one process for each batch. The entries stay in ProofMesh's local catalog. `proofmesh trail purge` deletes them, and so does `proofmesh gc` after 30 days.

`/pm-trail` answers at once, with no model turn. It lists the trail in order. Then, for each symbol in a file the session changed, it lists the dependents the session never opened, with their `file:line`. A dependent is `never seen`, or `searched only` when a search covered its directory. If recording is off, `/pm-trail` says how to turn it on. If `proofmesh trail record` refused a batch, or could not start, those entries are not sent again, and `/pm-trail` says under its heading how many entries were not recorded and why, for example `# incomplete: 2 entries of this session were not recorded (<reason>)`. MCP clients get the same answer from `get_session_trail`, in the `data` profile.

## Impact pane and /pm-impact

`/pm-impact` opens a pane beside the transcript, and closes it if it is open. The pane never opens by itself. It lists what the session's edits reach, grouped by file:

- each symbol the session changed (`changed formatAmount line 1`)
- under it, each dependent from `analyze_impact`: the relationship type, the name, the `file:line` of the site that reaches the change, the evidence class (`resolved`, or `inferred` when a hop of the chain is), the depth, and the answer's notes, such as a truncation
- the tests from `find_tests` that reach it, or `no test reaches it`

The module finds the changed symbols from the line numbers in each edit's result (its patch, without the context lines), never from the files' text. Once a snapshot with the edits is current, it asks `get_symbols_at` for those lines, then `analyze_impact` and `find_tests` once per changed symbol. All three are in the `core` profile. Ten edits before one snapshot cost one question per symbol, and no tool call waits on ProofMesh. A symbol whose body is the same as before the session's first edit of its file is left out, so an undone edit leaves the list. In a session with nothing to draw on, a file first edited before the first `/pm-` command has no such baseline, so an undone edit there stays listed. While the snapshot is behind the edits, the pane keeps the last answer, marked `behind`, and asks again when the next snapshot is published.

At most 20 changed symbols are shown, then a count. An edited file no adapter reads, or one outside the repository, is listed as `not indexed` with the reason. A ProofMesh call that fails is one row, `impact: unknown (<reason>)`. Running `/pm-impact` again, to close and reopen the pane, asks again. With the session trail on, each dependent in a file the session never opened is marked `not opened`, and the count heads the list.

Pressing a dependent's row, or its `open` button, copies its `file:line`. The `file:line` is not a link: the Desktop app links only `https:` and `http://localhost` addresses. In a session with nothing to draw on (`claude -p`, the Agent SDK), `/pm-impact` prints the same list as text. Like `/pm-status`, it answers at once and starts no model turn.

Run the module's tests with `pnpm test:plugin` (`claude plugin test packages/proofmesh-plugin`).
