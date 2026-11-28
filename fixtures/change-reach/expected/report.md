<!-- proofmesh:impact-completeness -->

## ProofMesh impact completeness

**2 dependents are neither changed nor tested.** 2 changed symbols; 4 dependents: 1 changed, 1 tested, 2 neither.

| symbol | path:line | relation | basis | of |
| --- | --- | --- | --- | --- |
| `auditorScore` | `src/roles/auditor.ts:3` | calls | observed | `mean` modified |
| `index.ts` | `src/index.ts:1` | imports | observed | `mean` modified |

<details><summary>1 tested dependent</summary>

| symbol | path:line | relation | basis | test |
| --- | --- | --- | --- | --- |
| `analystScore` | `src/roles/analyst.ts:3` | calls | observed | `analystScoreDoubles` `test/analyst.test.ts:2` call, depth 1 |

</details>

<details><summary>2 changed symbols</summary>

| symbol | path:line | change | test |
| --- | --- | --- | --- |
| `managerScore` | `src/roles/manager.ts:2` | modified | none |
| `mean` | `src/stats.ts:1` | modified | `analystScoreDoubles` `test/analyst.test.ts:2` transitive_call, depth 2 |

</details>

Base `<base-commit>` (snapshot `<base-snapshot>`) · head `<head-commit>` (snapshot `<head-snapshot>`)

<details><summary>4 limitations</summary>

~~~text
Symbols are matched by kind and qualified name, so a rename is one deleted symbol and one added; an edit of only whitespace or comments inside a symbol counts as modified.
Tested means a test executes it by a call, a chain of calls or dispatch, as find_tests finds it; test code is recognised by file convention, project naming and symbol roles.
References other than calls and imports are recorded only where an adapter supports them (C# uses of repository declarations, TypeScript uses of repository types, Python uses of repository classes and functions); elsewhere a missing reference is not evidence of no use.
The snapshot is of a detached head; behind_remote counts the commits of no remote branch it lacks, as of the last fetch, without fetching, so it can understate how stale it is.
~~~

</details>
