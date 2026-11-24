# Provenance

Project-authored for Proofmesh. Apache-2.0. No third-party code. A question set about `fixtures/ts-invoicing` and two sample session transcripts, written by hand in the format `bench/eval/run.mjs` reads, for its test in `packages/proofmesh/test/eval.test.ts`. They are examples of the format, not measurements of any agent.

`ts-invoicing-golden.json` is a golden question set about `fixtures/ts-invoicing/repo`, written by hand from that fixture's source; its expected facts were not taken from any tool's output. `pnpm eval sessions` runs agent sessions on it, with and without Proofmesh.
