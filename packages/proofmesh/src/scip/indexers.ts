// The indexers `proofmesh scip run` may run (A38): the one table of tool, pinned version, pinned digest, installation command and how
// each is told to work offline. Proofmesh never downloads an indexer; a person installs one and the run checks it is the pinned one.
import os from 'node:os'

/** What an indexer is run with. `dir` is the disposable copy, `out` the file it writes, `cache` the declared module cache, as the indexer sees them. */
export type IndexerContext = { dir: string; out: string; cache: string; home: string }
export type Indexer = {
  tool: string
  /** The language names a snapshot's files carry that this indexer reads. */
  languages: string[]
  /** The pinned release. A person may pin another in `<data dir>/indexers.json`; the table never follows "latest". */
  version: string
  /** The sha256 of the pinned executable per `<platform>-<arch>`. A platform without an entry runs only once a person pins one. */
  sha256: Record<string, string>
  install: string
  args: (c: IndexerContext) => string[]
  /** Offline settings beyond the allowlisted base: the indexer may read the module cache and no registry. */
  env: (c: IndexerContext) => Record<string, string>
  /** Files to write into the copy before the run. */
  files?: () => Record<string, string>
}

// shortcut: digests ship empty until a maintainer records them from the vendors' release assets; until then a person pins the binary they installed.
export const INDEXERS: Indexer[] = [
  {
    tool: 'scip-go', languages: ['go'], version: 'v0.1.26', sha256: {},
    install: 'go install github.com/sourcegraph/scip-go/cmd/scip-go@v0.1.26',
    args: (c) => ['--output', c.out],
    // GOPROXY=off: modules come from the cache or not at all. CGO_ENABLED=0: no C compiler, so a cgo preamble is never compiled.
    env: (c) => ({ GOMODCACHE: c.cache, GOPROXY: 'off', GOFLAGS: '-mod=mod', GOTOOLCHAIN: 'local', CGO_ENABLED: '0', GOCACHE: `${c.home}/gocache` }),
  },
  {
    tool: 'scip-java', languages: ['java', 'kotlin', 'scala'], version: '0.11.2', sha256: {},
    install: 'cs install scip-java:0.11.2',
    args: (c) => ['index', '--output', c.out],
    env: (c) => ({ MAVEN_ARGS: `-o -Dmaven.repo.local=${c.cache}`, GRADLE_USER_HOME: c.cache, GRADLE_OPTS: '-Dorg.gradle.offline=true' }),
  },
  {
    tool: 'rust-analyzer', languages: ['rust'], version: '2026-11-16', sha256: {},
    install: 'rustup component add rust-analyzer (the release dated 2026-11-16)',
    // Build scripts and procedural macros are code the project ships; off, they never run.
    args: (c) => ['--config-path', `${c.dir}/.proofmesh-rust-analyzer.json`, 'scip', '.', '--output', c.out],
    env: (c) => ({ CARGO_HOME: c.cache, CARGO_NET_OFFLINE: 'true' }),
    files: () => ({ '.proofmesh-rust-analyzer.json': JSON.stringify({ 'cargo.buildScripts.enable': false, 'procMacro.enable': false }) }),
  },
]

export const platform = (): string => `${os.platform()}-${os.arch()}`
export const indexerFor = (language: string, table: Indexer[] = INDEXERS): Indexer | undefined => table.find((i) => i.languages.includes(language.toLowerCase()))
