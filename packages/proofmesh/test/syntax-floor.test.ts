import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Catalog } from '../src/meshstore/catalog.js'
import { cli, evidenceSlice, expectedFor, fixtureRepo, tmpDir, tool, withSnapshot } from './helpers.js'

const fake = (name: string) => path.join(import.meta.dirname, 'fake-adapters', name)
const NO_CS = { PROOFMESH_CS_ADAPTER: '/nonexistent/Proofmesh.Adapter.CSharp.dll' }

const fresh = (repo: string) => {
  const d = tmpDir()
  for (const args of [['init'], ['repo', 'add', repo]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
  return d
}
/** Indexes a repository and returns its data directory, the CLI's output, and the finished job's result. */
function index(repo: string, env: Record<string, string> = {}, d = fresh(repo)) {
  const r = cli(['--data-dir', d, 'index', repo], env)
  expect(r.status, r.stderr).toBe(0)
  const c = Catalog.open(d)
  try {
    const jobs = c.db.prepare("select result from index_job where state = 'succeeded' order by rowid desc").all() as Array<{ result: string }>
    return { d, stdout: r.stdout, result: JSON.parse(jobs[0]!.result) as { status: string; fallbacks?: Array<{ adapter: string; files: number; reason: string }> }, stored: JSON.stringify([c.db.prepare('select * from index_job').all(), c.db.prepare('select * from snapshot').all()]) }
  } finally { c.close() }
}
type FileRow = { path: string; disposition: string; detail: string | null; tier: string | undefined; framework: string | undefined }
const files = (d: string) => withSnapshot(d, (db) => (db.prepare('select path, disposition, disposition_detail as detail, capabilities from file order by path').all() as Array<{ path: string; disposition: string; detail: string | null; capabilities: string }>)
  .map((f): FileRow => ({ path: f.path, disposition: f.disposition, detail: f.detail, tier: JSON.parse(f.capabilities).tier, framework: JSON.parse(f.capabilities).framework })))
const symbols = (d: string, where = '1 = 1') => withSnapshot(d, (db) => db.prepare(`select f.path as file, s.kind, s.qualified_name as qn, s.start_line as a, s.end_line as b, s.stable_key as key, e.extractor from symbol s join file f on f.id = s.file_id join evidence e on e.id = s.evidence_id where ${where} order by f.path, s.start_byte`).all() as Array<{ file: string; kind: string; qn: string; a: number; b: number; key: string; extractor: string }>)
// One row per call site: two calls that start at the same byte, `new A().B()`, are one assertion with two sites, as for every adapter.
const calls = (d: string) => withSnapshot(d, (db) => (db.prepare("select s.qualified_name as \"from\", a.resolution, a.reason, a.origin, a.detail, ae.evidence_id as ev from assertion a join symbol s on s.id = a.source_id join assertion_evidence ae on ae.assertion_id = a.id where a.type = 'calls'").all() as Array<{ from: string; resolution: string; reason: string | null; origin: string; detail: string; ev: string }>)
  .map((c) => ({ from: c.from, resolution: c.resolution, reason: c.reason, origin: c.origin, callee: JSON.parse(c.detail).callee as string, site: evidenceSlice(d, db, c.ev) })).sort((x, y) => (`${x.from}|${x.site}` < `${y.from}|${y.site}` ? -1 : 1)))
const censusRow = (d: string, language: string) => (tool(d, 'workspace_status').data.languages as Array<{ language: string; tier: string; reason: string | null; remedy: string | null; capabilities: Record<string, Record<string, number>> }>).find((r) => r.language === language)!
const write = (root: string, entries: Record<string, string>) => {
  for (const [p, text] of Object.entries(entries)) { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), text) }
  return root
}
const tsModule = () => { const repo = fs.realpathSync(tmpDir('pm-floor-')); fs.cpSync(fixtureRepo('ts-module'), repo, { recursive: true }); return repo }

