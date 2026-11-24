---
description: Index this repository now, so Proofmesh answers from the working tree as it stands
allowed-tools: Bash(proofmesh index:*), Bash(proofmesh status:*)
---

Run `proofmesh index .` from the repository root and wait for it to finish; a large repository can take minutes. Then run `proofmesh status --fresh` and report the new snapshot id, how many files were indexed, and whether it now matches the working tree. If indexing fails, show the error as printed.
