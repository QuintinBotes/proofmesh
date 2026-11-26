# Provenance

Project-authored for Proofmesh. Apache-2.0. No third-party code. A small Go module with a protobuf stub (`api/v1/user.pb.go`, marked by its header), a vendored module (`vendor/`, with `modules.txt`), a generated TypeScript client and a hand-edited file that says `@generated` (both settled by `.gitattributes`), `web/app.ts`, which calls the generated client, a `third_party/` directory, a source directory named `build/` in a Go module, and Gradle build output. The expected dispositions are written by hand in `packages/proofmesh/test/generated-vendored.test.ts`.
