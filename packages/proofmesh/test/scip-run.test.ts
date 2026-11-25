import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TOOLS } from '../src/query/tools.js'
import { Catalog } from '../src/meshstore/catalog.js'
import { containerArgv, runScip } from '../src/scip/run.js'
import { encode, type Doc } from './helpers-scip.js'
import { cli, fixtureRepo, ROOT, tmpDir, tool, withSnapshot } from './helpers.js'

// The stub indexer is a script on PATH that writes a fixed, hand-written index; no real indexer is ever run here.
const GO = 'scip-go gomod example.com/sentinel v0 '
const lineOf = (file: string, n: number) => fs.readFileSync(path.join(fixtureRepo('go-sentinel'), file), 'utf8').split('\n')[n]!.length
const INDEX: Doc[] = [
  { path: 'main.go', language: 'go', typed: true, occurrences: [
    { symbol: `${GO}\`example.com/sentinel\`/main().`, range: [10, 5, 9], enclosing: [10, 0, 10, lineOf('main.go', 10)], def: true },
    { symbol: `${GO}\`example.com/sentinel\`/Greeting().`, range: [10, 22, 30] },
  ], symbols: [{ symbol: `${GO}\`example.com/sentinel\`/main().`, kind: 17 }] },
  { path: 'util.go', language: 'go', typed: true, occurrences: [
    { symbol: `${GO}\`example.com/sentinel\`/Greeting().`, range: [2, 5, 13], enclosing: [2, 0, 2, lineOf('util.go', 2)], def: true },
  ], symbols: [{ symbol: `${GO}\`example.com/sentinel\`/Greeting().`, kind: 17, signature: 'func Greeting(name string) string' }] },
]
// A project root that does not exist: the paths are then relative to the repository, as they are for an index produced in a copy.
const BYTES = Buffer.from(encode('/nonexistent/stub-root', 'scip-go', INDEX)).toString('base64')

