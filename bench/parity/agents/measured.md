# Direct callers on TypeORM

Fixture 3d55188c0dd1256f520143379ecf97f45e71acba. 5 warm queries per target. Complete MCP reply costs use o200k_base.

| Tool | Question | Correct / returned / expected callers | Correct / returned / expected sites | p50 / p95 ms | Bytes | Tokens |
|---|---|---|---|---|---|---|
| gortex | Q1 (answered) | 48/48/48 | 48/48/54 | 1221.9 / 1226.6 | 54678 | 13915 |
| gortex | Q2 (answered) | 29/29/78 | 29/29/83 | 1789.9 / 1791.4 | 34840 | 8571 |
| gortex | Q3 (target_missing) | 0/0/18 | 0/0/19 | 9.1 / 9.2 | 4995 | 1120 |
| gitnexus | Q1 (answered) | 48/48/48 | 0/0/54 | 6.1 / 7.5 | 3389 | 936 |
| gitnexus | Q2 (answered) | 78/78/78 | 0/0/83 | 5.9 / 7.1 | 5553 | 1438 |
| gitnexus | Q3 (answered) | 6/9/18 | 0/0/19 | 3.7 / 5 | 1086 | 313 |
| codebase-memory-mcp | Q1 (answered) | 48/48/48 | 48/48/54 | 33.6 / 37.9 | 7146 | 1843 |
| codebase-memory-mcp | Q2 (answered) | 2/2/78 | 2/2/83 | 35 / 38.4 | 1248 | 355 |
| codebase-memory-mcp | Q3 (target_missing) | 0/0/18 | 0/0/19 | 17.4 / 18.8 | 524 | 129 |

## Index and discovery costs

| Tool | Index to ready (ms) | Sampled peak RSS (MiB) | Listed tools | Schema bytes | Schema tokens |
|---|---:|---:|---:|---:|---:|
| gortex | 2732 | 1182.4 | 21 | 15200 | 3485 |
| gitnexus | 8003 | 1859.6 | 17 | 70227 | 15819 |
| codebase-memory-mcp | 2622 | 107.3 | 17 | 20824 | 4845 |

## Source audit

A saved edit moved the Q1 call in Entity.ts from line 34 to 35 immediately before the stale-source query.

| Tool | Q1 caller matched | Q1 caller and site matched | Old line returned after edit | New line returned after edit |
|---|---|---|---|---|
| gortex | true | true | true | false |
| gitnexus | true | false | false | false |
| codebase-memory-mcp | true | true | true | false |

Only a complete, exact caller-and-site answer qualifies for an answer-cost comparison. Raw replies, commands and every missing or extra site are in the JSON files.

Question classes pending adapter coverage: Q4, Q5, Q6, Q7, Q8, Q9, Q10, Q11, Q12, Q13.
