# Compatibility

| Contract | Version | Policy |
|---|---|---|
| MCP envelope and tool schemas | 0.1 | `schemas/envelope.schema.json` and `schemas/tools/*.json`. The server validates every answer against them before sending it. A field is added before anything that reads it depends on it; a field is removed one minor release after it is marked deprecated in its schema description. |
| Adapter protocol | 1.0 | `schemas/adapter-protocol/`. Semantic versioning (A22). The core accepts every 1.x adapter and strips unknown optional fields from newer minors; a different major is refused with a message naming both versions. |
| Snapshot file format | 0.6 | `schemas/snapshot-format/`. A snapshot is sealed with the format it was built in; a new format changes snapshot identity, so the next index rebuilds. Older sealed files stay readable until the format they use is removed, which is announced one minor release ahead. |
| Link file format | 0.2 | `schemas/link-format/`. As the snapshot format. |
| Bundle format | 0.1 | `schemas/bundle-format/`. A bundle names its format in `manifest.json`. `proofmesh bundle check` verifies bundles of this format and refuses another format rather than guessing; a format change is announced one minor release ahead, so a bundle kept as a record can still be checked with the release that wrote it. |
| Catalog | 0018 | `schemas/catalog/`. Forward-only migrations, 0001 to the version shown, applied on open; a catalog newer than the CLI refuses to open. Back it up before upgrading (`proofmesh backup`). |
| Node.js | 22.13 or later | The active LTS line. |
| .NET | 10 | Only the C# adapter needs it. |

`list_queries` returns the contract versions above as `contract`, the manifest a client can check before it relies on a schema. A test fails when this table and the code disagree.

Deprecations are listed in CHANGELOG.md under the release that announces them.