type Mode = 'ok' | 'ignore-sigterm' | 'flood' | 'never' | 'memory' | 'network' | 'gate' | 'bad-index' | 'fifo' | 'symlink' | 'wrong-version'
type Stub = { dir: string; calls: () => Array<{ argv: string[]; cwd: string; env: Record<string, string> }>; digest: string; ready: string; go: string }
/** An executable `scip-go` that records each call, then behaves as `mode` says. */
function stub(mode: Mode, name = 'scip-go'): Stub {
  const reported = mode === 'wrong-version' ? 'v0.0.1' : 'v0.2.9'
  const dir = fs.realpathSync(tmpDir('pm-stub-')), invoked = path.join(dir, 'invoked.jsonl'), ready = path.join(dir, 'ready'), go = path.join(dir, 'go')
  const script = `#!${process.execPath}
const fs = require('fs')
if (process.argv[2] === '--version') { process.stdout.write('scip-go version ' + ${JSON.stringify(reported)} + '\\n'); process.exit(0) }
fs.appendFileSync(${JSON.stringify(invoked)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env }) + '\\n')
const at = process.argv.indexOf('--output'), out = at >= 0 ? process.argv[at + 1] : 'index.scip'
const index = Buffer.from(${JSON.stringify(BYTES)}, 'base64')
const mode = ${JSON.stringify(mode)}
if (mode === 'ignore-sigterm') { process.on('SIGTERM', () => {}); fs.writeFileSync(out, index.subarray(0, 20)); setInterval(() => {}, 1000) }
else if (mode === 'never') { fs.writeFileSync(out, index.subarray(0, 20)); setInterval(() => {}, 1000) }
else if (mode === 'memory') { const hold = Buffer.alloc(400 * 1024 * 1024, 1); fs.writeFileSync(out, index.subarray(0, 20)); setInterval(() => { hold[0] = 2 }, 1000) }
else if (mode === 'network') { process.stderr.write('go: example.com/dep@v1.0.0: downloading the module: dial tcp: network is unreachable\\n'); process.exit(1) }
else if (mode === 'fifo') { require('child_process').execFileSync('mkfifo', [out]) }
else if (mode === 'symlink') { fs.symlinkSync('/etc/hosts', out) }
else if (mode === 'bad-index') { fs.writeFileSync(out, Buffer.from('this is not a scip index')) }
else if (mode === 'gate') { fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); const wait = () => (fs.existsSync(${JSON.stringify(go)}) ? (fs.writeFileSync(out, index)) : setTimeout(wait, 20)); wait() }
else {
  if (mode === 'flood') for (let i = 0; i < 40; i++) { process.stdout.write('x'.repeat(256 * 1024)); process.stderr.write('y'.repeat(256 * 1024)) }
  fs.writeFileSync(out, index)
}
`
  fs.writeFileSync(path.join(dir, name), script, { mode: 0o755 })
  const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')
  return { dir, digest, ready, go, calls: () => (fs.existsSync(invoked) ? fs.readFileSync(invoked, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) }
}

/** The go-sentinel fixture registered and indexed (the syntax tier), with a private HOME that the fixture's go:generate would write into. */
function setup() {
  const repo = fs.realpathSync(tmpDir('pm-scip-run-')), home = fs.realpathSync(tmpDir('pm-home-')), d = tmpDir()
  fs.cpSync(fixtureRepo('go-sentinel'), repo, { recursive: true })
  const env = { HOME: home }
  const run = (...args: string[]) => cli(['--data-dir', d, ...args], { ...env, ...extra })
  const extra: Record<string, string> = {}
  for (const args of [['init'], ['repo', 'add', repo]]) expect(run(...args).status).toBe(0)
  const catalog = Catalog.open(d), id = catalog.repositories()[0]!.id
  catalog.close()
  expect(run('index', repo).status).toBe(0)
  const pin = (s: Stub, tool = 'scip-go') => fs.writeFileSync(path.join(d, 'indexers.json'), JSON.stringify({ [tool]: { sha256: s.digest } }))
  const withPath = (s?: Stub) => { extra.PATH = `${s ? s.dir + path.delimiter : ''}${process.env.PATH}` }
  const marker = path.join(home, 'proofmesh-sentinel-ran')
  return { repo, home, d, id, run, pin, withPath, marker, extra }
}
const files = (d: string) => withSnapshot(d, (db) => db.prepare(`select f.path, f.disposition_detail as detail, group_concat(distinct ev.extractor) as producer from file f left join symbol s on s.file_id = f.id left join evidence ev on ev.id = s.evidence_id
  where f.path like '%.go' group by f.path order by f.path`).all())
const runDir = (t: { d: string; id: string }) => { const dir = path.join(t.d, 'scip-run', t.id); return fs.existsSync(dir) ? fs.readdirSync(dir) : [] }
const noMarker = (dir: string) => { const found: string[] = []; const walk = (p: string) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) e.isDirectory() ? walk(path.join(p, e.name)) : e.name === 'proofmesh-sentinel-ran' && found.push(path.join(p, e.name)) }; walk(dir); return found }

describe('FR227 proofmesh scip run refuses without a build-evaluation grant, runs nothing, and only the CLI can start it', () => {
  it('scenario 1: TRUST_REQUIRED, the grant command and the indexer command a person could run, and the stub is never started', () => {
    const t = setup(), s = stub('ok')
    t.pin(s); t.withPath(s)
    const r = t.run('scip', 'run', t.repo, '--language', 'go')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/TRUST_REQUIRED/)
    expect(r.stderr).toContain(`proofmesh repo trust ${t.id} --build-evaluation`)
    expect(r.stderr).toContain('`scip-go` for go')
    expect(r.stderr).toContain(`proofmesh scip add ${t.id} <index.scip>`)
    expect(s.calls()).toEqual([])
    expect(t.run('scip', 'list', t.repo).stdout).toMatch(/no SCIP indexes named/)
    expect(noMarker(t.home)).toEqual([])
    expect(fs.existsSync(path.join(t.d, 'scip-run'))).toBe(false)
  }, 240000)

  it('scenario 5: no MCP or HTTP tool starts an indexer, and neither server loads the code that does', () => {
    const t = setup()
    expect(TOOLS.filter((n) => /scip|indexer/i.test(n))).toEqual([])
    // The import boundary itself is asserted beside the launcher's, in contract.test.ts.
    expect(fs.readFileSync(path.join(ROOT, 'packages', 'proofmesh', 'test', 'contract.test.ts'), 'utf8')).toContain("expect(reachable('mcp/server.ts')).not.toContain('scip/run.ts')")
  })
})

