# Graph queries on TypeORM

Fixture 3d55188c0dd1256f520143379ecf97f45e71acba. 5 warm queries per target. Complete MCP reply costs use o200k_base.

| Tool | Question | Correct / returned / expected callers | Correct / returned / expected sites | p50 / p95 ms | Bytes | Tokens |
|---|---|---|---|---|---|---|
| gortex | Q1 (answered) | 48/48/48 | 48/48/54 | 1284.2 / 1284.8 | 54678 | 13915 |
| gortex | Q2 (answered) | 29/29/78 | 29/29/83 | 1882.7 / 1910.1 | 34840 | 8571 |
| gortex | Q3 (target_missing) | 0/0/18 | 0/0/19 | 9.8 / 10.1 | 4995 | 1120 |
| gitnexus | Q1 (answered) | 48/48/48 | 0/0/54 | 6.2 / 7.6 | 3389 | 936 |
| gitnexus | Q2 (answered) | 78/78/78 | 0/0/83 | 5.8 / 6 | 5553 | 1438 |
| gitnexus | Q3 (answered) | 6/9/18 | 0/0/19 | 5.2 / 7 | 1086 | 313 |
| codebase-memory-mcp | Q1 (answered) | 48/48/48 | 48/48/54 | 32.2 / 32.5 | 7146 | 1843 |
| codebase-memory-mcp | Q2 (answered) | 2/2/78 | 2/2/83 | 31.8 / 32.2 | 1248 | 355 |
| codebase-memory-mcp | Q3 (target_missing) | 0/0/18 | 0/0/19 | 16.1 / 16.7 | 524 | 129 |

## Relationship queries

| Tool | Question | Correct / returned / expected items | Exact | p50 / p95 ms | Bytes | Tokens |
|---|---|---|---|---|---|---|
| gortex | Q4 implementations (answered) | 11/11/12 | false | 4.1 / 5.1 | 7435 | 1837 |
| gortex | Q5 importers (answered) | 71/71/72 | false | 2293.4 / 2311.5 | 76235 | 19573 |
| gortex | Q7 transitive_callers (answered) | 9/9/11 | false | 483.1 / 490.4 | 16950 | 4040 |
| gortex | Q9 type_users (answered) | 85/85/85 | true | 19.2 / 20 | 218915 | 50514 |
| gitnexus | Q4 implementations (answered) | 12/12/12 | true | 5.1 / 5.3 | 1338 | 406 |
| gitnexus | Q5 importers (answered) | 70/70/72 | false | 5 / 5.1 | 3970 | 1100 |
| gitnexus | Q7 transitive_callers (answered) | 11/17/11 | false | 14.1 / 14.2 | 4393 | 1126 |
| gitnexus | Q9 type_users (answered) | 0/0/85 | false | 4.9 / 5 | 517 | 155 |
| codebase-memory-mcp | Q4 implementations (answered) | 12/12/12 | true | 31 / 31.5 | 2436 | 691 |
| codebase-memory-mcp | Q5 importers (answered) | 72/72/72 | true | 28.5 / 29.7 | 7768 | 1959 |
| codebase-memory-mcp | Q7 transitive_callers (answered) | 11/11/11 | true | 78.9 / 79.9 | 7394 | 2103 |
| codebase-memory-mcp | Q9 type_users (answered) | 85/85/85 | true | 31.4 / 33.2 | 8768 | 2276 |

## Index and discovery costs

| Tool | Index to ready (ms) | Sampled peak RSS (MiB) | Listed tools | Schema bytes | Schema tokens |
|---|---:|---:|---:|---:|---:|
| gortex | 2726 | 1264.8 | 21 | 15200 | 3485 |
| gitnexus | 7889 | 1848.4 | 17 | 70227 | 15819 |
| codebase-memory-mcp | 2686 | 117.1 | 17 | 20824 | 4845 |

## Source audit

A saved edit moved the Q1 call in Entity.ts from line 34 to 35 immediately before the stale-source query.

| Tool | Q1 caller matched | Q1 caller and site matched | Old line returned after edit | New line returned after edit |
|---|---|---|---|---|
| gortex | true | true | true | false |
| gitnexus | true | false | false | false |
| codebase-memory-mcp | true | true | true | false |

Only exact, untruncated answers qualify for comparing costs within a question. Direct-caller questions also require exact caller/site pairs. The JSON files contain the raw replies, commands, audits and every missing or extra fact.

Question classes pending adapter coverage: Q6, Q8, Q10, Q11, Q12, Q13.
