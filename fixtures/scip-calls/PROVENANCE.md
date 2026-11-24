# Provenance

Project-authored for Proofmesh. Apache-2.0. No third-party code. A small Go module (a cart that calls a pricing function, a handler that calls the cart and passes the pricing function as a value) and three Java types (an interface, a class that implements it and a caller). The SCIP index is not produced by any indexer: `packages/proofmesh/test/scip-calls.test.ts` encodes it from a hand-written description of these files, following `scip.proto`, and the expected facts are written by hand there too.