describe('FR228 scip run runs only a pinned indexer, in a disposable copy, offline, and names the result with the indexer identity', () => {
  it('scenario 2: with a grant the pinned indexer runs once in a copy, the working tree is untouched, and the index records indexer, version, digest and grant', () => {
    const t = setup(), s = stub('ok')
    t.pin(s); t.withPath(s)
    const before = fs.readdirSync(t.repo).sort()
    const grant = t.run('repo', 'trust', t.repo, '--build-evaluation')
    expect(grant.status).toBe(0)
    const r = t.run('scip', 'run', t.repo, '--language', 'go')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain(`produced by scip-go v0.2.9 (sha256 ${s.digest})`)
    const [call] = s.calls()
    expect(s.calls()).toHaveLength(1)
    expect(call!.cwd).not.toBe(t.repo)
    expect(call!.cwd.startsWith(t.repo)).toBe(false)
    expect(fs.readdirSync(t.repo).sort()).toEqual(before)
    expect(fs.existsSync(path.join(t.repo, 'index.scip'))).toBe(false)
    expect(fs.existsSync(call!.cwd)).toBe(false)
    expect(noMarker(t.home)).toEqual([])
    const list = t.run('scip', 'list', t.repo).stdout
    expect(list).toMatch(/^scip-go {2}\S+scip-go\.scip {2}2 files {2}scip-go 1\.0 {2}current {2}by \S+ at \S+ {2}run by proofmesh: scip-go v0\.2\.9 sha256 [0-9a-f]{64}, grant trust_\w+, process/)
    expect(list).toContain(s.digest)
  }, 240000)

  it('an indexer that is not installed fails with the exact install command and nothing is downloaded', () => {
    const t = setup()
    t.run('repo', 'trust', t.repo, '--build-evaluation')
    t.extra.PATH = path.dirname(process.execPath)
    const r = t.run('scip', 'run', t.repo, '--language', 'go')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/DEPENDENCY_UNAVAILABLE: scip-go is not installed; Proofmesh never downloads an indexer\. Install it with: go install github\.com\/sourcegraph\/scip-go\/cmd\/scip-go@v0\.2\.9/)
  }, 240000)

  it('an executable that reports another version, or has another digest than the one pinned in the data directory, is refused and never started', () => {
    const t = setup(), s = stub('wrong-version')
    t.run('repo', 'trust', t.repo, '--build-evaluation'); t.withPath(s)
    const other = t.run('scip', 'run', t.repo, '--language', 'go')
    expect(other.stderr).toMatch(/INTEGRITY_FAILURE: .* reports "scip-go version v0\.0\.1", not the pinned scip-go v0\.2\.9/)
    fs.writeFileSync(path.join(t.d, 'indexers.json'), JSON.stringify({ 'scip-go': { sha256: '0'.repeat(64) } }))
    const wrong = t.run('scip', 'run', t.repo, '--language', 'go')
    expect(wrong.stderr).toMatch(/INTEGRITY_FAILURE: .* has sha256 [0-9a-f]{64}, not the 0{64} pinned in/)
    expect(s.calls()).toEqual([])
  }, 240000)

  it('the table pins releases with their published asset names and digests, and the installed binary\'s own digest is recorded in the index', async () => {
    const { INDEXERS } = await import('../src/scip/indexers.js')
    expect(INDEXERS.map((i) => [i.tool, i.version])).toEqual([['scip-go', 'v0.2.9'], ['scip-java', 'v0.13.2'], ['rust-analyzer', '2026-11-09']])
    expect(INDEXERS[0]!.assets['darwin-arm64']).toEqual({ name: 'scip-go-darwin-arm64.tar.gz', sha256: '3d8a0c14d0617debcf0c38debe4532d201c89c38a85eaac641da2200bb36d68f' })
    for (const i of INDEXERS) for (const a of Object.values(i.assets)) expect(a.sha256).toMatch(/^[0-9a-f]{64}$/)
    const t = setup(), s = stub('ok')
    t.withPath(s)
    t.run('repo', 'trust', t.repo, '--build-evaluation')
    expect(t.run('scip', 'run', t.repo, '--language', 'go').status).toBe(0)
    expect(t.run('scip', 'list', t.repo).stdout).toContain(`sha256 ${s.digest}`)
  }, 240000)

  it('scenario 3: the indexer gets an allowlisted environment with a private HOME and only the declared module cache, and a fetch that needs the network fails the run with its log', () => {
    const t = setup(), s = stub('ok'), cache = fs.realpathSync(tmpDir('pm-cache-'))
    t.pin(s); t.withPath(s)
    t.run('repo', 'trust', t.repo, '--build-evaluation')
    expect(t.run('scip', 'run', t.repo, '--language', 'go', '--module-cache', cache).status).toBe(0)
    const { env, argv } = s.calls()[0]!
    const keys = Object.keys(env).filter((k) => !k.startsWith('__')).sort()
    expect(keys).toEqual(['CGO_ENABLED', 'GOCACHE', 'GOFLAGS', 'GOMODCACHE', 'GOPROXY', 'GOTOOLCHAIN', 'HOME', 'PATH'])
    expect(env.GOMODCACHE).toBe(cache)
    expect(env.GOPROXY).toBe('off')
    expect(env.CGO_ENABLED).toBe('0')
    expect(env.HOME).not.toBe(t.home)
    expect(argv[0]).toBe('--output')
    const net = stub('network')
    t.pin(net); t.withPath(net)
    const r = t.run('scip', 'run', t.repo, '--language', 'go', '--module-cache', cache)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/exited with code 1; no index was named\. Its log:\n.*network is unreachable/)
  }, 240000)

  it('a container run has no network, a read-only cache and only the copy writable', () => {
    const argv = containerArgv('img@sha256:' + 'a'.repeat(64), '/w', '/c', { GOPROXY: 'off' }, 512, ['scip-go', '--output', '/work/index.scip'], 'proofmesh-scip-x')
    expect(argv.slice(0, 7)).toEqual(['docker', 'run', '--rm', '--name', 'proofmesh-scip-x', '--network', 'none'])
    expect(argv).toContain('--read-only')
    expect(argv).toContain('/c:/cache:ro')
    expect(argv).toContain('/w:/work')
    expect(argv.slice(-4)).toEqual(['img@sha256:' + 'a'.repeat(64), 'scip-go', '--output', '/work/index.scip'])
  })

  it('rust-analyzer runs with build scripts and procedural macros off, and scip-java and scip-go are told to work offline', async () => {
    const { INDEXERS } = await import('../src/scip/indexers.js')
    const ctx = { dir: '/w', out: '/w/index.scip', cache: '/c', home: '/h' }
    const ra = INDEXERS.find((i) => i.tool === 'rust-analyzer')!
    expect(JSON.parse(ra.files!()['.proofmesh-rust-analyzer.json']!)).toEqual({ 'cargo.buildScripts.enable': false, 'procMacro.enable': false })
    expect(ra.args(ctx)).toEqual(['--config-path', '/w/.proofmesh-rust-analyzer.json', 'scip', '.', '--output', '/w/index.scip'])
    expect(ra.env(ctx).CARGO_NET_OFFLINE).toBe('true')
    expect(INDEXERS.find((i) => i.tool === 'scip-java')!.env(ctx).MAVEN_ARGS).toMatch(/^-o /)
    expect(INDEXERS.find((i) => i.tool === 'scip-go')!.env(ctx).GOPROXY).toBe('off')
  })

  it.each([
    ['ignores SIGTERM', 'ignore-sigterm', ['--timeout', '2'], /BUDGET_EXCEEDED: scip-go was stopped after 2 s; its partial output was discarded/],
    ['never exits', 'never', ['--timeout', '2'], /BUDGET_EXCEEDED: scip-go was stopped after 2 s/],
    ['uses more memory than the budget', 'memory', ['--max-memory', '150'], /BUDGET_EXCEEDED: scip-go was stopped for using more than 150 MB; its partial output was discarded/],
    ['writes a file that is not an index', 'bad-index', [], /not a SCIP index/],
  ] as const)('an indexer that %s is stopped, its partial output is discarded and never named', (_n, mode, flags, message) => {
    const t = setup(), s = stub(mode)
    t.pin(s); t.withPath(s)
    t.run('repo', 'trust', t.repo, '--build-evaluation')
    const r = t.run('scip', 'run', t.repo, '--language', 'go', ...flags)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(message)
    expect(t.run('scip', 'list', t.repo).stdout).toMatch(/no SCIP indexes named/)
    expect(runDir(t).filter((f) => f.endsWith('.scip') || f.startsWith('work-'))).toEqual([])
  }, 240000)

  it('an indexer that floods its output is capped and the run still succeeds', () => {
    const t = setup(), s = stub('flood')
    t.pin(s); t.withPath(s)
    t.run('repo', 'trust', t.repo, '--build-evaluation')
    const r = t.run('scip', 'run', t.repo, '--language', 'go')
    expect(r.status, r.stderr).toBe(0)
    const logs = runDir(t).filter((f) => /^scip-go-[0-9a-f]+\.log$/.test(f))
    expect(logs).toHaveLength(1)
    expect(fs.statSync(path.join(t.d, 'scip-run', t.id, logs[0]!)).size).toBeLessThanOrEqual(256 * 1024)
  }, 240000)

  it('a grant made or revoked while an indexer runs is not the run: a revoked one discards the result, a new one covers the next run', async () => {
    const t = setup(), s = stub('gate')
    t.pin(s); t.withPath(s)
    const catalog = Catalog.open(t.d), first = catalog.grantTrust(t.id, 'test')
    const realPath = process.env.PATH
    process.env.PATH = `${s.dir}${path.delimiter}${realPath}`
    try {
      await expect(runScip(t.d, t.id, {
        language: 'go',
        whileRunning: async () => {
          while (!fs.existsSync(s.ready)) await new Promise((r) => setTimeout(r, 20))
          catalog.revokeTrust(t.id); catalog.grantTrust(t.id, 'test')
          fs.writeFileSync(s.go, 'go')
        },
      })).rejects.toThrow(/was revoked while scip-go ran; its output was discarded and no index was named/)
      expect(catalog.scipIndexes(t.id)).toEqual([])
      fs.rmSync(s.go)
      fs.rmSync(s.ready)
      fs.writeFileSync(s.go, 'go')
      const [next] = await runScip(t.d, t.id, { language: 'go' })
      expect(next!.grantId).toBe(catalog.activeTrust(t.id)!.id)
      expect(next!.grantId).not.toBe(first.id)
    } finally {
      process.env.PATH = realPath
      catalog.close()
    }
  }, 240000)
})

