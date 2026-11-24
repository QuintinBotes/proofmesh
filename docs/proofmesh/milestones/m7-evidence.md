# M7 evidence: verification execution, off by default

M7 as the goal states it: verification execution (D07, Gate D): `prepare_verification`, bound one-time approvals, the host-side launcher, disposable constrained jobs, and authenticated run records. Disabled by default.

Every item below is proven by `packages/proofmesh/test/verification.test.ts`, which `pnpm verify` runs; `policy/traceability.json` maps FR042 to FR048 to it. The operating guide is `docs/proofmesh/verification.md`.

## What was built

| Item | Where |
|---|---|
| `proofmesh verification enable|disable`: a catalog setting a person flips; both tools refuse until it is on | `src/cli/verification.ts`, catalog migration 0011 (`setting`, `verification`) |
| `prepare_verification`: pins snapshot, recipe (command, cwd, environment allow-list, timeout, memory and output caps), toolchain versions, environment and network policy, expiry (15 minutes by default) and limits into a binding, hashed; it runs nothing | `src/verification/prepare.ts`, `binding.ts`, `schemas/tools/prepare_verification.*` |
| `proofmesh verification approve <id>`: a person approves one binding, once; expired bindings are refused | `src/cli/verification.ts` |
| `proofmesh verification run <id>`: the host-side launcher revalidates the binding hash, marks the verification consumed before anything runs (no replay), exports the snapshot's captured files into a disposable directory, runs the command with the reduced environment, timeout kill and output cap, and deletes the copy; `--container IMAGE` runs it under `docker run --rm --network none --read-only --memory` when docker is present | `src/verification/launcher.ts` |
| An authenticated run record: canonical JSON of the verification id, binding hash, times, exit code, output hash and truncation, signed with an HMAC under the installation key cursors use; `get_verification` verifies it and reports `record_valid` | `src/verification/binding.ts`, `schemas/tools/get_verification.*` |
| The MCP server and the query layer never import the launcher: a module-boundary test enforces it | `verification.test.ts` |

State machine: `prepared → approved → consumed → finished | failed`, with `expired` computed from the clock on read.

## Known limits

- Without `--container`, network and filesystem limits are policy, not enforcement; the run record says `sandbox: process`, and `get_verification` adds a limitation saying so. Containers are not perfect sandboxes either (D07).
- The docker path is untested here: no test requires docker.
- `prepared_by` is `tool`, because an MCP caller has no identity; the approver is the operating-system user.
- `cwd` is refused only when it contains `..` segments.
