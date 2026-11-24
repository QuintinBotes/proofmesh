# Provenance

Project-authored for Proofmesh. Apache-2.0. No third-party code. The test installs minimal stand-ins for `@pulumi/pulumi` and `@pulumi/aws` into a temporary copy. `pulumi.Config` is constructed with `new` but is not a resource, as a decoy. The expected facts are written by hand in `packages/proofmesh/test/pulumi.test.ts`.