describe('FR228 the correction pass: containers, grants at naming, concurrent runs, odd output files, flags', () => {
  /** A `docker` on PATH that records its arguments and, for `run`, never returns on its own. */
  function fakeDocker() {
    const dir = fs.realpathSync(tmpDir('pm-docker-')), log = path.join(dir, 'docker.jsonl')
    fs.writeFileSync(path.join(dir, 'docker'), `#!${process.execPath}
const fs = require('fs')
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')
if (process.argv[2] === 'run') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000) }
`, { mode: 0o755 })
    return { dir, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []) }
  }

  it('finding 1: a container that outlives its timed-out client is removed by name', () => {
    const t = setup(), docker = fakeDocker()
    t.run('repo', 'trust', t.repo, '--build-evaluation')
    t.extra.PATH = `${docker.dir}${path.delimiter}${process.env.PATH}`
    const r = t.run('scip', 'run', t.repo, '--language', 'go', '--container', `img@sha256:${'a'.repeat(64)}`, '--timeout', '2')
    expect(r.stderr).toMatch(/BUDGET_EXCEEDED: scip-go was stopped after 2 s/)
    const [run] = docker.calls().filter((c) => c[0] === 'run')
    const name = run![run!.indexOf('--name') + 1]!
    expect(name).toMatch(/^proofmesh-scip-[0-9a-f]+$/)
    expect(docker.calls().filter((c) => c[0] === 'rm')).toEqual([['rm', '-f', name]])
  }, 240000)

  it('finding 2: an index is not named under a grant that was revoked, whatever happened before', () => {
    const t = setup()
    const catalog = Catalog.open(t.d), grant = catalog.grantTrust(t.id, 'test')
    catalog.revokeTrust(t.id)
    const index = { name: 'scip-go', path: '/x', sha256: 'a'.repeat(64), tool: 't', files: {}, run: { indexer: 'scip-go', version: 'v0.2.9', digest: 'b'.repeat(64), grant_id: grant.id, isolation: 'process' as const, module_cache: '/c' } }
    expect(() => catalog.addScip(t.id, index, 'test')).toThrow(/was revoked while scip-go ran; its output was discarded and no index was named/)
    expect(catalog.scipIndexes(t.id)).toEqual([])
    const fresh = catalog.grantTrust(t.id, 'test')
    expect(catalog.addScip(t.id, { ...index, run: { ...index.run, grant_id: fresh.id } }, 'test').run!.grant_id).toBe(fresh.id)
    catalog.close()
  })

  it('finding 3: two runs of one indexer at once use their own copy, log and index file, and the record matches its file', async () => {
    const t = setup(), s = stub('gate')
    t.pin(s); t.withPath(s)
    const catalog = Catalog.open(t.d)
    catalog.grantTrust(t.id, 'test')
    const realPath = process.env.PATH
    process.env.PATH = `${s.dir}${path.delimiter}${realPath}`
    try {
      const both = Promise.all([runScip(t.d, t.id, { language: 'go' }), runScip(t.d, t.id, { language: 'go' })])
      while (s.calls().length < 2) await new Promise((r) => setTimeout(r, 20))
      fs.writeFileSync(s.go, 'go')
      const [[a], [b]] = await both
      const [first, second] = s.calls()
      expect(first!.cwd).not.toBe(second!.cwd)
      expect(a!.log).not.toBe(b!.log)
      const [record] = catalog.scipIndexes(t.id)
      expect(fs.existsSync(record!.path)).toBe(true)
      expect(crypto.createHash('sha256').update(fs.readFileSync(record!.path)).digest('hex')).toBe(record!.sha256)
      expect(runDir(t).filter((f) => f.startsWith('work-'))).toEqual([])
    } finally {
      process.env.PATH = realPath
      catalog.close()
    }
  }, 240000)

  it.each([
    ['a FIFO', 'fifo'],
    ['a symlink', 'symlink'],
  ] as const)('finding 4: index.scip left as %s is refused without being read', (_n, mode) => {
    const t = setup(), s = stub(mode)
    t.pin(s); t.withPath(s)
    t.run('repo', 'trust', t.repo, '--build-evaluation')
    const r = t.run('scip', 'run', t.repo, '--language', 'go', '--timeout', '20')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/left index\.scip as something other than a regular file; no index was named/)
    expect(t.run('scip', 'list', t.repo).stdout).toMatch(/no SCIP indexes named/)
  }, 60000)

  it('finding 5: a revoked index does not hide a later valid one that covers the same files', () => {
    const t = setup(), s = stub('ok')
    t.pin(s); t.withPath(s)
    t.run('repo', 'trust', t.repo, '--build-evaluation')
    expect(t.run('scip', 'run', t.repo, '--language', 'go').status).toBe(0)
    t.run('repo', 'untrust', t.repo)
    const file = path.join(tmpDir('pm-named-'), 'zz-manual.scip')
    fs.writeFileSync(file, encode(t.repo, 'hand-written', INDEX))
    expect(t.run('scip', 'add', t.repo, file).status).toBe(0)
    expect(t.run('index', t.repo).status).toBe(0)
    expect(files(t.d)).toEqual([{ path: 'main.go', detail: null, producer: 'scip' }, { path: 'util.go', detail: null, producer: 'scip' }])
    expect(withSnapshot(t.d, (db) => db.prepare("select value from meta where key = 'analysis_mode'").get())).toEqual({ value: 'no_execution' })
  }, 240000)

  it('finding 6: a limit that is not a sane whole number is refused before anything starts', () => {
    const t = setup(), s = stub('ok')
    t.pin(s); t.withPath(s)
    t.run('repo', 'trust', t.repo, '--build-evaluation')
    for (const [flag, value] of [['--max-memory', '9'.repeat(400)], ['--max-memory', '1048577'], ['--timeout', '86401'], ['--timeout', '0']]) {
      const r = t.run('scip', 'run', t.repo, '--language', 'go', flag!, value!)
      expect(r.status, `${flag} ${value!.slice(0, 10)}`).toBe(1)
      expect(r.stderr).toMatch(/INVALID_ARGUMENT: --[a-z-]+ takes a whole number from 1 to \d+/)
    }
    expect(s.calls()).toEqual([])
  }, 240000)

  it('finding 7: the help describes what a build-evaluation grant allows, not only C#', () => {
    const help = cli([]).stdout + cli(['help']).stdout
    const line = help.split('\n').find((l) => l.includes('repo trust <repo> --build-evaluation'))
    expect(line).toBeDefined()
    expect(line).not.toContain('(C#)')
    expect(line).toContain('scip run')
  })
})

