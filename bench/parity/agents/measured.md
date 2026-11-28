# Graph queries on TypeORM

Fixture 3d55188c0dd1256f520143379ecf97f45e71acba. 5 warm queries per target. Complete MCP reply costs use o200k_base.

| Tool | Question | Correct / returned / expected callers | Correct / returned / expected sites | p50 / p95 ms | Bytes | Tokens |
|---|---|---|---|---|---|---|
| gortex | Q1 (answered) | 48/48/48 | 48/48/54 | 1215.5 / 1231.1 | 54678 | 13915 |
| gortex | Q2 (answered) | 29/29/78 | 29/29/83 | 1802.6 / 1825.3 | 34840 | 8571 |
| gortex | Q3 (target_missing) | 0/0/18 | 0/0/19 | 9 / 9.1 | 4995 | 1120 |
| gitnexus | Q1 (answered) | 48/48/48 | 0/0/54 | 6.7 / 7.7 | 3389 | 936 |
| gitnexus | Q2 (answered) | 78/78/78 | 0/0/83 | 5.7 / 8.3 | 5553 | 1438 |
| gitnexus | Q3 (answered) | 6/9/18 | 0/0/19 | 4.9 / 5 | 1086 | 313 |
| codebase-memory-mcp | Q1 (answered) | 48/48/48 | 48/48/54 | 33.1 / 37.7 | 7146 | 1845 |
| codebase-memory-mcp | Q2 (answered) | 2/2/78 | 2/2/83 | 31.6 / 36.4 | 1248 | 357 |
| codebase-memory-mcp | Q3 (target_missing) | 0/0/18 | 0/0/19 | 14.3 / 18.7 | 524 | 129 |

## Relationship queries

| Tool | Question | Correct / returned / expected items | Exact | p50 / p95 ms | Bytes | Tokens |
|---|---|---|---|---|---|---|
| gortex | Q4 implementations (answered) | 11/11/12 | false | 4.1 / 4.8 | 7435 | 1837 |
| gortex | Q5 importers (answered) | 72/72/72 | true | 229.2 / 232 | 2244705 | 832354 |
| gortex | Q6 dependents (answered) | 310/310/316 | false | 229.6 / 233.8 | 2244705 | 832354 |
| gortex | Q7 transitive_callers (answered) | 9/9/11 | false | 463.6 / 474.1 | 16950 | 4040 |
| gortex | Q9 type_users (answered) | 85/85/85 | true | 18.1 / 18.9 | 218915 | 50514 |
| gortex | Q10 dead_code (answered) | 73/73/80 | false | 3757.2 / 3949.7 | 34072418 | 10195848 |
| gortex | Q11 cycles (answered) | 291/291/300 | false | 232.7 / 234.4 | 2244705 | 832354 |
| gortex | Q12 roots (answered) | 7/10/7 | false | 232.1 / 233.2 | 2244705 | 832354 |
| gortex | Q13 hubs (answered) | 6/10/10 | false | 3861.5 / 3877.5 | 34072418 | 10195848 |
| gitnexus | Q4 implementations (answered) | 12/12/12 | true | 4.9 / 5.1 | 1338 | 406 |
| gitnexus | Q5 importers (answered) | 70/70/72 | false | 4.9 / 5.6 | 3970 | 1100 |
| gitnexus | Q6 dependents (answered) | 312/312/316 | false | 51.8 / 53.9 | 227020 | 60428 |
| gitnexus | Q7 transitive_callers (answered) | 11/17/11 | false | 13.9 / 14.3 | 4393 | 1126 |
| gitnexus | Q9 type_users (answered) | 0/0/85 | false | 3.2 / 4.7 | 517 | 155 |
| gitnexus | Q10 dead_code (answered) | 80/84/80 | false | 4.9 / 5 | 52709 | 13534 |
| gitnexus | Q11 cycles (answered) | 296/296/300 | false | 52.3 / 52.5 | 227020 | 60428 |
| gitnexus | Q12 roots (answered) | 7/12/7 | false | 50.5 / 52.5 | 227020 | 60428 |
| gitnexus | Q13 hubs (answered) | 5/10/10 | false | 12.5 / 12.7 | 1528 | 430 |
| codebase-memory-mcp | Q4 implementations (answered) | 12/12/12 | true | 29.6 / 36.8 | 2436 | 693 |
| codebase-memory-mcp | Q5 importers (answered) | 72/72/72 | true | 29.5 / 30.8 | 7768 | 1961 |
| codebase-memory-mcp | Q6 dependents (answered) | 305/312/316 | false | 174 / 178.2 | 453782 | 111820 |
| codebase-memory-mcp | Q7 transitive_callers (answered) | 11/11/11 | true | 81.6 / 87.9 | 7394 | 2127 |
| codebase-memory-mcp | Q9 type_users (answered) | 85/85/85 | true | 32.3 / 39.1 | 8768 | 2278 |
| codebase-memory-mcp | Q10 dead_code (answered) | 63/63/80 | false | 86.6 / 92.1 | 656540 | 224802 |
| codebase-memory-mcp | Q11 cycles (answered) | 210/215/300 | false | 171.8 / 177.8 | 453782 | 111820 |
| codebase-memory-mcp | Q12 roots (answered) | 7/11/7 | false | 182.9 / 187.6 | 453782 | 111820 |
| codebase-memory-mcp | Q13 hubs (answered) | 4/10/10 | false | 1061.3 / 1085.1 | 9094342 | 2885591 |

## Q8 call path

| Tool | Status | Verified hops / reported | Truth shortest | Valid path | p50 / p95 ms | Bytes | Tokens |
|---|---|---|---|---|---|---|---|
| gortex | answered | 3/3 | 3 | true | 6.4 / 6.6 | 7260 | 1658 |
| gitnexus | answered | 3/3 | 3 | true | 26.2 / 27 | 1145 | 370 |
| codebase-memory-mcp | no_path | 0/0 | 3 | false | 111.7 / 124.2 | 21146 | 6692 |

## Index and discovery costs

| Tool | Index to ready (ms) | Sampled peak RSS (MiB) | Listed tools | Schema bytes | Schema tokens |
|---|---:|---:|---:|---:|---:|
| gortex | 2737 | 1119.9 | 21 | 15200 | 3485 |
| gitnexus | 7859 | 1829.2 | 17 | 70227 | 15819 |
| codebase-memory-mcp | 2782 | 115.4 | 17 | 20824 | 4845 |

## Source audit

A saved edit moved the Q1 call in Entity.ts from line 34 to 35 immediately before the stale-source query.

| Tool | Q1 caller matched | Q1 caller and site matched | Old line returned after edit | New line returned after edit |
|---|---|---|---|---|
| gortex | true | true | true | false |
| gitnexus | true | false | false | false |
| codebase-memory-mcp | true | true | true | false |

Only exact, untruncated answers qualify for comparing costs within a question. Direct-caller questions also require exact caller/site pairs. The JSON files contain the raw replies, commands, audits and every missing or extra fact.

Question classes pending adapter coverage: none.
