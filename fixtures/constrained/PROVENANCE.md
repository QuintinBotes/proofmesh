# Provenance

Project-authored for Proofmesh. Apache-2.0. No third-party code. A Go workspace of three modules (`svc` requires `lib` and not `other`) and a Maven reactor of two modules (`b` depends on `a`, `a` on nothing), written to hold same-named declarations where only the module graph, the imports or the visibility rules tell the right one from the wrong one (issue 16, FR171 to FR180). Several files do not compile on purpose: a call into a module the caller does not declare, an unexported name used from another package.
