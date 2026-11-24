---
description: How one symbol reaches another, traced in the Proofmesh graph with evidence for each hop
argument-hint: <from symbol> <to symbol>
---

The arguments name two symbols: `$ARGUMENTS`. Resolve each with the Proofmesh `find_symbols` tool, asking when a name is ambiguous. Call `trace_paths` from the first to the second with `envelope: "compact"`, since a lean answer carries no rules. Show each path hop by hop with its relationship type, its rule or resolution when not a plain resolved call, and the file and line it cites. If no path was found, say whether the search hit a limit or a boundary, which is not the same as no path existing, and call `verify_claim` before saying there is none.
