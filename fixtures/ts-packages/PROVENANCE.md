# Provenance

Project-authored for Proofmesh. Apache-2.0. No third-party code. `greeter` is installed by the test into a temporary copy, `absent-lib` is never installed, and `@fx/util` is a workspace package linked through `node_modules`, as npm workspaces link them. The expected facts are written by hand in `packages/proofmesh/test/typescript-packages.test.ts`.
