# Finding and cloning related repositories (A10)

`proofmesh discover --anchor <repository> [--org ORG] [--limit N] [--json]` ranks GitHub repositories related to a repository you have indexed, the anchor, by the evidence in its current snapshot: the packages it depends on, the services it calls, the channels it publishes or consumes, and the first segment of each endpoint path. Each term becomes read-only `gh` queries. With `--org`, every query carries `--owner ORG` and nothing outside that organization is searched. At most 20 terms are searched per run.

- A package or a service maps to one repository by name: a repository whose name equals the term, else one whose name holds every token of it (`order-sync` matches `order-sync-service`, and `inv-sync` matches `inventory-sync-worker`), found with `gh search repos`. A service that maps to no name falls back to `gh search code` for its name.
- Channels and endpoint roots are found by `gh search code`. When the anchor's checkout has a GitHub `origin` remote, every code search excludes the anchor with `-repo:OWNER/NAME`, so the anchor's own matches cannot fill the result cap, and the anchor is never a candidate. Without such a remote the output says that the anchor could not be excluded.
- A candidate's score is the number of distinct terms that led to it, and its evidence says how each term reached it: `exact_name`, `name_tokens`, or `code_search` with the hit count. Ties on score and hits prefer a non-empty repository, then the most recently pushed, then the name; `gh api repos/OWNER/NAME` is called only for candidates tied near the cut, to read their size and push time.

`proofmesh clone <owner/repo> --into <dir> [--add [--workspace NAME]]` runs `gh repo clone` for one repository into `<dir>/<repo>`, and with `--add` registers it, optionally into a workspace. Cloning is always this explicit, per-repository command; `discover` never clones.

These two commands are the only place Proofmesh talks to the network, and only when a person runs them. `gh` must be on `PATH` and signed in; without it the commands fail before any other step.
