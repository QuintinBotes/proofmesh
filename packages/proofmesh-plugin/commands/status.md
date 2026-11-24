---
description: Show what Proofmesh knows about this repository and whether its snapshot matches the working tree
allowed-tools: Bash(proofmesh status:*)
---

Run `proofmesh status --fresh` and then `proofmesh status` for the repository in the current directory. Report in a few sentences: the snapshot id and commit, whether it matches the working tree (and the changed files if not), files indexed against those excluded or unsupported, the unresolved call count by reason, and any index job running. If the snapshot is behind, suggest /proofmesh:index.