// Syntax-tier facts of fixtures/cs-orders, written by hand from its sources: the declarations of expected.json (the project symbols
// come from the project files, which the syntax tier does not read), and each call by the name it calls.
const CS_ORACLE = expectedFor('cs-orders') as { symbols: Array<{ kind: string; qualified_name: string; lines: [number, number] }> }
const CS_SYNTAX_SYMBOLS = CS_ORACLE.symbols.filter((s) => s.kind !== 'project').map((s) => [s.kind, s.qualified_name, ...s.lines].join('|')).sort()
const CS_SYNTAX_CALLS = [
  ['Orders.Core.Checkout.Buy', 'orders.PlaceOrder(price, 1)'], ['Orders.Core.OrderService.Dispatch', 'handler.Run()'], ['Orders.Core.OrderService.PlaceOrder', 'PriceCalculator.Calculate(price, quantity)'],
  ['Orders.Core.OrderService.PlaceOrder', 'new AuditClient()'], ['Orders.Core.OrderService.PlaceOrder', 'new AuditClient().Send(total)'], ['Orders.Pricing.PriceCalculator.Calculate', 'Math.Round(amount * quantity, 2)'], ['Orders.Pricing.Rounding.Record', 'Ledger.Post(amount)'],
]

describe('FR310 FR311 FR312 FR316 FR319 without the .NET SDK the syntax tier reads every C# file (fixtures/cs-orders)', () => {
  const repo = fixtureRepo('cs-orders')
  let d: string
  let toolchain: Record<string, string>
  const setup = () => {
    if (!d) {
      d = index(repo, NO_CS).d
      toolchain = (withSnapshot(d, (db) => JSON.parse((db.prepare("select value from meta where key = 'adapters'").get() as { value: string }).value)) as Array<{ id: string; toolchain: Record<string, string> }>).find((a) => a.id === 'syntax')!.toolchain
    }
    return d
  }

  it('FR311 scenario 1: every .cs file is indexed at the syntax tier, and says why', () => {
    const cs = files(setup()).filter((f) => f.path.endsWith('.cs'))
    expect(cs).toHaveLength(6)
    expect(cs.map((f) => [f.disposition, f.tier, f.detail])).toEqual(Array(6).fill(['indexed', 'syntax', 'adapter_unavailable:csharp']))
    // The project files are configuration only the precise adapter reads.
    expect(files(d).filter((f) => f.path.endsWith('.csproj')).map((f) => [f.disposition, f.detail])).toEqual([['unsupported', 'adapter_unavailable:csharp'], ['unsupported', 'adapter_unavailable:csharp']])
  }, 240000)

  it('FR316 scenario 1: its classes, interfaces and methods have the keys of expected.json, in namespace form', () => {
    const found = symbols(setup()).filter((s) => s.file.endsWith('.cs'))
    expect(found.map((s) => [s.kind, s.qn, s.a, s.b].join('|')).sort()).toEqual(CS_SYNTAX_SYMBOLS)
    expect(found.every((s) => s.extractor === 'syntax')).toBe(true)
    expect(found.find((s) => s.qn === 'Orders.Core.OrderService.PlaceOrder')!.key).toBe('src/Orders.Core/OrderService.cs#Orders.Core.OrderService.PlaceOrder#method')
  }, 240000)

  it('FR311 scenario 1: its calls are unresolved, each with the name it calls and no target', () => {
    const found = calls(setup())
    expect(found.map((c) => [c.from, c.site])).toEqual(CS_SYNTAX_CALLS)
    expect([...new Set(found.map((c) => c.callee))].sort()).toEqual(['AuditClient', 'Calculate', 'PlaceOrder', 'Post', 'Round', 'Run'])
    expect(found.every((c) => c.resolution === 'unresolved' && c.reason === 'outside_capability' && c.origin === 'syntax')).toBe(true)
  }, 240000)

  it('FR312 scenario 1: the census row for C# reads tier syntax, reason adapter_unavailable:csharp, with the SDK remedy', () => {
    const row = censusRow(setup(), 'C#')
    expect([row.tier, row.reason]).toEqual(['syntax', 'adapter_unavailable:csharp'])
    expect(row.remedy).toMatch(/\.NET 10 SDK/)
    expect(row.remedy).toMatch(/dotnet build adapters\/csharp -c Release/)
  }, 240000)

  it('FR319 framework rules, and resolved calls, are unsupported on a fallback file', () => {
    const f = files(setup()).find((x) => x.path === 'src/Orders.Core/OrderService.cs')!
    expect(f.framework).toBe('unsupported')
    expect(withSnapshot(d, (db) => JSON.parse((db.prepare("select capabilities from file where path = 'src/Orders.Core/OrderService.cs'").get() as { capabilities: string }).capabilities).resolved_calls)).toBe('unsupported')
  }, 240000)

  it('FR310 the TypeScript, TSX and C# grammars are pinned like the others: package version and WebAssembly hash join the adapter identity', () => {
    setup()
    expect(toolchain['grammar:typescript']).toMatch(/^tree-sitter-typescript@0\.23\.2 [0-9a-f]{16}$/)
    expect(toolchain['grammar:tsx']).toMatch(/^tree-sitter-typescript@0\.23\.2 [0-9a-f]{16}$/)
    expect(toolchain['grammar:csharp']).toMatch(/^tree-sitter-c-sharp@0\.23\.1 [0-9a-f]{16}$/)
  }, 240000)
})

