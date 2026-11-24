# Governance

Proofmesh is maintained by the people listed in MAINTAINERS.md.

- **Decisions** are recorded as architecture decision records under `docs/proofmesh/adr/`. A change to an invariant, a public contract (MCP schemas, adapter protocol, snapshot and bundle formats) or a security boundary needs an ADR amendment before it merges.
- **Maintainers** merge pull requests, cut releases and hold the signing identity. A new maintainer is proposed by an existing one and accepted when no maintainer objects within two weeks.
- **Contributors** follow CONTRIBUTING.md. Anyone may open issues and pull requests.
- **Releases** are tagged from `main` by a maintainer after `pnpm verify` and the release checks in `docs/proofmesh/release.md` pass. Tags are the only trusted CI path; pull requests never see release credentials.
- **Conduct** is governed by CODE_OF_CONDUCT.md; security reports follow SECURITY.md.
