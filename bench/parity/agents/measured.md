# Graph queries on TypeORM

Fixture 3d55188c0dd1256f520143379ecf97f45e71acba. 5 warm queries per target. Complete MCP reply costs use o200k_base.

| Tool | Question | Correct / returned / expected callers | Correct / returned / expected sites | p50 / p95 ms | Bytes | Tokens |
|---|---|---|---|---|---|---|
| gortex | Q1 (answered) | 48/48/48 | 48/48/54 | 1237.7 / 1319.9 | 54678 | 13915 |
| gortex | Q2 (answered) | 29/29/78 | 29/29/83 | 1846.6 / 1972 | 34840 | 8571 |
| gortex | Q3 (target_missing) | 0/0/18 | 0/0/19 | 10.2 / 10.8 | 4995 | 1120 |
| gitnexus | Q1 (answered) | 48/48/48 | 0/0/54 | 6.5 / 7.2 | 3389 | 936 |
| gitnexus | Q2 (answered) | 78/78/78 | 0/0/83 | 5.8 / 5.9 | 5553 | 1438 |
| gitnexus | Q3 (answered) | 6/9/18 | 0/0/19 | 5 / 7 | 1086 | 313 |
| codebase-memory-mcp | Q1 (answered) | 48/48/48 | 48/48/54 | 29.5 / 32.6 | 7146 | 1843 |
| codebase-memory-mcp | Q2 (answered) | 2/2/78 | 2/2/83 | 30.9 / 31.6 | 1248 | 355 |
| codebase-memory-mcp | Q3 (target_missing) | 0/0/18 | 0/0/19 | 15.2 / 16.5 | 524 | 129 |

## Relationship queries

| Tool | Question | Correct / returned / expected items | Exact | p50 / p95 ms | Bytes | Tokens |
|---|---|---|---|---|---|---|
| gortex | Q4 implementations (answered) | 11/11/12 | false | 4.6 / 4.9 | 7435 | 1837 |
| gortex | Q5 importers (answered) | 72/72/72 | true | 239.1 / 240.3 | 2244705 | 832354 |
| gortex | Q6 dependents (answered) | 310/310/316 | false | 230.1 / 231.1 | 2244705 | 832354 |
| gortex | Q7 transitive_callers (answered) | 9/9/11 | false | 464 / 467.9 | 16950 | 4040 |
| gortex | Q9 type_users (answered) | 85/85/85 | true | 18.8 / 19.3 | 218915 | 50514 |
| gortex | Q11 cycles (answered) | 291/291/300 | false | 230.7 / 231.9 | 2244705 | 832354 |
| gortex | Q12 roots (answered) | 7/10/7 | false | 230.8 / 232.6 | 2244705 | 832354 |
| gitnexus | Q4 implementations (answered) | 12/12/12 | true | 5.1 / 5.2 | 1338 | 406 |
| gitnexus | Q5 importers (answered) | 70/70/72 | false | 4.9 / 5.1 | 3970 | 1100 |
| gitnexus | Q6 dependents (answered) | 312/312/316 | false | 52.9 / 56.4 | 227020 | 60428 |
| gitnexus | Q7 transitive_callers (answered) | 11/17/11 | false | 13.8 / 14 | 4393 | 1126 |
| gitnexus | Q9 type_users (answered) | 0/0/85 | false | 4.7 / 4.9 | 517 | 155 |
| gitnexus | Q11 cycles (answered) | 296/296/300 | false | 52.2 / 52.8 | 227020 | 60428 |
| gitnexus | Q12 roots (answered) | 7/12/7 | false | 52.2 / 53.9 | 227020 | 60428 |
| codebase-memory-mcp | Q4 implementations (answered) | 12/12/12 | true | 31.1 / 32.1 | 2436 | 691 |
| codebase-memory-mcp | Q5 importers (answered) | 72/72/72 | true | 29.3 / 31.4 | 7768 | 1959 |
| codebase-memory-mcp | Q6 dependents (answered) | 305/312/316 | false | 154.1 / 164.5 | 453782 | 111820 |
| codebase-memory-mcp | Q7 transitive_callers (answered) | 11/11/11 | true | 77.2 / 81.9 | 7394 | 2103 |
| codebase-memory-mcp | Q9 type_users (answered) | 85/85/85 | true | 31 / 32.4 | 8768 | 2276 |
| codebase-memory-mcp | Q11 cycles (answered) | 210/215/300 | false | 158 / 158.7 | 453782 | 111820 |
| codebase-memory-mcp | Q12 roots (answered) | 7/11/7 | false | 154.4 / 161.6 | 453782 | 111820 |

## Index and discovery costs

| Tool | Index to ready (ms) | Sampled peak RSS (MiB) | Listed tools | Schema bytes | Schema tokens |
|---|---:|---:|---:|---:|---:|
| gortex | 3191 | 1181.2 | 21 | 15200 | 3485 |
| gitnexus | 7834 | 1905.7 | 17 | 70227 | 15819 |
| codebase-memory-mcp | 2680 | 107.8 | 17 | 20824 | 4845 |

## Source audit

A saved edit moved the Q1 call in Entity.ts from line 34 to 35 immediately before the stale-source query.

| Tool | Q1 caller matched | Q1 caller and site matched | Old line returned after edit | New line returned after edit |
|---|---|---|---|---|
| gortex | true | true | true | false |
| gitnexus | true | false | false | false |
| codebase-memory-mcp | true | true | true | false |

Only exact, untruncated answers qualify for comparing costs within a question. Direct-caller questions also require exact caller/site pairs. The JSON files contain the raw replies, commands, audits and every missing or extra fact.

Question classes pending adapter coverage: Q8, Q10, Q13.
