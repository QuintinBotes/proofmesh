// Cross-repository calls on a public library and application pair (#28, scenario 4, SC-002). The truth is the TypeScript checker
// over the application with the library's source (bench/graph-bench/truth.mjs, the application's tsconfig with the library's
// package mapped to its src/): every call or construction in the application whose callee is declared in the library. ProofMesh
// indexes the two as two repositories, the application with the published package installed, links them in one workspace, and is
// asked over MCP, from the library's side, for each callee's inbound calls with include_workspace. A truth site is resolved when a
// resolved row names its file:line in the application.
//
//   sh bench/parity/xrepo.sh          builds the fixture once, then runs this; exits 1 under 95%
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(ROOT, 'packages/proofmesh/package.json'))
const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'))
const { StdioClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/stdio.js'))
const CLI = path.join(ROOT, 'packages/proofmesh/bin/proofmesh.mjs')
const at = process.argv.indexOf('--fixture')
const FIXTURE = fs.realpathSync(at > 0 ? process.argv[at + 1] : path.join(os.tmpdir(), 'parity-xrepo'))
const ts = require(path.join(ROOT, 'node_modules/typescript'))
// The package's name and the library source file its published entry is built from, written by xrepo.sh.
const { package: PACKAGE, entry: ENTRY } = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'pair.json'), 'utf8'))

// Each run works on its own copy, removed when it ends.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-parity-xrepo-'))
console.error(`xrepo: fixture copy ${work}`)
try {
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=parity', '-c', 'user.email=parity@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' }).trim()
  for (const side of ['lib', 'app']) {
    fs.cpSync(path.join(FIXTURE, side), path.join(work, side), { recursive: true })
    git(path.join(work, side), 'init', '-q'); git(path.join(work, side), 'add', '-A'); git(path.join(work, side), 'commit', '-q', '-m', side)
  }
  fs.cpSync(path.join(FIXTURE, 'installed', PACKAGE), path.join(work, 'app/node_modules', PACKAGE), { recursive: true })
  fs.writeFileSync(path.join(work, 'app/.git/info/exclude'), 'node_modules/\n')

  // Truth: the application's compiler options, its sources, and the package mapped to the library's source, at the root of the copy.
  const app = ts.readConfigFile(path.join(work, 'app/tsconfig.json'), ts.sys.readFile).config
  fs.writeFileSync(path.join(work, 'tsconfig.json'), JSON.stringify({ compilerOptions: { ...app.compilerOptions, plugins: undefined, outDir: undefined, noEmit: true, baseUrl: '.', paths: { [PACKAGE]: [ENTRY] } }, include: ['app/src/**/*.ts'] }))
  execFileSync(process.execPath, [path.join(ROOT, 'bench/graph-bench/truth.mjs'), work, path.join(work, 'truth.json')], { stdio: ['ignore', 'ignore', 'inherit'] })
  const truth = JSON.parse(fs.readFileSync(path.join(work, 'truth.json'), 'utf8'))
  const symbols = new Map(truth.symbols.map((s) => [s.id, s]))
  const sites = truth.calls.filter((c) => c.file.startsWith('app/') && c.callee.startsWith('lib/')).map((c) => ({ site: `${c.file.slice(4)}:${c.line}`, callee: symbols.get(c.callee) }))
  const want = new Map()
  for (const s of sites) { const k = `${s.callee.file.slice(4)}#${s.callee.qname}`; want.set(k, [...(want.get(k) ?? []), s.site]) }

  // ProofMesh: two repositories in one workspace, linked, asked from the library's side.
  const data = path.join(work, 'data')
  const run = (...args) => execFileSync(process.execPath, [CLI, '--data-dir', data, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
  run('init')
  const lib = run('repo', 'add', path.join(work, 'lib'), '--name', 'lib')
  run('repo', 'add', path.join(work, 'app'), '--name', 'app')
  run('index', path.join(work, 'lib')); run('index', path.join(work, 'app'))
  run('workspace', 'add', 'pair', path.join(work, 'lib'), path.join(work, 'app'))
  console.error(run('workspace', 'link', 'pair'))
  const client = new Client({ name: 'parity-xrepo', version: '0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, '--data-dir', data, 'mcp'], stderr: 'ignore' }))
  let hit = 0, total = 0, extra = 0
  const rows = []
  for (const [key, expected] of [...want].sort()) {
    const [file, qname] = key.split('#')
    const r = await client.callTool({ name: 'get_relationships', arguments: { repository_id: lib, subject_id: { name: qname, path: file }, direction: 'in', types: ['calls'], include_workspace: true, envelope: 'full', limits: { max_rows: 5000, max_bytes: 4000000 } } })
    const text = r.content[0].text
    if (r.isError) { rows.push([key, expected.length, 0, `error: ${text.slice(0, 120)}`]); total += expected.length; continue }
    const got = new Set(JSON.parse(text).data.relationships.filter((x) => x.repository && x.resolution === 'resolved').map((x) => `${x.site.path}:${x.site.start_line}`))
    const found = expected.filter((s) => got.has(s)).length, missed = expected.filter((s) => !got.has(s))
    const more = [...got].filter((s) => !expected.includes(s))
    hit += found; total += expected.length; extra += more.length
    rows.push([key, expected.length, found, [...missed.map((m) => `missed ${m}`), ...more.map((m) => `extra ${m}`)].join(' ')])
  }
  await client.close()
  const pct = total ? (100 * hit) / total : 0
  console.log(`| callee in ${PACKAGE} | checker sites | resolved by ProofMesh | notes |\n|---|---|---|---|`)
  for (const [k, n, f, note] of rows) console.log(`| ${k} | ${n} | ${f} | ${note} |`)
  console.log(`\n${hit} of ${total} application call sites into ${PACKAGE} resolved to the library's symbol (${pct.toFixed(1)}%); ${extra} resolved rows the checker does not count. typescript ${truth.ts_version}.`)
  process.exitCode = pct >= 95 ? 0 : 1
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}
