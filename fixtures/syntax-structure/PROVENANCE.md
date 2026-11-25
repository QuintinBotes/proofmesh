# Provenance

Project-authored for Proofmesh. Apache-2.0. No third-party code. One small file per language whose syntax-tier query records import statements and heritage clauses (FR115, FR116): Go, Java, Kotlin, Rust, PHP and Ruby so far (FR221, FR222). The expected facts in `expected.json` are written by hand from these files: each import statement is one unresolved `imports` row with the module as written, and each named supertype is one unresolved `inherits` or `implements` row from the type that names it, because this tier never resolves a name (FR117).
