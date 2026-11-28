# Unsaved TypeScript edit

Run `pnpm build && python3 bench/session-edit/run.py` from the repository root on macOS or Linux. The script prints JSON with the time from applying an edit to receiving a graph answer and the sampled peak RSS for that interval. Both paths must report that `choose` now calls `B`.

Each trial indexes a fresh copy of the two-file fixture, opens an MCP connection, and verifies the original call to `A`. The unsaved trial sends the new bytes to that connection. The saved trial writes identical bytes to disk and runs the CLI index with its existing cache. Both then issue the same relationships query. The sampler sums resident memory across the MCP process, any CLI index process, and their descendants. It waits 10 ms between process-table reads. Short-lived peaks can fall between samples, and shared pages can count in several processes.

### November 28, 2026

macOS 27.2.1 on arm64, Node v26.13.1. The baseline contained two files and 233 source bytes, analyzed at the precise TypeScript tier. Three trials per mode ran in interleaved order.

| Edit | Edit to first answer (ms) | Sampled peak RSS (MiB) |
| --- | --- | --- |
| Unsaved | 350, 352, 345 | 286.0, 285.4, 286.9 |
| Saved and indexed | 514, 507, 515 | 478.8, 480.1, 479.7 |

The saved path includes starting a CLI process while the MCP connection remains open. These measurements cover the two-file fixture. Larger projects require a separate measurement.
