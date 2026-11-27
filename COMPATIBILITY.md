# Compatibility

| Contract | Version | Policy |
|---|---|---|
| MCP envelope and tool schemas | 0.1 | `schemas/envelope.schema.json` and `schemas/tools/*.json`. The server validates every answer against them before sending it. A field is added before anything that reads it depends on it; a field is removed one minor release after it is marked deprecated in its schema description. |
| Adapter protocol | 1.2 | `schemas/adapter-protocol/`. Semantic versioning (A22). The core accepts every 1.x adapter and strips unknown optional fields from newer minors; a different major is refused with a message naming both versions. |
| Snapshot file format | 0.12 | `schemas/snapshot-format/`. A snapshot is sealed with the format it was built in; a new format changes snapshot identity, so the next index rebuilds. Older sealed files stay readable until the format they use is removed, which is announced one minor release ahead. |
| Link file format | 0.2 | `schemas/link-format/`. As the snapshot format. |
| Bundle format | 0.1 | `schemas/bundle-format/`. A bundle names its format in `manifest.json`. `proofmesh bundle check` verifies bundles of this format and refuses another format rather than guessing; a format change is announced one minor release ahead, so a bundle kept as a record can still be checked with the release that wrote it. |
| Catalog | 0021 | `schemas/catalog/`. Forward-only migrations, 0001 to the version shown, applied on open; a catalog newer than the CLI refuses to open. Back it up before upgrading (`proofmesh backup`). |
| Node.js | 22.13 or later | The active LTS line. |
| .NET | 10 | Only the C# adapter needs it. |

`list_queries` returns the contract versions above as `contract`, the manifest a client can check before it relies on a schema. A test fails when this table and the code disagree.

Removed without a deprecation period: the `detail.inferred` values `name_match` and `package_directory` that constrained name matching wrote on a bound relationship row (#61). They were a stand-in for `basis` (FR188), which is derived from the row's resolution, origin and detail and so is on every row; read `basis` instead. A row's `detail.rule` stays. `detail.inferred` itself is still written by adapters and still makes a row `inferred`. The resolution version moved from 2 to 3, so snapshots built before are not reused and the next index rebuilds.

Changed behaviour of C# test recognition (roles, protocol 1.1): a type that holds an xUnit, NUnit or MSTest attribute, and its members, are test code wherever the file sits, where only a `*Tests.cs` name or a test project made them so before; and `find_tests` lists only the attributed methods of a C# file that has any, where it listed every symbol of a test file. A C# file with no attribute is decided by its path and project as before. The C# names `Contest.cs` and `Latest.cs` still match the existing `Tests?.cs` file rule, which is case-insensitive and was not changed.

Changed default of `proofmesh mcp` (#26): it lists the `core` tool profile, 13 of the 30 tools, with the per-field descriptions left out of their listed input schemas. Tool names, input schemas, validation and envelopes do not change. `proofmesh mcp --tools all` lists every tool as before; a call to a tool that is not listed is `INVALID_ARGUMENT` naming the profile that lists it (docs/proofmesh/mcp.md).

Added to the MCP envelope and the `analyze_impact` schema (#159), in every envelope, `compact` included: `line` and `relationship` on each `analyze_impact` dependent, `site` on a dependent whose relationship is recorded in another file (it was there only for files reached through imports), and `completion.total` on `analyze_impact` and `find_tests` answers. The change is additive. No field is removed or renamed, no value changes meaning, and envelope version 0.1 stays. A client that rejects unknown fields must accept the new ones before it upgrades. Lean text is unchanged.

Deprecations are listed in CHANGELOG.md under the release that announces them.
