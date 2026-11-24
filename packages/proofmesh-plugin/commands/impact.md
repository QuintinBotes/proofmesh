---
description: What changing a symbol affects, and which tests reach it, from the Proofmesh graph
argument-hint: <symbol name>
---

Find the symbol named `$ARGUMENTS` with the Proofmesh `find_symbols` tool; if several match, list them and ask which one. For the chosen symbol call `analyze_impact` and `find_tests`. Report the affected symbols grouped by file with the line each fact cites, the tests that reach it, and every limitation, horizon and truncation the envelopes name. Say that this is static reach, not observed behaviour, and name the snapshot it is as of.