describe('FR313 FR318 a file its precise adapter answers failed for is read by the syntax tier (fixtures/ts-module)', () => {
  const setup = () => {
    const repo = write(tsModule(), { 'src/other.ts': 'export const other = 1\n' })
    return { repo, ...index(repo, { PROOFMESH_TS_ADAPTER: fake('ts-precise.mjs') }) }
  }
  const EXPECTED = expectedFor('ts-module') as { symbols: Array<{ kind: string; qualified_name: string; lines: [number, number] }> }

  it('FR313 scenario 3: src/app.ts gets syntax-tier symbols and unresolved calls, tier syntax, and the adapter failure in its detail; the snapshot publishes', () => {
    const { d, result } = setup()
    expect(result.status).toBe('published')
    expect(files(d).find((f) => f.path === 'src/app.ts')).toMatchObject({ disposition: 'indexed', tier: 'syntax', detail: 'adapter_failed:typescript:compile_error' })
    expect(symbols(d, "f.path = 'src/app.ts'").map((s) => [s.kind, s.qn, s.a, s.b, s.extractor].join('|'))).toEqual(EXPECTED.symbols.map((s) => [s.kind, s.qualified_name, ...s.lines, 'syntax'].join('|')))
    expect(calls(d).map((c) => [c.from, c.callee, c.resolution, c.origin])).toEqual([['src/app', 'greet', 'unresolved', 'syntax']])
    expect(result.fallbacks).toEqual([{ adapter: 'typescript', files: 1, reason: 'compile_error' }])
  }, 240000)

  it('FR313 scenario 3: every other file keeps its precise facts', () => {
    const { d } = setup()
    expect(files(d).find((f) => f.path === 'src/other.ts')).toMatchObject({ disposition: 'indexed', tier: 'precise:typescript', detail: null })
    expect(symbols(d, "f.path = 'src/other.ts'").map((s) => s.extractor)).toEqual(['typescript'])
  }, 240000)

  it('FR318 with a working adapter no file reaches the syntax tier, and the job reports no fallback', () => {
    const { d, result } = index(tsModule())
    expect(files(d).filter((f) => f.path.endsWith('.ts')).map((f) => f.tier)).toEqual(['precise:typescript'])
    expect(result.fallbacks).toBeUndefined()
  }, 240000)
})