describe('FR229 facts from a run are trusted_build, shown everywhere, and revoking the grant returns files to their tier with unchanged keys', () => {
  it('scenarios 2 and 4: scip facts record trusted_build and show it; untrusting returns the files to the syntax tier, keys unchanged, and the census names the revoked grant', () => {
    const t = setup(), s = stub('ok')
    t.pin(s); t.withPath(s)
    const keys = () => withSnapshot(t.d, (db) => db.prepare("select stable_key from symbol where kind != 'module' order by stable_key collate binary").all())
    const baseline = keys()
    expect(baseline.length).toBeGreaterThan(0)
    expect(files(t.d)).toEqual([{ path: 'main.go', detail: null, producer: 'syntax' }, { path: 'util.go', detail: null, producer: 'syntax' }])

    t.run('repo', 'trust', t.repo, '--build-evaluation')
    expect(t.run('scip', 'run', t.repo, '--language', 'go').status).toBe(0)
    expect(t.run('index', t.repo).status).toBe(0)
    expect(files(t.d)).toEqual([{ path: 'main.go', detail: null, producer: 'scip' }, { path: 'util.go', detail: null, producer: 'scip' }])
    expect(withSnapshot(t.d, (db) => db.prepare("select distinct ev.analysis_mode as m from evidence ev join symbol s on s.evidence_id = ev.id join file f on f.id = ev.file_id where ev.extractor = 'scip'").all())).toEqual([{ m: 'trusted_build' }])
    const adapters = withSnapshot(t.d, (db) => JSON.parse((db.prepare("select value from meta where key = 'adapters'").get() as { value: string }).value)) as Array<{ id: string; analysis_mode: string; external_inputs: string[] }>
    const scip = adapters.find((a) => a.id === 'scip')!
    expect(scip.analysis_mode).toBe('trusted_build')
    expect(scip.external_inputs.find((i) => i.startsWith('scip-run:'))).toBe(`scip-run:scip-go/scip-go v0.2.9 ${s.digest} process`)
    expect(withSnapshot(t.d, (db) => db.prepare("select value from meta where key = 'analysis_mode'").get())).toEqual({ value: 'trusted_build' })
    const status = tool(t.d, 'workspace_status', {})
    expect((status.snapshot as { analysis_mode: string }).analysis_mode).toBe('trusted_build')
    expect((status.data.analysis as { mode: string }).mode).toBe('trusted_build')
    expect(withSnapshot(t.d, (db) => db.prepare("select count(*) as n from symbol s join evidence ev on ev.id = s.evidence_id where ev.extractor = 'scip'").get())).toEqual({ n: 4 })

    const catalog = Catalog.open(t.d), grantId = catalog.scipIndexes(t.id)[0]!.run!.grant_id
    catalog.close()
    expect(t.run('repo', 'untrust', t.repo).status).toBe(0)
    expect(t.run('index', t.repo).status).toBe(0)
    expect(files(t.d)).toEqual([{ path: 'main.go', detail: `scip_revoked:scip-go:${grantId}`, producer: 'syntax' }, { path: 'util.go', detail: `scip_revoked:scip-go:${grantId}`, producer: 'syntax' }])
    expect(keys()).toEqual(baseline)
    expect(withSnapshot(t.d, (db) => db.prepare("select value from meta where key = 'analysis_mode'").get())).toEqual({ value: 'no_execution' })
    const go = (tool(t.d, 'workspace_status', {}).data.languages as Array<{ language: string; reason: string; remedy: string; tier: string }>).find((r) => r.language === 'Go')!
    expect(go.tier).toBe('syntax')
    expect(go.reason).toBe(`scip_revoked:scip-go:${grantId}`)
    expect(go.remedy).toContain(`grant ${grantId}, which was revoked`)
    expect(noMarker(t.home)).toEqual([])
  }, 240000)

  it('an index a person named is unaffected by a revoked grant', () => {
    const t = setup()
    t.run('repo', 'trust', t.repo, '--build-evaluation')
    t.run('repo', 'untrust', t.repo)
    const file = path.join(tmpDir('pm-named-'), 'named.scip')
    fs.writeFileSync(file, encode(t.repo, 'hand-written', INDEX))
    expect(t.run('scip', 'add', t.repo, file).status).toBe(0)
    expect(t.run('index', t.repo).status).toBe(0)
    expect(files(t.d).map((f) => (f as { producer: string }).producer)).toEqual(['scip', 'scip'])
    expect(withSnapshot(t.d, (db) => db.prepare("select value from meta where key = 'analysis_mode'").get())).toEqual({ value: 'no_execution' })
  }, 240000)
})

describe('FR230 ADR-0001 records the amendment to A24', () => {
  it('amendment A38 says a pinned indexer may run for a repository trusted for build evaluation, and A24 points to it', () => {
    const adr = fs.readFileSync(path.join(ROOT, 'docs', 'proofmesh', 'adr', '0001-proofmesh.md'), 'utf8')
    expect(adr).toMatch(/^- A38 \(.+\)\. .*scip run.*build-evaluation/m)
    expect(adr).toMatch(/^- A24 \(M4\)\. .*Amended by A38/m)
    expect(adr).toMatch(/^- Revision 24, .*A38/m)
  })
})
