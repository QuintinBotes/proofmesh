# Provenance

Project-authored for Proofmesh. Apache-2.0. No third-party code. `build.mjs` writes a small TypeScript project into an empty directory as a git repository of 21 scripted commits, with a fixed identity and fixed dates, so its history is the same on every machine. It declares the pairs of files that change together (`PAIRS`) with their counts, which `packages/proofmesh/test/cochanges.test.ts` compares with `get_cochanges` (#239). History tools of #238 and #240 can extend it; a commit added changes the declared counts.