describe('FR314 an adapter that dies hands its files to the syntax tier instead of failing the index', () => {
  it('FR314 scenario 5: after the restart it is allowed dies again, the files it did not analyse fall back, and the job names the adapter and the crash', () => {
    const repo = write(fs.realpathSync(tmpDir('pm-floor-')), { 'tsconfig.json': '{}\n', 'a.ts': 'export const a = 1\n', 'die.ts': 'export const die = 2\n', 'z.ts': 'export function z() { return 3 }\n' })
    fs.writeFileSync(`${repo}.die`, '')
    const { d, stdout, result, stored } = index(repo, { PROOFMESH_TS_ADAPTER: fake('ts-precise.mjs'), PROOFMESH_INDEX_BATCH: '1' })
    expect(files(d).filter((f) => f.path.endsWith('.ts')).map((f) => [f.path, f.tier, f.detail])).toEqual([['a.ts', 'precise:typescript', null], ['die.ts', 'syntax', 'adapter_failed:typescript'], ['z.ts', 'syntax', 'adapter_failed:typescript']])
    expect(symbols(d, "f.path = 'z.ts'").map((s) => s.qn)).toEqual(['z', 'z:z'])
    expect(result.fallbacks).toHaveLength(1)
    expect(result.fallbacks![0]).toMatchObject({ adapter: 'typescript', files: 2 })
    expect(result.fallbacks![0]!.reason).toContain('adapter typescript exited with code 1 while analysing die.ts')
    expect(stdout).toContain('adapter typescript could not analyse 2 files, so the syntax tier read them')
    // What the adapter wrote to stderr is in no stored record: the job's, the snapshot's, or the snapshot's own meta.
    const meta = withSnapshot(d, (db) => JSON.stringify(db.prepare('select * from meta').all()))
    expect(meta).toContain('adapter typescript exited with code 1')
    for (const text of [stored, meta]) expect(text).not.toContain('LEDGER_SECRET_TOKEN')
    expect(censusRow(d, 'TypeScript')).toMatchObject({ tier: 'syntax', reason: 'adapter_failed:typescript', tiers: [{ tier: 'syntax', files: 2 }, { tier: 'precise:typescript', files: 1 }] })
    expect(censusRow(d, 'TypeScript').remedy).toMatch(/typescript adapter failed on these files/)
  }, 240000)
})

describe('FR310 FR317 with the TypeScript adapter disabled every TypeScript and JavaScript file has syntax-tier symbols, and the census says so', () => {
  it('FR317 scenario SC-2: .ts, .mts, .tsx, .js and .jsx files are read by the TypeScript and TSX grammars', () => {
    const repo = write(fs.realpathSync(tmpDir('pm-floor-')), {
      'a.ts': 'export class Box<T> extends Base implements Item {\n  get(): T { return helper() }\n}\nexport interface Item { id: number }\nimport { helper } from "./b"\n',
      'b.mts': 'export function helper(): number { return 1 }\n',
      'c.tsx': 'export const View = (props: { n: number }) => <div>{format(props.n)}</div>\n',
      'd.js': 'function legacy() { return 1 }\nmodule.exports = legacy\n',
      'e.jsx': 'export default function Page() { return <main /> }\n',
    })
    const { d, result } = index(repo, { PROOFMESH_TS_ADAPTER: fake('versioned-2.0.mjs') })
    expect(files(d).map((f) => [f.path, f.disposition, f.tier])).toEqual(['a.ts', 'b.mts', 'c.tsx', 'd.js', 'e.jsx'].map((p) => [p, 'indexed', 'syntax']))
    expect(symbols(d).filter((s) => s.kind !== 'module').map((s) => `${s.kind} ${s.qn}`)).toEqual(['class a:Box', 'method a:Box.get', 'interface a:Item', 'function b:helper', 'function c:View', 'function d:legacy', 'function e:Page'])
    expect(withSnapshot(d, (db) => db.prepare("select count(*) as n from assertion where type = 'imports'").get())).toEqual({ n: 1 })
    expect(withSnapshot(d, (db) => (db.prepare("select type from assertion where type in ('inherits', 'implements') order by type").all() as Array<{ type: string }>).map((r) => r.type))).toEqual(['implements', 'inherits'])
    expect(censusRow(d, 'TypeScript')).toMatchObject({ tier: 'syntax', reason: 'adapter_failed:typescript' })
    expect(censusRow(d, 'JavaScript')).toMatchObject({ tier: 'syntax', reason: 'adapter_failed:typescript' })
    expect(result.fallbacks).toEqual([{ adapter: 'typescript', files: 5, reason: expect.stringContaining('the adapter speaks protocol 2.0 and this core speaks 1.x') }])
  }, 240000)
})

