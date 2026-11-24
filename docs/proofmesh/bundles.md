# Evidence bundles

A bundle is a directory (`<name>.pmb/`) a person exports from one published snapshot and checks anywhere, with no Proofmesh service or data directory (FR032).

```
proofmesh bundle export <repository> --out answers.pmb --query '{"tool":"find_symbols","input":{"text":"invoiceTotal"}}' [--include-source]
proofmesh bundle check answers.pmb
```

What is in it, per `schemas/bundle-format/0.1.schema.json`:

- `manifest.json`: the bundle id, the snapshot (id, repository, analysis mode, identity hash), every query (tool, input hash, query id, file, sha256), every evidence item the queries cited (path, lines, bytes, object hash, the sha256 of the cited slice), and `manifest_sha256` over the rest of the manifest.
- `queries/N.json`: each query's full envelope, as the tool returned it, pinned to the snapshot.
- `evidence/<id>.txt`: the cited bytes, only when the person passed `--include-source` (FR052). Without it the manifest still records each slice's hash, and `bundle check` lists those items as unverifiable rather than verified.

Without `--query` the bundle holds `workspace_status`. `bundle check` recomputes every hash and exits 1 on any mismatch or missing file. It cannot tell whether the snapshot itself was honest; it tells whether the bundle is the one that was exported.
