# Release tooling

Everything here runs locally and publishes nothing: no remote, no registry, no image push. Publication is a separate, person-made decision behind the gate in section D12 of the plan.

## Packages

`pnpm release:pack` packs three npm tarballs into `release/out/` from built artifacts (`pnpm build` first; `dotnet build adapters/csharp -c Release` for the C# adapter): `proofmesh`, `@proofmesh/adapter-typescript` and `@proofmesh/adapter-syntax`. Decision: the adapters stay separate packages, as they are in the workspace, because pnpm refuses `bundleDependencies` with its isolated node linker and bundling them into one tarball would change how the core resolves them. The C# adapter's Release build is staged into the core package's `dist/adapters/csharp`, where the core already looks for it, so a packed install has every first-party adapter.

Until the packages are on a registry, install the tarballs together with pnpm overrides pointing the two adapter dependencies at their tarballs:

```json
{ "pnpm": { "overrides": { "@proofmesh/adapter-syntax": "file:./proofmesh-adapter-syntax-0.1.0.tgz", "@proofmesh/adapter-typescript": "file:./proofmesh-adapter-typescript-0.1.0.tgz" } } }
```

then `pnpm add ./proofmesh-0.1.0.tgz`. `packages/proofmesh/test/release.test.ts` does exactly this, offline, and indexes a TypeScript and a C# fixture from the installed copy. `release/out/manifest.json` records each tarball's hash and the commit.

## Image

`pnpm release:image` builds the `Dockerfile` when `docker` is on the path and otherwise prints `unverified: docker not available`. The image is Node 22 on Debian with the .NET 10 runtime copied in for the C# adapter, a non-root user, `/data` as the data volume and `/repos` for read-only repository mounts. Only the loopback port Proofmesh serves is meant to be published. NFR007's Linux AMD64 and ARM64 check is a CI matrix item, not something this tooling proves.

## SBOM, provenance, signing

- `pnpm release:sbom` writes `release/out/sbom.cdx.json`, CycloneDX 1.5, from the production dependencies pnpm reports, with the tarball hashes on the application component.
- `pnpm release:provenance` writes `release/out/provenance.intoto.json`, an in-toto statement with a SLSA v1 provenance predicate: the tarballs as subjects, the commit and lockfile as resolved dependencies, this machine as the builder.
- `pnpm release:sign` signs every tarball, the SBOM and the provenance with `ssh-keygen -Y sign` using the key at `PROOFMESH_SIGNING_KEY`, and writes `allowed_signers`. No key is generated or stored in the repository. `pnpm release:verify` checks every signature and every tarball against the manifest.
- In CI on a tag, keyless signing (Sigstore) and a hosted builder's provenance attestation replace the local key and the `local://` builder id; pull requests never run that path (FR074).

## Third-party notices

`pnpm release:notices` regenerates `THIRD_PARTY_NOTICES.md` at the root from the licence inventory; `--check` fails when it is stale, and the release test runs that check (NFR013). `pnpm check:licenses` is the policy gate (FR070).

## Open-source files

The files plan section 14 lists live at the repository root since A15 removed the predecessor and the legacy paths.

## Publication gate

`pnpm release:export --out <empty dir> [--deny-list <file>]` copies the Proofmesh paths (`release/export.mjs` lists them) into a fresh repository as one commit, without history (INV17), and runs `release/leak-scan.mjs` over it: email addresses, hosts not on `release/leak-allow.json`, secret-looking tokens, private keys, and every word of the deny list. The deny list of private names is kept outside this repository. A hit fails the export. After a clean scan a person still reviews the tree, including fixtures, docs and screenshots, before any remote exists.
