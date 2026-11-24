# M3 evidence: the Galaxy, exports, accessibility, React, and A11 for one repository

M3 as the goal states it: aggregates in snapshot files, `get_overview`, the Galaxy view (cosmos.gl) with fog and stable layout, exports with embedded caveats and consent, the accessibility audit, the React framework adapter, and A11 for single repositories. A11's ecosystem overview with per-repository drill-down belongs to M5, with the other multi-repository work.

Every item below is proven by the test named, and `pnpm verify` runs all of them. `policy/traceability.json` maps each requirement to its tests, and `pnpm check:traceability` checks the mapping.

## Items and proof

| Item | Proof |
|---|---|
| Aggregates sealed into each snapshot, and `get_overview`, the repository as a graph of areas (FR056) | `packages/proofmesh/test/overview.test.ts`, `e2e/map.spec.ts` |
| The Galaxy: every symbol of a snapshot in one compact binary, drawn by cosmos.gl, with search and area filters | `apps/observatory/test/galaxy.test.ts`, `e2e/galaxy.spec.ts` |
| Fog over coverage the graph cannot see: unanalysed files, excluded files, unresolved-heavy areas, and areas with no symbols (FR059, SC011) | `apps/observatory/test/galaxy.test.ts`, `apps/observatory/test/exporting.test.ts`, `e2e/galaxy.spec.ts` |
| Layouts settled once, cached by snapshot and seed, and stable across snapshots (A11) | `apps/observatory/test/galaxy.test.ts`, `e2e/galaxy.spec.ts` |
| Exports: an image or an offline page, each with its caveats inside, source only with consent (FR064, FR052) | `apps/observatory/test/exporting.test.ts`, `e2e/export.spec.ts` |
| React rules in the TypeScript adapter: renders, hooks, and context, snapshot format 0.4 (FR078, A20) | `packages/proofmesh/test/react.test.ts` |
| Evidence for framework hops on a traced path (FR060) | `e2e/framework-evidence.spec.ts` |
| Build output and ignored files leave snapshot identity; a strict query names an index already running (A21) | `packages/proofmesh/test/freshness.test.ts`, `packages/proofmesh/test/watch.test.ts` |
| Trace labels no longer collide, evidence closes with its view, Claims shows no Trace controls, claims name their symbols (FR061) | `apps/observatory/test/scene.test.ts`, `e2e/views.spec.ts`, `e2e/claims.spec.ts` |
| No view cuts silently (FR058) | `apps/observatory/test/scene.test.ts`, `apps/observatory/test/galaxy.test.ts`, `e2e/trace.spec.ts` |
| Regression tests for the prototype bugs that apply (A11) | the table below |
| Accessibility audit (NFR012, SC013, FR067) | `e2e/accessibility.spec.ts`; the checklist is `docs/proofmesh/accessibility.md` |

## Fog

Each area of the Galaxy carries its coverage: files by disposition, call sites, unresolved calls, and the commonest reasons files were not analysed. An area with symbols gets hatched haze in proportion to its unanalysed files, and a dashed amber ring when at least a fifth of its calls are unresolved, from 20 sites or more (A4). An area with no symbols at all is a labelled ghost on a ring outside the galaxy; the ten largest are drawn one by one and the rest folded into one, so a repository with a hundred small documentation folders stays readable. The summary line, the table, and the exported image say the same in words.

## Stable layout

A settled layout is cached under its snapshot and a hash of the seed inputs, beside a hash of each symbol's name. A new snapshot starts from the last settled layout: kept symbols keep their place, new ones start near their area's kept symbols, and the simulation settles gently instead of from scratch. Positions carry no meaning (FR068), so a rare name-hash collision only costs a place.

## Prototype bugs

| Bug | Status in Proofmesh | Proof |
|---|---|---|
| B1 neighbours truncated without notice | Counted on a badge and in the conclusion | `apps/observatory/test/explore.test.ts` |
| B2 search without a total | Totals shown; pickers say when they list only the first matches | `e2e/galaxy.spec.ts` |
| B3 results pushed off screen | Result lists scroll | `apps/observatory/src/styles.css` (`.hits`) |
| B4 hidden-link count wrong | Not applicable: the Galaxy draws every resolved link | |
| B5 a button moved when its text changed | The layout button keeps its place | `e2e/galaxy.spec.ts` |
| B6 layout never settled | Small graphs settle in seconds, large ones stop early and are cached | `e2e/galaxy.spec.ts` |
| B7 layout end refit the camera | Not applicable: nothing refits when the layout ends | |
| B8 one-character search silent | A hint says why nothing shows | `e2e/galaxy.spec.ts` |
| B9 resume did nothing | Not applicable: cosmos.gl 3.6 `start(alpha)` reheats a paused simulation, and resume calls it | |
| B10 callbacks before state | No view raises a page error | `e2e/galaxy.spec.ts` |
| B11 wrong count in a placeholder | Not applicable: the placeholder states no count | |
| B12 cached load still simulating | A reload of a settled layout shows it at rest | `e2e/galaxy.spec.ts` |
| B13 unlinked points collapse | Every point is seeded at its own place | `apps/observatory/test/galaxy.test.ts` |
| B14 labels overlap | Galaxy and Trace labels never pile up | `apps/observatory/test/galaxy.test.ts`, `apps/observatory/test/scene.test.ts` |
| B15 percentages from tiny samples | Shares only from 20 sites (A4) | `apps/observatory/test/share.test.ts`, `apps/observatory/test/galaxy.test.ts` |
| B16 type libraries resolved from the process directory | Installed packages resolved from the repository (A2) | `packages/proofmesh/test/typescript-packages.test.ts` |
| B17 stale bundles after a rebuild | Pages and assets revalidated, assets content-hashed | `e2e/build.spec.ts` |
| B18 layout cache ignored the seeds | Cached by snapshot and seed hash | `apps/observatory/test/galaxy.test.ts` |
| B20 small graphs showed no names | Every area with symbols is named; generic names keep their parent | `e2e/galaxy.spec.ts`, `apps/observatory/test/galaxy.test.ts` |
| B23 a second link of another kind dropped | Each relationship is its own edge | `apps/observatory/test/explore.test.ts` |
| B24 crumbs wrapped | Crumbs stay on one line and truncate | `apps/observatory/src/styles.css` (`.crumbs`) |

B19, B21 and B22 concern the ecosystem view and repository discovery, which arrive in M5; their tests are `apps/observatory/test/ecosystem.test.ts` (B19) and `packages/proofmesh/test/discover.test.ts` (B21, B22).

## Measured on a large private repository

On the large private C# repository used for the M1 parity run, the Galaxy shows haze over the areas whose files were not all analysed, rings over the few whose calls are mostly unresolved, and ten labelled ghosts plus one folded ghost for the rest. A first version labelled every ghost and buried the galaxy; the ten-and-fold rule came from seeing that. Figures and screenshots are kept with the private evaluation results.

## Amendments made during M3

A20 (React relationship types, snapshot format 0.4) and A21 (files excluded for their location leave snapshot identity) are recorded in `docs/proofmesh/adr/0001-proofmesh.md`, section 10.

## Known limits

- Screen readers and reflow at 320 pixels are not verified; `docs/proofmesh/accessibility.md` lists them.
- "Fit everything" fits the points only, so ghosts on the outer ring can sit just outside the view.
- The pickers' note for truncated matches is untested in a browser, because no fixture has more than 20 matching symbols.
- A job requested while a watcher indexes still fails on the lease; strict queries avoid that path by naming the running index.
- `search_sources` can time out on a very large repository at its default limit.
