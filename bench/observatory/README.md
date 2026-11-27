# Observatory benchmark: what a reader waits for

One command measures the Observatory as a reader meets it: how soon the map is drawn and settles, how long the main thread
blocks, how smooth frames are, how much memory and how many bytes it takes, and how long search, evidence and the Map
switch take. It runs on a pinned public fixture or on a synthetic galaxy of any size, in a pinned browser and viewport, over
several cold runs, and checks the medians against the budgets in [`budgets.json`](budgets.json) (NFR005, issue #41).

## Run it

From the root of this clone:

```sh
pnpm install --frozen-lockfile && pnpm build
pnpm exec playwright install chromium     # once: Playwright's pinned Chromium build
pnpm bench:observatory --fixture typeorm --check
pnpm bench:observatory --fixture synthetic --nodes 50000 --check
```

Each writes `bench/observatory/out/<fixture>.json` and `.md` (`--out <file.json>` moves them) and prints the Markdown.
`--check` exits 1 when a median misses its budget.

| Option | Default | |
|---|---|---|
| `--fixture typeorm` | | TypeORM at commit `3d55188c0dd1256f520143379ecf97f45e71acba` (MIT), built by [`bench/parity/fixture.sh`](../parity/fixture.sh): `src/` and `LICENSE` only, in a new git repository at `$TMPDIR/parity-typeorm` (`PARITY_FIXTURE` moves it), with a `PROVENANCE` note and the parity benchmark's `tsconfig.json`. Fetched once (network); never committed here. |
| `--fixture synthetic --nodes N --seed S` | 50,000, 1 | The TypeORM sample is indexed, then [`gen-galaxy.mjs`](gen-galaxy.mjs) writes a galaxy of N symbols and about 2.94 N links into the server's galaxy cache, so the real `proofmesh view` serves it. The same seed and size give byte-identical files (`fixture.galaxy_sha256`). Each point maps to one of the sample's real symbol ids in turn, so opening a point shows real evidence. |
| `--runs N` | 3 | Measured cold runs. One more, the machine's first, runs before them and is reported apart. |
| `--budgets <file>` | `budgets.json` | |
| `--inject-task-ms N` | | A main-thread task of N ms right after the first draw: a stand-in for a slowed build, to show `--check` catches one. |
| `--query <text>` | `order` | The search timed. |
| `--data-dir <dir>` | | Measure an indexed data directory as it is (`--workspace W --repository R` opens one member). No stability step. |

`PW_EXECUTABLE_PATH` runs another Chromium instead of Playwright's pinned build; the result records which build ran. A
missing pinned build stops the run with the install command above.

## How it measures

- **Pinned:** Playwright's Chromium build (headless shell, `--ignore-gpu-blocklist --enable-gpu`), a 1400×900 viewport at
  1x, the fixture commit or the generator's seed. The result names the hardware, the load average at start and end, the
  browser build and the WebGL renderer, and the ProofMesh commit.
- **Cold runs:** each in a new browser process and profile and a new `proofmesh view`, in a work directory of its own under
  `$TMPDIR` (a copy of the fixture and a fresh data directory), removed when the run ends. Each measure is the median of
  the measured runs, with its range and spread; a time over 100 ms whose runs differ by more than 10% is listed.
- **Warm:** the Galaxy opened again in the same tab after the cold run, with its cached layout and HTTP cache.
- **Load**, timed inside the page from navigation: first contentful paint; the first drawn map (the status bar names the
  galaxy); final positions (the layout settles and the Pause button turns to Resume); long tasks from a `PerformanceObserver`
  from the first script on; time to interactive, the end of the last long task before a quiet second after the first draw;
  total blocking time, each long task's time over 50 ms between first contentful paint and time to interactive; the longest
  task.
- **Memory:** the JS heap (CDP `Performance.getMetrics`) and the resident memory of the browser and every process under it
  (`ps`), once the layout has settled.
- **Bytes:** raw, gzip (level 6, computed here) and transferred (headers and body as sent) for each script, style sheet and
  API response of the cold load. **Calls:** the duration of every API request, from resource timing.
- **Frames:** every `requestAnimationFrame` interval for 3 s at rest, then for 5 s while the mouse pans and zooms.
- **Interactions:** search, from typing to the status line naming the matches, five times; the Map switch, from the tab's
  click to the Map drawn and two frames painted, first and again; symbol to evidence, from a click on the Galaxy table's
  Explore button for one symbol (the best-connected method or function whose name no other contains) to its source text shown, first
  and again, with the API requests between. That button runs the same code as a click on the symbol's point; the
  canvas's own hit test is not in the time. Edge to evidence, from the Explore table's first edge to its evidence shown.
- **Stability**, for symbols present in both layouts, as shares of the map's width after fitting each to view: one snapshot
  in two fresh profiles, and snapshot A followed by B, where B is A plus a commit that adds a function to each of the first
  four `.ts` files under `src/`. The layouts are the ones the Galaxy keeps in IndexedDB once it settles.
- **Software renderer:** when the WebGL renderer is SwiftShader, llvmpipe or another software rasteriser, the result says
  so and budgets are read from the software column. Such a run measures the CPU, not a GPU; do not compare it with a GPU run.

## Budgets

A budget is the bar today's build must meet; `--check` compares it with the median. A target is the bar an Observatory
spec sets; when that spec lands, its row's budget is tightened to the target. A row without a budget is measured and
reported only. The software column starts equal to the GPU column. One set of budgets applies to every fixture and size;
a spec's target may name a size.

The budgets carried over from the first version of this benchmark are unchanged (first draw 10 s, frames 17 and 33 ms at
p95, search 200 ms, Map switch 2 s). The one new budget, the longest main-thread task at 100 ms, is the RAIL response bar:
a task that long delays the answer to a click visibly. It is what makes `--check` fail on a build slowed by a 200 ms task
(`--inject-task-ms 200`); long-task durations are reported rounded, so a budget of 200 ms would let that task through.

| Measure | Key | GPU | Software | Target |
|---|---|---|---|---|
| First drawn map, cold | `cold.first_draw_ms` | 10,000 ms | 10,000 ms | ≤ 1.0 s at 50,000 symbols (#46 SC-001) |
| Final positions (layout settled), cold | `cold.settled_ms` | - | - | ≤ 0.6 s TypeORM, ≤ 1.0 s at 50,000, ≤ 2.5 s at 250,000 (#44 SC-001) |
| Total blocking time, cold | `cold.tbt_ms` | - | - | ≤ 200 ms at 50,000 symbols (#47 SC-002) |
| Longest main-thread task, cold | `cold.longest_task_ms` | 100 ms | 100 ms | ≤ 50 ms after first paint at 50,000 symbols (#47 SC-002) |
| Frame at rest, p95 | `cold.frame_idle_p95_ms` | 17 ms | 17 ms | - |
| Pan and zoom frame, p95 | `cold.frame_pan_zoom_p95_ms` | 33 ms | 33 ms | ≤ 16.7 ms at 50,000, ≤ 33 ms at 250,000 (#46 SC-001) |
| Search | `cold.search_ms` | 200 ms | 200 ms | - |
| Symbol to evidence | `cold.symbol_to_evidence_ms` | - | - | ≤ 150 ms p95 warm (#45 SC-001) |
| Symbol to evidence, first open | `cold.symbol_to_evidence_first_ms` | - | - | ≤ 400 ms (#45 SC-001) |
| Symbol to evidence, requests | `cold.symbol_to_evidence_requests` | - | - | 1 (#45 SC-002) |
| Edge to evidence | `cold.edge_to_evidence_ms` | - | - | ≤ 150 ms p95 warm (#45 SC-001) |
| Map switch | `cold.map_switch_ms` | 2,000 ms | 2,000 ms | - |
| Initial JavaScript, gzip | `cold.script_gzip_kb` | - | - | ≤ 150 KB (#47 SC-001) |
| Transferred on a cold load, before data | `cold.transferred_kb` | - | - | ≤ 250 KB before data (#47 SC-001) |
| Browser memory, all processes | `cold.browser_rss_mb` | - | - | ≤ 300 MB at 50,000, ≤ 600 MB at 250,000 (#47 SC-005) |
| First drawn map, warm | `warm.first_draw_ms` | - | - | ≤ 300 ms at 50,000 symbols (#47 SC-003) |

## Latest results

Measured on 2026-11-27 at ProofMesh commit `d1c082e` (this branch's base), on an Apple M5 Max (18 cores, 64 GB, macOS
Darwin 25.6.0) shared with other jobs: its one-minute load average was between about 10 and 30 at the start and end of the runs, and each table names the
load at its own start and end. The browser drew through the GPU (ANGLE on Metal) in every run, so no run used the software
column. Under that load the cold runs did not agree within 10% on every time over 100 ms (each table lists the measures
that did not); the frame times, the settled layout and the memory did agree. Rerun on a quiet machine before comparing a
number here with another run.

The row "Transferred on a cold load, before data" of these tables was recomputed from each run's own byte list after the
runs, when the measure was narrowed to scripts and style sheets as #47 counts it; the assets are the same bytes in every
run of one build.

What the tables say against the targets of the Observatory specs:

- **Over budget:** the longest main-thread task at 50,000 symbols (116 ms) and at 250,000 (280 ms), against 100 ms. On the
  TypeORM sample it is 79 ms, within budget; `--check` exits 0 there and 1 on the slowed build.
- **Far from their targets, not yet budgeted:** final positions arrive after 84 s on the TypeORM sample and at 50,000
  symbols (#44 asks 0.6 s and 1.0 s); 4 requests from a symbol to its evidence (#45 asks 1); 405 KB of initial JavaScript
  gzip, sent uncompressed, 1.53 MB of scripts and style sheets transferred on a cold load, before data (#47 asks 150 KB and 250 KB); browser
  memory 558 MB at 50,000 and 819 MB at 250,000 (#47 asks 300 and 600 MB); the A-to-B commit moves 42% of the TypeORM
  sample's shared symbols more than 5% of the map's width, and one snapshot in two fresh profiles is not identical (#44).

### TypeORM sample

`pnpm bench:observatory --fixture typeorm --check`

Measured on 2026-11-27T15:56:22.272Z. Fixture: typeorm @ 3d55188c0dd1256f520143379ecf97f45e71acba (MIT), 4,152 symbols. ProofMesh commit d1c082e5d089c05c2655506335cef84bd25eef3f.
Machine: Apple M5 Max, 18 cores, 64 GB, Darwin 25.6.0 arm64; load average 29.81 17.13 19.06 at start, 14.54 19.05 20.67 at end; 9 GB free.
Browser: Chromium 158.0.8127.18 (Playwright 1.65.0 pinned build 1254 (headless shell)), headless, viewport 1400×900 @1x. WebGL renderer: ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Max, Unspecified Version).
Medians of 3 cold runs, each in a fresh browser profile and a fresh `proofmesh view`; warm is the Galaxy opened again in the same tab, its layout and HTTP cache kept. The first run on the machine is reported apart.

| Measure | Median | Spread | First run | Budget | Target | Status |
|---|---|---|---|---|---|---|
| First contentful paint, cold | 116 ms | 112 ms–156 ms (37.9%) | 144 ms | - | - | - |
| First drawn map, cold | 200 ms | 199 ms–400 ms (100.5%) | 313 ms | 10,000 ms (gpu) | ≤ 1.0 s at 50,000 symbols (#46 SC-001) | within |
| Final positions (layout settled), cold | 83,627 ms | 83,627 ms–83,837 ms (0.3%) | 83,768 ms | - | ≤ 0.6 s TypeORM, ≤ 1.0 s at 50,000, ≤ 2.5 s at 250,000 (#44 SC-001) | - |
| Time to interactive, cold | 303.5 ms | 298.9 ms–511 ms (69.9%) | 434.8 ms | - | - | - |
| Total blocking time, cold | 29 ms | 27 ms–35 ms (27.6%) | 43 ms | - | ≤ 200 ms at 50,000 symbols (#47 SC-002) | - |
| Longest main-thread task, cold | 79 ms | 77 ms–85 ms (10.1%) | 93 ms | 100 ms (gpu) | ≤ 50 ms after first paint at 50,000 symbols (#47 SC-002) | within |
| JS heap | 17 MB | 14 MB–19 MB (29.4%) | 17 MB | - | - | - |
| Browser memory, all processes | 457 MB | 456 MB–459 MB (0.7%) | 450 MB | - | ≤ 300 MB at 50,000, ≤ 600 MB at 250,000 (#47 SC-005) | - |
| Frame at rest, p50 | 16.7 ms | - | 16.7 ms | - | - | - |
| Frame at rest, p95 | 16.7 ms | - | 16.7 ms | 17 ms (gpu) | - | within |
| Frame at rest, max | 16.8 ms | 16.8 ms–33.3 ms (98.2%) | 16.8 ms | - | - | - |
| Pan and zoom frame, p50 | 16.7 ms | - | 16.7 ms | - | - | - |
| Pan and zoom frame, p95 | 16.8 ms | 16.7 ms–16.8 ms (0.6%) | 16.7 ms | 33 ms (gpu) | ≤ 16.7 ms at 50,000, ≤ 33 ms at 250,000 (#46 SC-001) | within |
| Pan and zoom frame, max | 16.8 ms | - | 16.8 ms | - | - | - |
| Search | 28 ms | 28 ms–29 ms (3.6%) | 32 ms | 200 ms (gpu) | - | within |
| Symbol to evidence, first open | 177 ms | 175 ms–177 ms (1.1%) | 340 ms | - | ≤ 400 ms (#45 SC-001) | - |
| Symbol to evidence | 136 ms | 130 ms–136 ms (4.4%) | 172 ms | - | ≤ 150 ms p95 warm (#45 SC-001) | - |
| Symbol to evidence, requests | 4 | - | 4 | - | 1 (#45 SC-002) | - |
| Edge to evidence | 61 ms | 59 ms–61 ms (3.3%) | 61 ms | - | ≤ 150 ms p95 warm (#45 SC-001) | - |
| Edge to evidence, requests | 2 | - | 2 | - | - | - |
| Map switch | 81 ms | 70 ms–86 ms (19.8%) | 95 ms | 2,000 ms (gpu) | - | within |
| Map switch, first | 108 ms | 92 ms–109 ms (15.7%) | 113 ms | - | - | - |
| Initial JavaScript, gzip | 405 KB | - | 405 KB | - | ≤ 150 KB (#47 SC-001) | - |
| Transferred on a cold load, before data | 1,525 KB | - | 1,525 KB | - | ≤ 250 KB before data (#47 SC-001) | - |
| First contentful paint, warm | 52 ms | 48 ms–60 ms (23.1%) | - | - | - | - |
| First drawn map, warm | 77 ms | 72 ms–84 ms (15.6%) | - | - | ≤ 300 ms at 50,000 symbols (#47 SC-003) | - |
| Final positions (layout settled), warm | 166 ms | 161 ms–166 ms (3%) | - | - | - | - |
| Time to interactive, warm | 160.4 ms | 157.6 ms–162.4 ms (3%) | - | - | - | - |
| Total blocking time, warm | 13 ms | 13 ms–17 ms (30.8%) | - | - | - | - |
| Longest main-thread task, warm | 63 ms | 63 ms–67 ms (6.3%) | - | - | - | - |
| JS heap, warm | 20 MB | 19 MB–31 MB (60%) | - | - | - | - |
| Browser memory, all processes, warm | 547 MB | 537 MB–560 MB (4.2%) | - | - | - | - |

Cold runs differ by more than 10% on: fcp_ms, first_draw_ms, tti_ms, map_switch_cold_ms.

| Bytes, cold load | Raw | Gzip | Transferred |
|---|---|---|---|
| stylesheet (1) | 14 KB | 4 KB | 15 KB |
| script (2) | 1,509 KB | 405 KB | 1,510 KB |
| api (4) | 448 KB | 97 KB | 134 KB |

| API call | Calls | Median | Max |
|---|---|---|---|
| `/api/v1/galaxy` | 1 | 23.8 ms | 71.6 ms |
| `/api/v1/galaxy/symbol` | 2 | 2.4 ms | 9.9 ms |
| `/api/v1/snapshots` | 1 | 8.9 ms | 39.2 ms |
| `/api/v1/tools/get_overview` | 1 | 29.7 ms | 79.1 ms |
| `/api/v1/tools/get_relationships` | 3 | 29 ms | 54.3 ms |
| `/api/v1/tools/get_symbol` | 2 | 3.4 ms | 14 ms |
| `/api/v1/tools/read_evidence` | 3 | 6.4 ms | 14.5 ms |
| `/api/v1/tools/workspace_status` | 1 | 70.1 ms | 179.2 ms |

| Stability (share of map width) | Shared symbols | Median | p90 | Max | Moved > 2% | Moved > 5% |
|---|---|---|---|---|---|---|
| Same snapshot, two fresh profiles | 4,108 | 0.15% | 0.58% | 5.42% | 0.88% | 0.05% |
| Snapshot A, then B (a commit touching four files) | 4,108 | 4.53% | 6.50% | 19.16% | 80.19% | 42.19% |

Every budget is met.

### Synthetic galaxy, 50,000 symbols

`pnpm bench:observatory --fixture synthetic --nodes 50000 --check`

Measured on 2026-11-27T16:07:28.029Z. Fixture: synthetic galaxy (sha256 7a8f5b0c013b), its points mapped to the TypeORM sample @ 3d55188c0dd1256f520143379ecf97f45e71acba (MIT), 50,000 symbols. ProofMesh commit d1c082e5d089c05c2655506335cef84bd25eef3f.
Machine: Apple M5 Max, 18 cores, 64 GB, Darwin 25.6.0 arm64; load average 12.98 13.53 17.56 at start, 9.89 10.56 14.89 at end; 7.3 GB free.
Browser: Chromium 158.0.8127.18 (Playwright 1.65.0 pinned build 1254 (headless shell)), headless, viewport 1400×900 @1x. WebGL renderer: ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Max, Unspecified Version).
Medians of 3 cold runs, each in a fresh browser profile and a fresh `proofmesh view`; warm is the Galaxy opened again in the same tab, its layout and HTTP cache kept. The first run on the machine is reported apart.

| Measure | Median | Spread | First run | Budget | Target | Status |
|---|---|---|---|---|---|---|
| First contentful paint, cold | 116 ms | 112 ms–116 ms (3.4%) | 112 ms | - | - | - |
| First drawn map, cold | 180 ms | 158 ms–200 ms (23.3%) | 198 ms | 10,000 ms (gpu) | ≤ 1.0 s at 50,000 symbols (#46 SC-001) | within |
| Final positions (layout settled), cold | 83,682 ms | 83,632 ms–83,682 ms (0.1%) | 83,699 ms | - | ≤ 0.6 s TypeORM, ≤ 1.0 s at 50,000, ≤ 2.5 s at 250,000 (#44 SC-001) | - |
| Time to interactive, cold | 346.2 ms | 295.6 ms–353.4 ms (16.7%) | 360.5 ms | - | - | - |
| Total blocking time, cold | 66 ms | 57 ms–69 ms (18.2%) | 73 ms | - | ≤ 200 ms at 50,000 symbols (#47 SC-002) | - |
| Longest main-thread task, cold | 116 ms | 107 ms–119 ms (10.3%) | 123 ms | 100 ms (gpu) | ≤ 50 ms after first paint at 50,000 symbols (#47 SC-002) | over budget |
| JS heap | 12 MB | - | 12 MB | - | - | - |
| Browser memory, all processes | 558 MB | 558 MB–561 MB (0.5%) | 560 MB | - | ≤ 300 MB at 50,000, ≤ 600 MB at 250,000 (#47 SC-005) | - |
| Frame at rest, p50 | 16.7 ms | - | 16.7 ms | - | - | - |
| Frame at rest, p95 | 16.7 ms | 16.7 ms–16.8 ms (0.6%) | 16.7 ms | 17 ms (gpu) | - | within |
| Frame at rest, max | 16.8 ms | 16.8 ms–33.4 ms (98.8%) | 16.8 ms | - | - | - |
| Pan and zoom frame, p50 | 16.7 ms | - | 16.7 ms | - | - | - |
| Pan and zoom frame, p95 | 16.7 ms | 16.7 ms–16.8 ms (0.6%) | 16.8 ms | 33 ms (gpu) | ≤ 16.7 ms at 50,000, ≤ 33 ms at 250,000 (#46 SC-001) | within |
| Pan and zoom frame, max | 16.8 ms | - | 16.8 ms | - | - | - |
| Search | 26 ms | 13 ms–32 ms (73.1%) | 32 ms | 200 ms (gpu) | - | within |
| Symbol to evidence, first open | 144 ms | 144 ms–208 ms (44.4%) | 158 ms | - | ≤ 400 ms (#45 SC-001) | - |
| Symbol to evidence | 138 ms | 119 ms–177 ms (42%) | 147 ms | - | ≤ 150 ms p95 warm (#45 SC-001) | - |
| Symbol to evidence, requests | 4 | - | 4 | - | 1 (#45 SC-002) | - |
| Edge to evidence | 60 ms | 59 ms–61 ms (3.3%) | 59 ms | - | ≤ 150 ms p95 warm (#45 SC-001) | - |
| Edge to evidence, requests | 2 | - | 2 | - | - | - |
| Map switch | 67 ms | 66 ms–88 ms (32.8%) | 72 ms | 2,000 ms (gpu) | - | within |
| Map switch, first | 104 ms | 84 ms–113 ms (27.9%) | 100 ms | - | - | - |
| Initial JavaScript, gzip | 405 KB | - | 405 KB | - | ≤ 150 KB (#47 SC-001) | - |
| Transferred on a cold load, before data | 1,525 KB | - | 1,525 KB | - | ≤ 250 KB before data (#47 SC-001) | - |
| First contentful paint, warm | 64 ms | 48 ms–64 ms (25%) | - | - | - | - |
| First drawn map, warm | 81 ms | 74 ms–102 ms (34.6%) | - | - | ≤ 300 ms at 50,000 symbols (#47 SC-003) | - |
| Final positions (layout settled), warm | 239 ms | 214 ms–271 ms (23.8%) | - | - | - | - |
| Time to interactive, warm | 235.8 ms | 209.4 ms–266.5 ms (24.2%) | - | - | - | - |
| Total blocking time, warm | 57 ms | 50 ms–69 ms (33.3%) | - | - | - | - |
| Longest main-thread task, warm | 107 ms | 100 ms–119 ms (17.8%) | - | - | - | - |
| JS heap, warm | 37 MB | 36 MB–43 MB (18.9%) | - | - | - | - |
| Browser memory, all processes, warm | 694 MB | 687 MB–720 MB (4.8%) | - | - | - | - |

Cold runs differ by more than 10% on: first_draw_ms, tti_ms, longest_task_ms, symbol_to_evidence_first_ms, symbol_to_evidence_ms, map_switch_cold_ms.

| Bytes, cold load | Raw | Gzip | Transferred |
|---|---|---|---|
| stylesheet (1) | 14 KB | 4 KB | 15 KB |
| script (2) | 1,509 KB | 405 KB | 1,510 KB |
| api (4) | 3,329 KB | 1,278 KB | 1,314 KB |

| API call | Calls | Median | Max |
|---|---|---|---|
| `/api/v1/galaxy` | 1 | 12.5 ms | 22 ms |
| `/api/v1/galaxy/symbol` | 2 | 1.8 ms | 3 ms |
| `/api/v1/snapshots` | 1 | 3.3 ms | 7.6 ms |
| `/api/v1/tools/get_overview` | 1 | 14.8 ms | 25.1 ms |
| `/api/v1/tools/get_relationships` | 3 | 24.5 ms | 84.7 ms |
| `/api/v1/tools/get_symbol` | 2 | 5.6 ms | 19.3 ms |
| `/api/v1/tools/read_evidence` | 3 | 3.3 ms | 18.9 ms |
| `/api/v1/tools/workspace_status` | 1 | 55.1 ms | 63.6 ms |

| Stability (share of map width) | Shared symbols | Median | p90 | Max | Moved > 2% | Moved > 5% |
|---|---|---|---|---|---|---|
| Same snapshot, two fresh profiles | 49,998 | 0.04% | 0.10% | 2.01% | 0.00% | 0.00% |
| Snapshot A, then B (a commit touching four files) | a synthetic galaxy has no commit to change | | | | | |

Over budget: Longest main-thread task, cold.

### Synthetic galaxy, 250,000 symbols

`pnpm bench:observatory --fixture synthetic --nodes 250000 --check`

Measured on 2026-11-27T16:15:10.664Z. Fixture: synthetic galaxy (sha256 5d260d8e18b0), its points mapped to the TypeORM sample @ 3d55188c0dd1256f520143379ecf97f45e71acba (MIT), 250,000 symbols. ProofMesh commit fb2630bd33c56c24bedd26af4fc3dcd3e33f3d13.
Machine: Apple M5 Max, 18 cores, 64 GB, Darwin 25.6.0 arm64; load average 23.44 15.69 16.06 at start, 20.59 18.99 17.57 at end; 7.6 GB free.
Browser: Chromium 158.0.8127.18 (Playwright 1.65.0 pinned build 1254 (headless shell)), headless, viewport 1400×900 @1x. WebGL renderer: ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Max, Unspecified Version).
Medians of 3 cold runs, each in a fresh browser profile and a fresh `proofmesh view`; warm is the Galaxy opened again in the same tab, its layout and HTTP cache kept. The first run on the machine is reported apart.

| Measure | Median | Spread | First run | Budget | Target | Status |
|---|---|---|---|---|---|---|
| First contentful paint, cold | 112 ms | 112 ms–132 ms (17.9%) | 144 ms | - | - | - |
| First drawn map, cold | 241 ms | 240 ms–447 ms (85.9%) | 368 ms | 10,000 ms (gpu) | ≤ 1.0 s at 50,000 symbols (#46 SC-001) | within |
| Final positions (layout settled), cold | 30,807 ms | 30,485 ms–31,069 ms (1.9%) | 31,897 ms | - | ≤ 0.6 s TypeORM, ≤ 1.0 s at 50,000, ≤ 2.5 s at 250,000 (#44 SC-001) | - |
| Time to interactive, cold | 789.1 ms | 662 ms–1,040.9 ms (48%) | 834.7 ms | - | - | - |
| Total blocking time, cold | 259 ms | 235 ms–297 ms (23.9%) | 266 ms | - | ≤ 200 ms at 50,000 symbols (#47 SC-002) | - |
| Longest main-thread task, cold | 280 ms | 274 ms–316 ms (15%) | 298 ms | 100 ms (gpu) | ≤ 50 ms after first paint at 50,000 symbols (#47 SC-002) | over budget |
| JS heap | 26 MB | 26 MB–86 MB (230.8%) | 26 MB | - | - | - |
| Browser memory, all processes | 819 MB | 818 MB–822 MB (0.5%) | 818 MB | - | ≤ 300 MB at 50,000, ≤ 600 MB at 250,000 (#47 SC-005) | - |
| Frame at rest, p50 | 16.7 ms | - | 16.7 ms | - | - | - |
| Frame at rest, p95 | 16.7 ms | 16.7 ms–16.8 ms (0.6%) | 16.7 ms | 17 ms (gpu) | - | within |
| Frame at rest, max | 16.8 ms | - | 16.8 ms | - | - | - |
| Pan and zoom frame, p50 | 16.7 ms | - | 16.7 ms | - | - | - |
| Pan and zoom frame, p95 | 16.7 ms | 16.7 ms–16.8 ms (0.6%) | 16.8 ms | 33 ms (gpu) | ≤ 16.7 ms at 50,000, ≤ 33 ms at 250,000 (#46 SC-001) | within |
| Pan and zoom frame, max | 16.8 ms | - | 16.8 ms | - | - | - |
| Search | 56 ms | 53 ms–60 ms (12.5%) | 58 ms | 200 ms (gpu) | - | within |
| Symbol to evidence, first open | 159 ms | 157 ms–178 ms (13.2%) | 359 ms | - | ≤ 400 ms (#45 SC-001) | - |
| Symbol to evidence | 162 ms | 142 ms–225 ms (51.2%) | 160 ms | - | ≤ 150 ms p95 warm (#45 SC-001) | - |
| Symbol to evidence, requests | 4 | - | 4 | - | 1 (#45 SC-002) | - |
| Edge to evidence | 61 ms | 60 ms–126 ms (108.2%) | 109 ms | - | ≤ 150 ms p95 warm (#45 SC-001) | - |
| Edge to evidence, requests | 2 | - | 2 | - | - | - |
| Map switch | 73 ms | 65 ms–75 ms (13.7%) | 85 ms | 2,000 ms (gpu) | - | within |
| Map switch, first | 101 ms | 98 ms–103 ms (5%) | 113 ms | - | - | - |
| Initial JavaScript, gzip | 405 KB | - | 405 KB | - | ≤ 150 KB (#47 SC-001) | - |
| Transferred on a cold load, before data | 1,525 KB | - | 1,525 KB | - | ≤ 250 KB before data (#47 SC-001) | - |
| First contentful paint, warm | 60 ms | 60 ms–64 ms (6.7%) | - | - | - | - |
| First drawn map, warm | 131 ms | 123 ms–131 ms (6.1%) | - | - | ≤ 300 ms at 50,000 symbols (#47 SC-003) | - |
| Final positions (layout settled), warm | 521 ms | 518 ms–550 ms (6.1%) | - | - | - | - |
| Time to interactive, warm | 517.7 ms | 515.2 ms–545.5 ms (5.9%) | - | - | - | - |
| Total blocking time, warm | 277 ms | 267 ms–298 ms (11.2%) | - | - | - | - |
| Longest main-thread task, warm | 316 ms | 308 ms–332 ms (7.6%) | - | - | - | - |
| JS heap, warm | 51 MB | 50 MB–74 MB (47.1%) | - | - | - | - |
| Browser memory, all processes, warm | 1,125 MB | 1,097 MB–1,130 MB (2.9%) | - | - | - | - |

Cold runs differ by more than 10% on: fcp_ms, first_draw_ms, tti_ms, tbt_ms, longest_task_ms, symbol_to_evidence_first_ms, symbol_to_evidence_ms.

| Bytes, cold load | Raw | Gzip | Transferred |
|---|---|---|---|
| stylesheet (1) | 14 KB | 4 KB | 15 KB |
| script (2) | 1,509 KB | 405 KB | 1,510 KB |
| api (4) | 16,830 KB | 6,912 KB | 6,949 KB |

| API call | Calls | Median | Max |
|---|---|---|---|
| `/api/v1/galaxy` | 1 | 45.6 ms | 76.5 ms |
| `/api/v1/galaxy/symbol` | 2 | 2.4 ms | 60.3 ms |
| `/api/v1/snapshots` | 1 | 4.4 ms | 5.7 ms |
| `/api/v1/tools/get_overview` | 1 | 18.9 ms | 36.6 ms |
| `/api/v1/tools/get_relationships` | 3 | 31.2 ms | 61.5 ms |
| `/api/v1/tools/get_symbol` | 2 | 7.3 ms | 19.8 ms |
| `/api/v1/tools/read_evidence` | 3 | 6.9 ms | 78.5 ms |
| `/api/v1/tools/workspace_status` | 1 | 72 ms | 221.9 ms |

| Stability (share of map width) | Shared symbols | Median | p90 | Max | Moved > 2% | Moved > 5% |
|---|---|---|---|---|---|---|
| Same snapshot, two fresh profiles | 249,990 | 0.03% | 0.08% | 0.87% | 0.00% | 0.00% |
| Snapshot A, then B (a commit touching four files) | a synthetic galaxy has no commit to change | | | | | |

Over budget: Longest main-thread task, cold.

### TypeORM sample, slowed by a 200 ms main-thread task

`pnpm bench:observatory --fixture typeorm --runs 1 --inject-task-ms 200 --check`

Measured on 2026-11-27T16:00:52.473Z. Fixture: typeorm @ 3d55188c0dd1256f520143379ecf97f45e71acba (MIT), 4,152 symbols. ProofMesh commit d1c082e5d089c05c2655506335cef84bd25eef3f.
Machine: Apple M5 Max, 18 cores, 64 GB, Darwin 25.6.0 arm64; load average 13.68 18.72 20.53 at start, 10.79 13.14 17.48 at end; 1.8 GB free.
Browser: Chromium 158.0.8127.18 (Playwright 1.65.0 pinned build 1254 (headless shell)), headless, viewport 1400×900 @1x. WebGL renderer: ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Max, Unspecified Version).
Medians of 1 cold run, each in a fresh browser profile and a fresh `proofmesh view`; warm is the Galaxy opened again in the same tab, its layout and HTTP cache kept. The first run on the machine is reported apart. A 200 ms main-thread task was injected after the first draw (--inject-task-ms).

| Measure | Median | Spread | First run | Budget | Target | Status |
|---|---|---|---|---|---|---|
| First contentful paint, cold | 116 ms | - | 120 ms | - | - | - |
| First drawn map, cold | 194 ms | - | 227 ms | 10,000 ms (gpu) | ≤ 1.0 s at 50,000 symbols (#46 SC-001) | within |
| Final positions (layout settled), cold | 83,826 ms | - | 83,860 ms | - | ≤ 0.6 s TypeORM, ≤ 1.0 s at 50,000, ≤ 2.5 s at 250,000 (#44 SC-001) | - |
| Time to interactive, cold | 494.9 ms | - | 529.9 ms | - | - | - |
| Total blocking time, cold | 176 ms | - | 178 ms | - | ≤ 200 ms at 50,000 symbols (#47 SC-002) | - |
| Longest main-thread task, cold | 200 ms | - | 200 ms | 100 ms (gpu) | ≤ 50 ms after first paint at 50,000 symbols (#47 SC-002) | over budget |
| JS heap | 19 MB | - | 14 MB | - | - | - |
| Browser memory, all processes | 454 MB | - | 454 MB | - | ≤ 300 MB at 50,000, ≤ 600 MB at 250,000 (#47 SC-005) | - |
| Frame at rest, p50 | 16.7 ms | - | 16.7 ms | - | - | - |
| Frame at rest, p95 | 16.7 ms | - | 16.7 ms | 17 ms (gpu) | - | within |
| Frame at rest, max | 16.8 ms | - | 16.8 ms | - | - | - |
| Pan and zoom frame, p50 | 16.7 ms | - | 16.7 ms | - | - | - |
| Pan and zoom frame, p95 | 16.7 ms | - | 16.7 ms | 33 ms (gpu) | ≤ 16.7 ms at 50,000, ≤ 33 ms at 250,000 (#46 SC-001) | within |
| Pan and zoom frame, max | 16.8 ms | - | 16.8 ms | - | - | - |
| Search | 27 ms | - | 27 ms | 200 ms (gpu) | - | within |
| Symbol to evidence, first open | 162 ms | - | 162 ms | - | ≤ 400 ms (#45 SC-001) | - |
| Symbol to evidence | 138 ms | - | 139 ms | - | ≤ 150 ms p95 warm (#45 SC-001) | - |
| Symbol to evidence, requests | 4 | - | 4 | - | 1 (#45 SC-002) | - |
| Edge to evidence | 77 ms | - | 61 ms | - | ≤ 150 ms p95 warm (#45 SC-001) | - |
| Edge to evidence, requests | 2 | - | 2 | - | - | - |
| Map switch | 102 ms | - | 74 ms | 2,000 ms (gpu) | - | within |
| Map switch, first | 94 ms | - | 108 ms | - | - | - |
| Initial JavaScript, gzip | 405 KB | - | 405 KB | - | ≤ 150 KB (#47 SC-001) | - |
| Transferred on a cold load, before data | 1,525 KB | - | 1,525 KB | - | ≤ 250 KB before data (#47 SC-001) | - |
| First contentful paint, warm | 60 ms | - | - | - | - | - |
| First drawn map, warm | 73 ms | - | - | - | ≤ 300 ms at 50,000 symbols (#47 SC-003) | - |
| Final positions (layout settled), warm | 360 ms | - | - | - | - | - |
| Time to interactive, warm | 357 ms | - | - | - | - | - |
| Total blocking time, warm | 165 ms | - | - | - | - | - |
| Longest main-thread task, warm | 200 ms | - | - | - | - | - |
| JS heap, warm | 32 MB | - | - | - | - | - |
| Browser memory, all processes, warm | 557 MB | - | - | - | - | - |

| Bytes, cold load | Raw | Gzip | Transferred |
|---|---|---|---|
| stylesheet (1) | 14 KB | 4 KB | 15 KB |
| script (2) | 1,509 KB | 405 KB | 1,510 KB |
| api (4) | 448 KB | 98 KB | 135 KB |

| API call | Calls | Median | Max |
|---|---|---|---|
| `/api/v1/galaxy` | 1 | 15 ms | 15 ms |
| `/api/v1/galaxy/symbol` | 2 | 1.6 ms | 2.1 ms |
| `/api/v1/snapshots` | 1 | 9.3 ms | 9.3 ms |
| `/api/v1/tools/get_overview` | 1 | 21.9 ms | 21.9 ms |
| `/api/v1/tools/get_relationships` | 3 | 29.1 ms | 49.4 ms |
| `/api/v1/tools/get_symbol` | 2 | 6.9 ms | 7.2 ms |
| `/api/v1/tools/read_evidence` | 3 | 8.1 ms | 8.1 ms |
| `/api/v1/tools/workspace_status` | 1 | 67.1 ms | 67.1 ms |

| Stability (share of map width) | Shared symbols | Median | p90 | Max | Moved > 2% | Moved > 5% |
|---|---|---|---|---|---|---|
| Same snapshot, two fresh profiles | 4,108 | 0.08% | 0.68% | 6.16% | 2.29% | 0.10% |
| Snapshot A, then B (a commit touching four files) | 4,108 | 4.48% | 6.52% | 16.68% | 80.06% | 41.09% |

Over budget: Longest main-thread task, cold.
