# Provenance

Project-authored for Proofmesh. Apache-2.0. No third-party code. Go and Swift files that no semantic adapter covers, a TypeScript file the first-party adapter keeps, and a Go file the test edits after the index is named, so it goes stale. The SCIP index is not produced by any indexer: `packages/proofmesh/test/scip.test.ts` encodes it from a hand-written description of these files, following `scip.proto`, and the expected facts are written by hand there too.
