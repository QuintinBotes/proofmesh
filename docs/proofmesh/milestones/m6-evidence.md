# M6 evidence: Replay, Diff, compare_snapshots and list_queries

M6 as the goal states it: Replay, Diff, `compare_snapshots`, and `list_queries`.

Every item below is proven by the test named, and `pnpm verify` runs all of them. `policy/traceability.json` maps each requirement to its tests.

## Items and proof

| Item | Proof |
|---|---|
| `compare_snapshots`: the base snapshot attached as a second sealed file (D03); symbols matched by kind and qualified name and reported added, removed or changed (signature, range, path); relationships counted by type; files by path and hash with disposition changes (FR019, FR063) | `packages/proofmesh/test/compare.test.ts` |
| `list_queries`: the tool catalog with schema ids, paging and workspace scope, and the newest query records; `runTool` records each call's tool, repository, snapshot, duration, truncation and the hash of its input, never the input or result (NFR008); catalog migration 0013 | `packages/proofmesh/test/list-queries.test.ts` |
| Replay: a snapshot picker over `POST /api/v1/snapshots`; every pinnable query carries the chosen `snapshot_id`; a banner says which snapshot is replayed until "Back to current" (FR010) | `e2e/replay.spec.ts` |
| Diff: base and head pickers, summary tiles, an ordered keyboard-navigable table of symbol changes with kind and change filters, and a Galaxy overlay tinting added and changed symbols while the Galaxy shows the head snapshot (FR019) | `apps/observatory/test/diff.test.ts`, `e2e/diff.spec.ts` |

## Decisions recorded

- The snapshot list is a POST under `/api/v1/`, so it inherits the session and same-origin checks every data route has; a GET would have been the only unauthenticated data route.
- Catalog migrations became the `schemas/catalog/NNNN.sql` files present, applied in order and skipping applied versions, so parallel milestones' migrations land in any order. `CATALOG_VERSION` is derived from the files.

## Known limits

- Overloads or partial classes that share kind and qualified name collapse to one symbol in a comparison.
- A renamed symbol counts as one removed and one added.
- Removed symbols cannot be drawn on the head Galaxy; they appear in the table, and the legend says so. The Map has no diff overlay.
- The Galaxy overlay recolours by rebuilding the graph, fine for one comparison at a time.
- Query records are retained until `proofmesh gc` (M8) runs; nothing else trims them.
