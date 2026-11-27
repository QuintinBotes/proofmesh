# Provenance

Project-authored for Proofmesh. Apache-2.0. No third-party code. Two repositories for cross-repository symbols (#28): `lib/` builds the package `@fx/geo` 1.2.0, and `app/` depends on it. `installed/geo/index.d.ts` is the declaration file `@fx/geo` installs; since `node_modules` is never committed, the test writes it, with a `package.json` of the version under test, into a copy of `app/` at `node_modules/@fx/geo`. The expected rows are written by hand in `packages/proofmesh/test/xrepo-symbols.test.ts`.
