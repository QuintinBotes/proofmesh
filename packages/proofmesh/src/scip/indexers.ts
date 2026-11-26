// The indexers `proofmesh scip run` may run (A38): the one table of tool, pinned version, pinned digest, installation command and how
// each is told to work offline. Proofmesh never downloads an indexer; a person installs one and the run checks it is the pinned one.
import os from 'node:os'

/** What an indexer is run with. `dir` is the disposable copy, `out` the file it writes, `cache` the declared module cache, as the indexer sees them. */
export type IndexerContext = { dir: string; out: string; cache: string; home: string }
/** A release asset the pinned version is published as: its name and the sha256 GitHub records for it (the archive, not the executable inside). */
export type Asset = { name: string; sha256: string }
export type Indexer = {
  tool: string
  /** The language names a snapshot's files carry that this indexer reads. */
  languages: string[]
  /** The pinned release; the installed executable must report it. A person may pin another in `<data dir>/indexers.json`. The table never follows "latest". */
  version: string
  /** Install provenance per `<platform>-<arch>`: the release asset to install from and its published digest. An installed executable's own sha256 is recorded in the index, not checked against these. */
  assets: Record<string, Asset>
  install: string
  args: (c: IndexerContext) => string[]
  /** Offline settings beyond the allowlisted base: the indexer may read the module cache and no registry. */
  env: (c: IndexerContext) => Record<string, string>
  /** Files to write into the copy before the run. */
  files?: () => Record<string, string>
}
const asset = (name: string, sha256: string): Asset => ({ name, sha256 })

// Releases at least two weeks old; digests are those GitHub records for each release asset.
export const INDEXERS: Indexer[] = [
  {
    tool: 'scip-go', languages: ['go'], version: 'v0.2.9',
    assets: {
      'darwin-arm64': asset('scip-go-darwin-arm64.tar.gz', '3d8a0c14d0617debcf0c38debe4532d201c89c38a85eaac641da2200bb36d68f'),
      'linux-x64': asset('scip-go-linux-amd64.tar.gz', '4ec4e45ecdbe6f43055ed555254e049f46f28389ade438db3d59679651fa1292'),
      'linux-arm64': asset('scip-go-linux-arm64.tar.gz', '81a196420b1ee64a8820a59287f4bb9cab1849bc3d4e13c97a3130f75d8540fd'),
    },
    install: 'go install github.com/sourcegraph/scip-go/cmd/scip-go@v0.2.9',
    args: (c) => ['--output', c.out],
    // GOPROXY=off: modules come from the cache or not at all. CGO_ENABLED=0: no C compiler, so a cgo preamble is never compiled.
    env: (c) => ({ GOMODCACHE: c.cache, GOPROXY: 'off', GOFLAGS: '-mod=mod', GOTOOLCHAIN: 'local', CGO_ENABLED: '0', GOCACHE: `${c.home}/gocache` }),
  },
  {
    tool: 'scip-java', languages: ['java', 'kotlin', 'scala'], version: 'v0.13.2',
    assets: Object.fromEntries(['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'].map((k) => [k, asset('scip-java-v0.13.2', '5248136592d19ea2c468f64ebd18587d32de7c961536ff19346f8a025af1d13c')])),
    install: 'cs install scip-java:0.13.2',
    args: (c) => ['index', '--output', c.out],
    env: (c) => ({ MAVEN_ARGS: `-o -Dmaven.repo.local=${c.cache}`, GRADLE_USER_HOME: c.cache, GRADLE_OPTS: '-Dorg.gradle.offline=true' }),
  },
  {
    tool: 'rust-analyzer', languages: ['rust'], version: '2026-11-09',
    assets: {
      'darwin-arm64': asset('rust-analyzer-aarch64-apple-darwin.gz', 'e43a65008f8f4291320f33c0545dd577ad7623a7407b584a27155833d3722dfb'),
      'darwin-x64': asset('rust-analyzer-x86_64-apple-darwin.gz', 'abf410a54e33e9f8b2d37f76dde8884db86a030d6a9cc70c0e3f87a77c084c5c'),
      'linux-x64': asset('rust-analyzer-x86_64-unknown-linux-gnu.gz', '8c039b25cb338b3970c731646677a4c9d4e9dd7a92c9ab9ae459c71467fbf4a9'),
      'linux-arm64': asset('rust-analyzer-aarch64-unknown-linux-gnu.gz', '813ca3cec78ac6dab99c7bc9d51e63578f6d401b994ecf29cc0dcad86f9b2cd4'),
    },
    install: 'download the rust-analyzer asset for your platform from https://github.com/rust-lang/rust-analyzer/releases/tag/2026-11-09, gunzip it and put it on PATH',
    // Build scripts and procedural macros are code the project ships; off, they never run.
    args: (c) => ['--config-path', `${c.dir}/.proofmesh-rust-analyzer.json`, 'scip', '.', '--output', c.out],
    env: (c) => ({ CARGO_HOME: c.cache, CARGO_NET_OFFLINE: 'true' }),
    files: () => ({ '.proofmesh-rust-analyzer.json': JSON.stringify({ 'cargo.buildScripts.enable': false, 'procMacro.enable': false }) }),
  },
]

export const platform = (): string => `${os.platform()}-${os.arch()}`
export const indexerFor = (language: string, table: Indexer[] = INDEXERS): Indexer | undefined => table.find((i) => i.languages.includes(language.toLowerCase()))
