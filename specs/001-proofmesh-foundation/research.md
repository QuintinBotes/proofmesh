# Research

Spikes the plan asks for before an adapter or view is built, with what they measured. Every number below was measured on one machine: an Apple M1 Max with 32 GB of memory, macOS 27.2, Node.js 22.18.

## Python semantic engine (M4)

### Question

Can Pyright, the type checker the ADR names, resolve the target of every call in a Python repository, through an integration surface Proofmesh controls, fast enough to index a real service? The fallback was syntax plus import resolution with candidate call edges.

### Integration

Pyright 1.1.414's language server, from the `pyright` npm package (MIT), runs as a child of the adapter process. Tree-sitter finds declarations, imports and call sites, and the adapter asks Pyright for the definition of each call's callee with `textDocument/definition`. Pyright starts with an empty `PATH`, so it finds no interpreter and runs nothing; installed packages are read from the repository's virtual environment as search paths. Pyright never imports or executes Python code, so the adapter needs no build evaluation (D14).

### Fixture

`fixtures/py-shop` covers the cases the plan names: packages, relative imports, class methods called through `self` and through an inferred instance, a dynamic `getattr` call, the standard library, a package that is not installed, and a same-named decoy. All 16 symbols, 11 calls and 4 imports equal the hand-written oracle, and the adapter passes the conformance kit.

### Measured on a private Python service

The spike was run on a private Python service of over a thousand files. Its resolution rates, timings and memory are kept with the private evaluation results; the findings below and the fixture tests are the public record.

### What the spike found and fixed

- The core gives up on an adapter after 60 s without a message, and a batch can take longer. The adapter reports progress after each file.
- An empty file, such as a bare `__init__.py`, has no byte for a symbol's evidence to cite, and three adapters claimed one anyway. Empty files now have no symbol.
- When first-party packages are installed in editable mode, Pyright follows a `.pth` file's directories ahead of any other search path, out of the indexed copy into the original checkout, which left calls into the repository's own code unresolved. The adapter shows Pyright a site-packages without `.pth` files, and searches each editable directory inside the repository in the indexed copy instead.
- The import graph that decides which files an edit reanalyses missed the editable directories, so an edit to an editable package reused its importers' stale facts. The graph now searches every directory Pyright searches, and a test renames a function behind an editable install and compares the incremental snapshot with a clean one.
- A built-in adapter rebuilt without a version change kept its snapshot identity and its cached facts. The hash of every adapter's entry file is now part of identity and of every cache key (NFR004).

### Decision

Pyright, not the fallback. It resolves calls across modules, through inferred receivers and into installed packages, at a cost a cold index of a service of over a thousand files can carry, and incremental indexing keeps most edits to seconds.

## Galaxy rendering (M3, measured after M8)

### Question

Does the Galaxy, every symbol of a snapshot drawn by cosmos.gl, stay interactive on a large repository, and what frame and interaction budgets can Proofmesh publish (NFR005)? M3 built the Galaxy directly on cosmos.gl without a separate spike; this measurement stands in for it.

### Method

`node bench/observatory/frames.mjs --data-dir <dir>` starts `proofmesh view`, opens the Galaxy in headless Chromium 158 at 1400 by 900, and records the time to the first drawn galaxy and to a settled layout, every animation-frame interval for 3 s at rest and for 5 s while the mouse zooms and drags (ten wheel turns and ten drags), the time from typing a query to the status naming its matches (median of five), and, one second after the search is cleared, the time to switch to the Map, timed inside the page, cold and warm. Chromium drew through ANGLE on Metal on the M1 Max's GPU, not a software renderer. The budgets were set before the first measurement:

| Budget | Value |
|---|---|
| First drawn galaxy | 10 s |
| Frame time at rest, 95th percentile | 17 ms (60 frames a second) |
| Frame time while zooming and panning, 95th percentile | 33 ms (30 frames a second) |
| Search, typing to matches named, median | 200 ms |
| Switching to the Map, cold and warm | 2 s |

### Results (2026-11-12, final build)

| Snapshot | First draw | Settled | At rest p95 | Moving p50 / p95 | Search median | Map cold / warm |
|---|---|---|---|---|---|---|
| `fixtures/ts-invoicing`: 7 symbols, 2 links | 202 ms | 7.2 s | 16.7 ms | 16.7 / 16.8 ms | 28 ms | 139 / 95 ms |

A large private C# repository, hundreds of thousands of symbols and over a million links, was measured the same way and also meets every budget; its figures are kept with the private evaluation results. Its layout takes minutes to settle, during which the galaxy is drawn and usable, and a settled layout is cached, so a reload shows it at rest (A11).

### What the measurement found and fixed

The first measurement of the large snapshot missed two budgets: the moving 95th percentile and the search median. CPU profiles of each interaction found:

- Every zoom frame read all point positions back from the GPU to place the area labels, though moving the camera moves no point. The area sums are now kept until the simulation moves the points.
- cosmos.gl reads one pixel back from the GPU on every press, to see whether it lands on a point, and that waits for whatever is still drawing: after each zoom, every one of over a million links. Above 200,000 links, links now rest while the view moves and return only once it has been still for 400 ms, and the legend says so. This brought the moving 95th percentile within budget.
- Search ran its whole filtered-view rebuild (a positions read-back, arrays over every link, and new shader pipelines in cosmos.gl) before the status line could paint, because React runs effects synchronously after typing. The count is now set first and the rebuild runs after that frame paints, cancelled by a further keystroke; clearing a search restores the galaxy the same way. Positions already read for the labels are reused.
- Matching lowered every name per query, twice. The names are now lowered and joined once per galaxy, and a query is one native substring scan mapped to names by binary search, checked against a plain filter in `apps/observatory/test/galaxy.test.ts`.
- A first version of the link change referred to the graph before its constructor returned; the measurement script now stops at the first page error instead of waiting out a timeout.

### Decision

Keep cosmos.gl. Its per-press GPU read-back and the shader pipelines it builds for a filtered view are its costs on very large galaxies; Proofmesh now schedules around them rather than paying them inside an interaction.