describe('FR315 a tier change is a change of the analysing adapter, so an incremental index equals a clean one', () => {
  const repo = fixtureRepo('cs-orders')
  // The syntax adapter under the name csharp: precise by label, with exactly the keys of the syntax tier.
  const PRECISE = { PROOFMESH_CS_ADAPTER: fake('relabel-syntax.mjs') }
  const note = '---\nid: placing\ntitle: "placing title"\nkind: invariant\nnodes:\n  - class:Orders.Core.OrderService\n---\n\nBody of placing.\n'
  const dump = (d: string, id: string) => cli(['--data-dir', d, 'debug', 'dump', '--normalized', id]).stdout
  const snapshotOf = (stdout: string) => /snapshot (snap_\w+) (?:published|unchanged)/.exec(stdout)![1]!

  it('FR315 scenario 4: when the C# adapter becomes available the files move to the precise tier, their keys are unchanged, and a note on them is tier_changed', () => {
    const notes = write(tmpDir('pm-floor-notes-'), { 'placing.md': note })
    const first = index(repo, NO_CS)
    for (const args of [['notes', 'add', notes], ['notes', 'sync'], ['notes', 'accept', 'placing']]) expect(cli(['--data-dir', first.d, ...args]).status).toBe(0)
    const staleness = () => (tool(first.d, 'get_memory', { query: 'title' }).data as { notes: Array<{ id: string; staleness: string }> }).notes.find((n) => n.id === 'placing')!.staleness
    expect(staleness()).toBe('current')
    const keys = (d: string) => symbols(d, "s.kind in ('class', 'interface', 'method')").map((s) => s.key)
    const before = keys(first.d)
    expect(before).toHaveLength(13)

    index(repo, PRECISE, first.d)
    expect(files(first.d).filter((f) => f.path.endsWith('.cs')).map((f) => [f.tier, f.detail])).toEqual(Array(6).fill(['precise:csharp', null]))
    expect(keys(first.d)).toEqual(before)
    expect(staleness()).toBe('tier_changed')
  }, 240000)

  it('FR315 an index that moved from the syntax tier to the precise one is the index a clean data directory makes', () => {
    const incremental = index(repo, NO_CS)
    const moved = index(repo, PRECISE, incremental.d)
    const clean = index(repo, PRECISE)
    expect(dump(incremental.d, snapshotOf(moved.stdout))).toBe(dump(clean.d, snapshotOf(clean.stdout)))
    expect(snapshotOf(moved.stdout)).not.toBe(snapshotOf(incremental.stdout))
    // And back: the C# adapter going away again returns the files to the syntax tier, as a clean index at that state has them.
    const back = index(repo, NO_CS, incremental.d)
    expect(snapshotOf(back.stdout)).toBe(snapshotOf(incremental.stdout))
    expect(dump(incremental.d, snapshotOf(back.stdout))).toBe(dump(index(repo, NO_CS).d, snapshotOf(back.stdout)))
  }, 240000)
})

