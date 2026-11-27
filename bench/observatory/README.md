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
| Transferred on a cold load | `cold.transferred_kb` | - | - | ≤ 250 KB before data (#47 SC-001) |
| Browser memory, all processes | `cold.browser_rss_mb` | - | - | ≤ 300 MB at 50,000, ≤ 600 MB at 250,000 (#47 SC-005) |
| First drawn map, warm | `warm.first_draw_ms` | - | - | ≤ 300 ms at 50,000 symbols (#47 SC-003) |

## Latest results

LATEST_RESULTS
