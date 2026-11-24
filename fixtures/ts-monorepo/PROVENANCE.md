# Provenance

Project-authored for Proofmesh. Apache-2.0. No third-party code. A monorepo with no root `tsconfig.json`: each package has its own, extending a shared base, and only `web` has the DOM library and a path alias into `core`. The expected facts are written by hand in `packages/proofmesh/test/typescript-projects.test.ts`.
