# Verification execution (D07, Gate D)

Off by default. Read tools never run anything (FR042). When a person enables it for a data directory, an agent may *prepare* a verification recipe, and only a person may approve and run it, once.

```
proofmesh verification enable
# agent: prepare_verification { command: ["pnpm","test","--","invoice"], timeout_s: 300 }  →  vr_…
proofmesh verification approve vr_…      # prints the binding it approves
proofmesh verification run vr_… [--container node:22]
# agent: get_verification { verification_id: "vr_…" }  →  state, signed record, output
```

What an approval binds (FR044): the snapshot, the exact argv, the working directory, the environment allowlist (PATH always passes), network `none`, time, memory and output limits, the toolchain versions read at preparation, the workspace and filesystem policy, and an expiry (default 15 minutes). The binding's hash is checked at approval and again at run; a changed, expired, unapproved or already-consumed verification is refused (FR045).

The run (FR046) happens in the host-side launcher, a code path the query and MCP layers never import (a test enforces it). The launcher marks the approval consumed before anything starts, exports the snapshot's captured files from the evidence store into a fresh directory under the data directory, runs the command there with the time and output caps, deletes the copy, and signs a run record with the installation key: argv binding hash, start and end, exit code or signal, output hash, truncation, and the sandbox used. `get_verification` reports whether the record verifies.

Limitations (FR047): without `--container`, the run is a plain process. Time and output are limited; network and filesystem policy are policy, not enforcement, and the record says `sandbox: process`. With `--container IMAGE`, the launcher runs `docker run --rm --network none --read-only --memory …` with the workspace mounted at `/work`; containers are not perfect sandboxes (D07). Never run a hostile repository on a sensitive host because limits exist. The query service never talks to a container runtime (FR048): only the launcher invokes `docker`, and only when a person asks.
