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
  galaxy); final positions (the Galaxy has drawn the positions the snapshot carries, #44, and marks itself `data-ready`); long tasks from a `PerformanceObserver`
  from the first script on; time to interactive, the end of the last long task before a quiet second after the first draw;
  total blocking time, each long task's time over 50 ms between first contentful paint and time to interactive; the longest
  task.
- **Memory:** the JS heap (CDP `Performance.getMetrics`) and the resident memory of the browser and every process under it
  (`ps`), once the layout has settled.
- **Bytes:** raw, gzip (level 6, computed here) and transferred (headers and body as sent) for each script, style sheet and
  API response of the cold load. **Calls:** the duration of every API request, from resource timing.
- **Frames:** every `requestAnimationFrame` interval for 3 s at rest, then for 5 s while the mouse pans and zooms.
- **Interactions:** search, from typing to the status line naming the matches, five times; the Map switch, from the tab's
  click to the Map drawn and two frames painted, first and again; the command palette (#43) over the Map, from a query set
  in its field to the frame after its count of matches changes, twenty times, and the longest main-thread task while
  `initialize` (`--palette-query`) is typed a key at a time; symbol to evidence, from a click on the Galaxy table's Explore
  button to the Proof lens (#45) showing the symbol's source text, with the API requests between: first for the page's
  first open, then for a second symbol once the lens has drawn (the two best-connected methods or functions whose names no
  other contains). That button runs the same code as a click on the symbol's point; the canvas's own hit test is not in
  the time. Edge to evidence, from a callee (or caller) row of the lens to its call site shown. `evidence.mjs` times the
  same open over more runs against #45's budgets.
- **Stability**, for symbols present in both layouts, as shares of the map's width after fitting each to view: one snapshot
  in two fresh profiles, and snapshot A followed by B, where B is A plus a commit that adds a function to each of the first
  four `.ts` files under `src/`. The layouts are the positions in the Galaxy payload each page receives.
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
| Command palette, query to matches, p95 | `cold.palette_p95_ms` | 50 ms | 50 ms | - |
| Command palette, longest task while typing | `cold.palette_typing_longest_task_ms` | 50 ms | 50 ms | - |
| Map switch | `cold.map_switch_ms` | 2,000 ms | 2,000 ms | - |
| Initial JavaScript, gzip | `cold.script_gzip_kb` | - | - | ≤ 150 KB (#47 SC-001) |
| Transferred on a cold load, before data | `cold.transferred_kb` | - | - | ≤ 250 KB before data (#47 SC-001) |
| Browser memory, all processes | `cold.browser_rss_mb` | - | - | ≤ 300 MB at 50,000, ≤ 600 MB at 250,000 (#47 SC-005) |
| First drawn map, warm | `warm.first_draw_ms` | - | - | ≤ 300 ms at 50,000 symbols (#47 SC-003) |

## Latest results

Measured on 2026-11-27 on an Apple M5 Max (18 cores, 64 GB, macOS Darwin 25.6.0) shared with other jobs: its one-minute
load average was between about 10 and 30 at the start and end of the runs, and each table names the load at its own start
and end. The browser drew through the GPU (ANGLE on Metal) in every run, so no run used the software column. Under that
load the cold runs did not agree within 10% on every time over 100 ms (each table lists the measures that did not); the
frame times, the palette, the settled layout and the memory did agree. Rerun on a quiet machine before comparing a number
here with another run.

The TypeORM tables were measured on this branch merged with main, after the Proof lens (#45) and the command palette (#43)
landed; the commit each names is the branch head the merge was made on, with the merge as its uncommitted changes. The
synthetic tables were measured before that merge, at the commit each names: there, symbol to evidence took 4 requests,
and there are no palette rows. Their "Transferred on a cold load, before data" row was recomputed from each run's own byte
list after the runs, when the measure was narrowed to scripts and style sheets as #47 counts it; the assets are the same
bytes in every run of one build.

What the tables say against the targets of the Observatory specs:

- **Over budget:** the longest main-thread task at 50,000 symbols (116 ms) and at 250,000 (280 ms), against 100 ms
  (#208). On the TypeORM sample it is 81 ms, within budget; `--check` exits 0 there and 1 on the slowed build.
- **Within budget, new since the merge:** symbol to evidence in 1 request, 62 ms warm and 53 ms on a page's first open
  (#45 asks ≤ 150 ms and ≤ 400 ms); edge to evidence in 0 requests; the palette's query to matches 17.9 ms at p95 and no
  long task while typing (budgets 50 ms).
- **Far from their targets, not yet budgeted:** final positions arrive after 84 s on the TypeORM sample and at 50,000
  symbols (#44 asks 0.6 s and 1.0 s); 409 KB of initial JavaScript gzip, sent uncompressed, 1.54 MB of scripts and style
  sheets transferred on a cold load, before data (#47 asks 150 KB and 250 KB); browser memory 558 MB at 50,000 and 819 MB
  at 250,000 (#47 asks 300 and 600 MB); the A-to-B commit moves 62% of the TypeORM sample's shared symbols more than 2% of
  the map's width, and one snapshot in two fresh profiles is not identical (#44).

### After the path-tree layout (#44)

Measured on 2026-11-27 with the layout of #44 merged with this benchmark: the same machine and browser as below (ANGLE on
Metal, Apple M5 Max, one-minute load average 14 to 17), ProofMesh commit 24023db with the merge uncommitted. Positions now
arrive with the snapshot, so final positions follow the first draw within a frame or two. The tables below were measured
before #44 and keep its 84 s for comparison.

| Fixture | Final positions, cold (median) | First drawn map, cold | Longest task, cold | Stability, same snapshot | Stability, A then B: moved > 2% (max) |
|---|---|---|---|---|---|
| TypeORM sample (7,033 symbols), 3 runs | 277 ms (275–290 ms) | 212 ms | 0 ms | 0.00% | 0.00% (1.93%) |
| Synthetic, 50,000 symbols, 3 runs | 318 ms (312–324 ms) | 225 ms | 57 ms | 0.00% | no commit to change |
| Synthetic, 250,000 symbols, 1 run | 464 ms | 262 ms | 115 ms, over the 100 ms budget (#208) | 0.00% | no commit to change |

`--check` exits 0 on the TypeORM sample and at 50,000 symbols. At 250,000 it exits 1 on the longest task alone, which was
280 ms before #44.

### TypeORM sample

`pnpm bench:observatory --fixture typeorm --check`

Measured on 2026-11-27T16:55:11.292Z. Fixture: typeorm @ 3d55188c0dd1256f520143379ecf97f45e71acba (MIT), 7,033 symbols. ProofMesh commit 91b05f7a4e37eabb4f3acfc8a9122f014d6c5392 with uncommitted changes.
Machine: Apple M5 Max, 18 cores, 64 GB, Darwin 25.6.0 arm64; load average 9.75 12.17 16.26 at start, 13.34 14.06 16.26 at end; 6 GB free.
Browser: Chromium 158.0.8127.18 (Playwright 1.65.0 pinned build 1254 (headless shell)), headless, viewport 1400×900 @1x. WebGL renderer: ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Max, Unspecified Version).
Medians of 3 cold runs, each in a fresh browser profile and a fresh `proofmesh view`; warm is the Galaxy opened again in the same tab, its layout and HTTP cache kept. The first run on the machine is reported apart.

| Measure | Median | Spread | First run | Budget | Target | Status |
|---|---|---|---|---|---|---|
| First contentful paint, cold | 116 ms | 108 ms–156 ms (41.4%) | 116 ms | - | - | - |
| First drawn map, cold | 203 ms | 181 ms–341 ms (78.8%) | 207 ms | 10,000 ms (gpu) | ≤ 1.0 s at 50,000 symbols (#46 SC-001) | within |
| Final positions (layout settled), cold | 83,642 ms | 83,609 ms–83,821 ms (0.3%) | 83,747 ms | - | ≤ 0.6 s TypeORM, ≤ 1.0 s at 50,000, ≤ 2.5 s at 250,000 (#44 SC-001) | - |
| Time to interactive, cold | 309.6 ms | 282.8 ms–494.9 ms (68.5%) | 393.2 ms | - | - | - |
| Total blocking time, cold | 31 ms | 28 ms–53 ms (80.6%) | 110 ms | - | ≤ 200 ms at 50,000 symbols (#47 SC-002) | - |
| Longest main-thread task, cold | 81 ms | 78 ms–103 ms (30.9%) | 160 ms | 100 ms (gpu) | ≤ 50 ms after first paint at 50,000 symbols (#47 SC-002) | within |
| JS heap | 17 MB | 15 MB–19 MB (23.5%) | 10 MB | - | - | - |
| Browser memory, all processes | 476 MB | 475 MB–477 MB (0.4%) | 476 MB | - | ≤ 300 MB at 50,000, ≤ 600 MB at 250,000 (#47 SC-005) | - |
| Frame at rest, p50 | 16.7 ms | - | 16.7 ms | - | - | - |
| Frame at rest, p95 | 16.7 ms | - | 16.7 ms | 17 ms (gpu) | - | within |
| Frame at rest, max | 16.8 ms | 16.8 ms–33.4 ms (98.8%) | 16.8 ms | - | - | - |
| Pan and zoom frame, p50 | 16.7 ms | - | 16.7 ms | - | - | - |
| Pan and zoom frame, p95 | 16.8 ms | 16.7 ms–16.8 ms (0.6%) | 16.7 ms | 33 ms (gpu) | ≤ 16.7 ms at 50,000, ≤ 33 ms at 250,000 (#46 SC-001) | within |
| Pan and zoom frame, max | 16.8 ms | - | 16.8 ms | - | - | - |
| Search | 28 ms | 26 ms–28 ms (7.1%) | 30 ms | 200 ms (gpu) | - | within |
| Symbol to evidence, first open | 53 ms | 51 ms–68 ms (32.1%) | 77 ms | - | ≤ 400 ms (#45 SC-001) | - |
| Symbol to evidence | 62 ms | 61 ms–62 ms (1.6%) | 66 ms | - | ≤ 150 ms p95 warm (#45 SC-001) | - |
| Symbol to evidence, requests | 1 | - | 1 | - | 1 (#45 SC-002) | - |
| Edge to evidence | 49 ms | - | 48 ms | - | ≤ 150 ms p95 warm (#45 SC-001) | - |
| Edge to evidence, requests | 0 | - | 0 | - | - | - |
| Map switch | 84 ms | 82 ms–91 ms (10.7%) | 125 ms | 2,000 ms (gpu) | - | within |
| Map switch, first | 98 ms | 94 ms–103 ms (9.2%) | 138 ms | - | - | - |
| Command palette, query to matches, p50 | 16.9 ms | - | 16.9 ms | - | - | - |
| Command palette, query to matches, p95 | 17.9 ms | 17.3 ms–18 ms (3.9%) | 17.7 ms | 50 ms (gpu) | - | within |
| Command palette, query to matches, max | 17.9 ms | 17.3 ms–18 ms (3.9%) | 17.7 ms | - | - | - |
| Command palette, longest task while typing | 0 ms | - | 0 ms | 50 ms (gpu) | - | within |
| Initial JavaScript, gzip | 409 KB | - | 409 KB | - | ≤ 150 KB (#47 SC-001) | - |
| Transferred on a cold load, before data | 1,540 KB | - | 1,540 KB | - | ≤ 250 KB before data (#47 SC-001) | - |
| First contentful paint, warm | 60 ms | - | - | - | - | - |
| First drawn map, warm | 70 ms | 67 ms–75 ms (11.4%) | - | - | ≤ 300 ms at 50,000 symbols (#47 SC-003) | - |
| Final positions (layout settled), warm | 163 ms | 160 ms–164 ms (2.5%) | - | - | - | - |
| Time to interactive, warm | 157.3 ms | 155.6 ms–158.5 ms (1.8%) | - | - | - | - |
| Total blocking time, warm | 18 ms | 14 ms–18 ms (22.2%) | - | - | - | - |
| Longest main-thread task, warm | 68 ms | 64 ms–68 ms (5.9%) | - | - | - | - |
| JS heap, warm | 21 MB | 20 MB–40 MB (95.2%) | - | - | - | - |
| Browser memory, all processes, warm | 586 MB | 565 MB–586 MB (3.6%) | - | - | - | - |

Cold runs differ by more than 10% on: fcp_ms, first_draw_ms, tti_ms.

| Bytes, cold load | Raw | Gzip | Transferred |
|---|---|---|---|
| stylesheet (1) | 17 KB | 4 KB | 17 KB |
| script (2) | 1,522 KB | 409 KB | 1,523 KB |
| api (4) | 747 KB | 165 KB | 203 KB |

| API call | Calls | Median | Max |
|---|---|---|---|
| `/api/v1/galaxy` | 1 | 18.8 ms | 54.4 ms |
| `/api/v1/galaxy/symbol` | 11 | 11.8 ms | 94.9 ms |
| `/api/v1/snapshots` | 1 | 4.5 ms | 11.7 ms |
| `/api/v1/tools/get_overview` | 1 | 19.4 ms | 46.2 ms |
| `/api/v1/tools/workspace_status` | 1 | 77.5 ms | 120.1 ms |

| Stability (share of map width) | Shared symbols | Median | p90 | Max | Moved > 2% | Moved > 5% |
|---|---|---|---|---|---|---|
| Same snapshot, two fresh profiles | 6,989 | 0.14% | 0.86% | 5.26% | 1.37% | 0.01% |
| Snapshot A, then B (a commit touching four files) | 6,989 | 2.73% | 3.83% | 12.53% | 62.21% | 0.53% |

Every budget is met.

### TypeORM sample, slowed by a 200 ms main-thread task

`pnpm bench:observatory --fixture typeorm --runs 1 --inject-task-ms 200 --check`

Measured on 2026-11-27T17:00:06.442Z. Fixture: typeorm @ 3d55188c0dd1256f520143379ecf97f45e71acba (MIT), 7,033 symbols. ProofMesh commit 91b05f7a4e37eabb4f3acfc8a9122f014d6c5392 with uncommitted changes.
Machine: Apple M5 Max, 18 cores, 64 GB, Darwin 25.6.0 arm64; load average 20.65 15.62 16.77 at start, 39.95 30.74 23.14 at end; 5.5 GB free.
Browser: Chromium 158.0.8127.18 (Playwright 1.65.0 pinned build 1254 (headless shell)), headless, viewport 1400×900 @1x. WebGL renderer: ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Max, Unspecified Version).
Medians of 1 cold run, each in a fresh browser profile and a fresh `proofmesh view`; warm is the Galaxy opened again in the same tab, its layout and HTTP cache kept. The first run on the machine is reported apart. A 200 ms main-thread task was injected after the first draw (--inject-task-ms).

| Measure | Median | Spread | First run | Budget | Target | Status |
|---|---|---|---|---|---|---|
| First contentful paint, cold | 160 ms | - | 124 ms | - | - | - |
| First drawn map, cold | 508 ms | - | 233 ms | 10,000 ms (gpu) | ≤ 1.0 s at 50,000 symbols (#46 SC-001) | within |
| Final positions (layout settled), cold | 84,172 ms | - | 83,878 ms | - | ≤ 0.6 s TypeORM, ≤ 1.0 s at 50,000, ≤ 2.5 s at 250,000 (#44 SC-001) | - |
| Time to interactive, cold | 843.5 ms | - | 554.6 ms | - | - | - |
| Total blocking time, cold | 187 ms | - | 194 ms | - | ≤ 200 ms at 50,000 symbols (#47 SC-002) | - |
| Longest main-thread task, cold | 200 ms | - | 200 ms | 100 ms (gpu) | ≤ 50 ms after first paint at 50,000 symbols (#47 SC-002) | over budget |
| JS heap | 20 MB | - | 18 MB | - | - | - |
| Browser memory, all processes | 481 MB | - | 479 MB | - | ≤ 300 MB at 50,000, ≤ 600 MB at 250,000 (#47 SC-005) | - |
| Frame at rest, p50 | 16.7 ms | - | 16.7 ms | - | - | - |
| Frame at rest, p95 | 16.8 ms | - | 16.8 ms | 17 ms (gpu) | - | within |
| Frame at rest, max | 33.3 ms | - | 33.3 ms | - | - | - |
| Pan and zoom frame, p50 | 16.7 ms | - | 16.7 ms | - | - | - |
| Pan and zoom frame, p95 | 16.7 ms | - | 16.7 ms | 33 ms (gpu) | ≤ 16.7 ms at 50,000, ≤ 33 ms at 250,000 (#46 SC-001) | within |
| Pan and zoom frame, max | 16.8 ms | - | 16.8 ms | - | - | - |
| Search | 28 ms | - | 13 ms | 200 ms (gpu) | - | within |
| Symbol to evidence, first open | 79 ms | - | 94 ms | - | ≤ 400 ms (#45 SC-001) | - |
| Symbol to evidence | 139 ms | - | 83 ms | - | ≤ 150 ms p95 warm (#45 SC-001) | - |
| Symbol to evidence, requests | 1 | - | 1 | - | 1 (#45 SC-002) | - |
| Edge to evidence | 49 ms | - | 44 ms | - | ≤ 150 ms p95 warm (#45 SC-001) | - |
| Edge to evidence, requests | 0 | - | 0 | - | - | - |
| Map switch | 108 ms | - | 95 ms | 2,000 ms (gpu) | - | within |
| Map switch, first | 109 ms | - | 116 ms | - | - | - |
| Command palette, query to matches, p50 | 16.8 ms | - | 17 ms | - | - | - |
| Command palette, query to matches, p95 | 17.2 ms | - | 17.9 ms | 50 ms (gpu) | - | within |
| Command palette, query to matches, max | 17.2 ms | - | 17.9 ms | - | - | - |
| Command palette, longest task while typing | 0 ms | - | 0 ms | 50 ms (gpu) | - | within |
| Initial JavaScript, gzip | 409 KB | - | 409 KB | - | ≤ 150 KB (#47 SC-001) | - |
| Transferred on a cold load, before data | 1,540 KB | - | 1,540 KB | - | ≤ 250 KB before data (#47 SC-001) | - |
| First contentful paint, warm | 72 ms | - | - | - | - | - |
| First drawn map, warm | 112 ms | - | - | - | ≤ 300 ms at 50,000 symbols (#47 SC-003) | - |
| Final positions (layout settled), warm | 418 ms | - | - | - | - | - |
| Time to interactive, warm | 414.5 ms | - | - | - | - | - |
| Total blocking time, warm | 174 ms | - | - | - | - | - |
| Longest main-thread task, warm | 200 ms | - | - | - | - | - |
| JS heap, warm | 20 MB | - | - | - | - | - |
| Browser memory, all processes, warm | 609 MB | - | - | - | - | - |

| Bytes, cold load | Raw | Gzip | Transferred |
|---|---|---|---|
| stylesheet (1) | 17 KB | 4 KB | 17 KB |
| script (2) | 1,522 KB | 409 KB | 1,523 KB |
| api (4) | 747 KB | 165 KB | 203 KB |

| API call | Calls | Median | Max |
|---|---|---|---|
| `/api/v1/galaxy` | 1 | 79.1 ms | 79.1 ms |
| `/api/v1/galaxy/symbol` | 12 | 26.4 ms | 93.2 ms |
| `/api/v1/snapshots` | 1 | 41.1 ms | 41.1 ms |
| `/api/v1/tools/get_overview` | 1 | 83.8 ms | 83.8 ms |
| `/api/v1/tools/workspace_status` | 1 | 264.3 ms | 264.3 ms |

| Stability (share of map width) | Shared symbols | Median | p90 | Max | Moved > 2% | Moved > 5% |
|---|---|---|---|---|---|---|
| Same snapshot, two fresh profiles | 6,989 | 0.32% | 0.77% | 5.50% | 1.04% | 0.07% |
| Snapshot A, then B (a commit touching four files) | 6,989 | 2.64% | 3.46% | 11.99% | 67.42% | 1.04% |

Over budget: Longest main-thread task, cold.

### Synthetic galaxy, 50,000 symbols (before the merge)

`pnpm bench:observatory --fixture synthetic --nodes 50000 --check`

Measured on 2026-11-27T16:07:28.029Z. Fixture: synthetic galaxy (sha256 7a8f5b0c013b), its points mapped to the TypeORM sample @ 3d55188c0dd1256f520143379ecf97f45e71acba (MIT), 50,000 symbols. ProofMesh commit d1c082e5d089c05c2655506335cef84bd25eef3f with uncommitted changes.
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

### Synthetic galaxy, 250,000 symbols (before the merge)

`pnpm bench:observatory --fixture synthetic --nodes 250000 --check`

Measured on 2026-11-27T16:15:10.664Z. Fixture: synthetic galaxy (sha256 5d260d8e18b0), its points mapped to the TypeORM sample @ 3d55188c0dd1256f520143379ecf97f45e71acba (MIT), 250,000 symbols. ProofMesh commit fb2630bd33c56c24bedd26af4fc3dcd3e33f3d13 with uncommitted changes.
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
