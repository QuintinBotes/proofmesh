# Contributing to Proofmesh

Thank you for helping. Proofmesh is a local-first code graph for coding agents; everything it claims is backed by evidence it can show, and contributions are held to the same standard.

## Developer Certificate of Origin

Every commit is signed off (`git commit -s`), which adds `Signed-off-by: Your Name <you@example.com>` and states that you agree to the Developer Certificate of Origin (https://developercertificate.org). A pull request with an unsigned commit is not merged.

## Set up

Requirements: Node.js 22.13 or later with pnpm 10 (`corepack enable`), the .NET 10 SDK for the C# adapter, and git.

```
pnpm install --frozen-lockfile
pnpm build
pnpm exec playwright install chromium   # once, for the browser tests
pnpm verify
```

`pnpm verify` runs the type checks, unit and integration tests, the C# adapter's tests, the browser tests, and the licence, schema and traceability checks. Run a single test file with `pnpm vitest run packages/proofmesh/test/<file>.test.ts`.

## What a change needs

- A test that fails without it. Expected facts in fixtures are written by hand; never edit an oracle to match output.
- Fixtures are project-authored and record their origin in `PROVENANCE.md` (FR075). No proprietary or third-party code.
- A requirement id in the test's `describe` title, and an entry in `policy/traceability.json`.
- No new production dependency outside `policy/licenses.json`.
- Adapters speak only the public protocol (`docs/proofmesh/adapter-authoring.md`); nothing executes repository code without a trust grant.

## Pull requests

Open them against `main`. CI for pull requests runs without secrets or release credentials (FR074). Describe the behaviour, not the diff, and say how you tested it.