describe('FR311 FR313 FR314 FR315 FR316 FR317 the fallback is recorded, replaced when the adapter recovers, and names things as the precise tier does', () => {
  const ts = { PROOFMESH_TS_ADAPTER: fake('ts-precise.mjs') }
  const fresh2 = (entries: Record<string, string>) => write(fs.realpathSync(tmpDir('pm-floor-')), entries)
  const meta = (d: string) => withSnapshot(d, (db) => JSON.parse((db.prepare("select value from meta where key = 'fallbacks'").get() as { value: string } | undefined)?.value ?? 'null') as { handoffs: Array<{ adapter: string; files: number; kind: string }> } | null)

  it('FR311 FR314 an unavailable adapter is a fallback in the job result, the CLI line and the snapshot meta, as a dying one is', () => {
    const { d, stdout, result } = index(fixtureRepo('cs-orders'), NO_CS)
    expect(result.fallbacks).toEqual([{ adapter: 'csharp', files: 6, reason: 'adapter_unavailable:csharp' }])
    expect(stdout).toContain('adapter csharp could not analyse 6 files, so the syntax tier read them: adapter_unavailable:csharp')
    expect(meta(d)!.handoffs).toEqual([{ adapter: 'csharp', files: 6, reason: 'adapter_unavailable:csharp', kind: 'unavailable' }])
  }, 240000)

  it('FR314 a TypeScript adapter override that names no file falls back instead of failing the index', () => {
    const repo = fresh2({ 'a.ts': 'export const a = 1\n' })
    const { d, result } = index(repo, { PROOFMESH_TS_ADAPTER: '/nonexistent/adapter.js' })
    expect(files(d).find((f) => f.path === 'a.ts')).toMatchObject({ tier: 'syntax' })
    expect(result.fallbacks).toHaveLength(1)
  }, 240000)

  it('FR314 an adapter that cannot answer workspace gives all its files to the syntax tier, never precise file facts without workspace facts', () => {
    const repo = fresh2({ 'a.ts': 'export const a = 1\n', 'b.ts': 'export const b = 2\n' })
    fs.writeFileSync(`${repo}.noworkspace`, '')
    const { d, result } = index(repo, ts)
    expect(files(d).filter((f) => f.path.endsWith('.ts')).map((f) => f.tier)).toEqual(['syntax', 'syntax'])
    expect(result.fallbacks).toEqual([{ adapter: 'typescript', files: 2, reason: expect.stringContaining('no project model') }])
  }, 240000)

  it('FR315 indexing again after a transient crash asks the adapter again and replaces the degraded snapshot; a healthy one is then unchanged', () => {
    const repo = fresh2({ 'tsconfig.json': '{}\n', 'a.ts': 'export const a = 1\n', 'die.ts': 'export const die = 2\n' })
    fs.writeFileSync(`${repo}.die`, '')
    const first = index(repo, ts)
    expect(files(first.d).find((f) => f.path === 'die.ts')).toMatchObject({ tier: 'syntax' })
    expect(meta(first.d)!.handoffs[0]).toMatchObject({ adapter: 'typescript', kind: 'failed' })
    fs.rmSync(`${repo}.die`)
    const second = index(repo, ts, first.d)
    expect(second.stdout).toContain('published')
    expect(files(first.d).find((f) => f.path === 'die.ts')).toMatchObject({ tier: 'precise:typescript' })
    expect(meta(first.d)).toBeNull()
    expect(index(repo, ts, first.d).stdout).toContain('unchanged')
  }, 240000)

  it('FR313 a file a precise adapter failed on is not cached as failed: the adapter is asked about it again when another file changes', () => {
    const repo = write(tsModule(), { 'src/other.ts': 'export const other = 1\n' })
    const first = index(repo, ts)
    fs.appendFileSync(path.join(repo, 'src/other.ts'), '// edit\n')
    index(repo, ts, first.d)
    expect(fs.readFileSync(`${repo}.calls`, 'utf8').split('\n').filter((p) => p === 'src/app.ts')).toHaveLength(2)
  }, 240000)

  it('FR310 FR316 FR317 TypeScript namespaces are scopes, an overload set is one method, and .TS is a TypeScript file', () => {
    const repo = fresh2({
      'a.ts': 'namespace N { export function g() {} }\ninterface I { m(a: string): void; m(a: number): void }\n',
      'B.TS': 'export const cast = <number>(<unknown>1)\nexport function f() {}\n',
    })
    const { d } = index(repo, { PROOFMESH_TS_ADAPTER: fake('versioned-2.0.mjs') })
    expect(symbols(d).filter((s) => s.kind !== 'module').map((s) => `${s.kind} ${s.qn}`)).toEqual(['variable B:cast', 'function B:f', 'function a:N.g', 'interface a:I', 'method a:I.m'])
  }, 240000)

  it('FR316 a C# namespace is read from the tree, whatever comments sit in it, and `new A.B<T>()` is a call', () => {
    const repo = fresh2({ 'K.cs': 'namespace /* c */ Outer . Inner\n{\n    class K { void M() { new N.Box<int>(); } }\n}\n' })
    const { d } = index(repo, NO_CS)
    expect(symbols(d).filter((s) => s.kind !== 'module').map((s) => `${s.kind} ${s.qn}`)).toEqual(['class Outer.Inner.K', 'method Outer.Inner.K.M'])
    expect(calls(d).map((c) => [c.callee, c.site])).toEqual([['Box', 'new N.Box<int>()']])
  }, 240000)
})
