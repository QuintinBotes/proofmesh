import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { beforeAll, describe, expect, it } from 'vitest'
import { sha256File } from '../src/core/hash.js'
import { encode, type Doc, type Occ } from './helpers-scip.js'
import { cli, evidenceSlice, fixtureRepo, ROOT, tmpDir, tool, withSnapshot } from './helpers.js'

const GO = 'scip-go gomod example.com/shop v1 ', STD = 'scip-go gomod github.com/golang/go/src go1.22 ', JAVA = 'scip-java maven com.shop 1.0 ', JDK = 'scip-java maven jdk 11 '
const S = {
  pkgPricing: `${GO}\`example.com/shop/pricing\`/`, pkgCart: `${GO}\`example.com/shop/cart\`/`,
  total: `${GO}\`example.com/shop/pricing\`/Total().`, cart: `${GO}\`example.com/shop/cart\`/Cart#`, prices: `${GO}\`example.com/shop/cart\`/Cart#Prices.`, checkout: `${GO}\`example.com/shop/cart\`/Cart#Checkout().`,
  handle: `${GO}\`example.com/shop/api\`/Handle().`, apply: `${GO}\`example.com/shop/api\`/apply().`,
  fmt: `${STD}fmt/`, sprint: `${STD}fmt/Sprint().`,
  shape: `${JAVA}com/shop/Shape#`, area: `${JAVA}com/shop/Shape#area().`, circle: `${JAVA}com/shop/Circle#`, circleArea: `${JAVA}com/shop/Circle#area().`, radius: `${JAVA}com/shop/Circle#radius.`,
  report: `${JAVA}com/shop/Report#`, describe: `${JAVA}com/shop/Report#describe().`, valueOf: `${JDK}java/lang/String#valueOf().`, string: `${JDK}java/lang/String#`,
}

/** Positions are found in the fixture's own text, so the hand-written index cannot drift from the files it describes. */
const lines = (repo: string, file: string) => fs.readFileSync(path.join(repo, file), 'utf8').split('\n')
const place = (repo: string) => ({
  /** [line, start, end]: `needle` (default the anchor) on the first line holding `anchor`. */
  at: (file: string, anchor: string, needle = anchor): number[] => {
    const ls = lines(repo, file), line = ls.findIndex((l) => l.includes(anchor))
    if (line < 0) throw new Error(`${file} has no line with ${anchor}`)
    const col = ls[line]!.indexOf(needle, ls[line]!.indexOf(anchor))
    return [line, col, col + needle.length]
  },
  /** The declaration from the line holding `anchor` to the first later line equal to `closing`. */
  block: (file: string, anchor: string, closing = '}'): number[] => {
    const ls = lines(repo, file), from = ls.findIndex((l) => l.includes(anchor)), to = ls.findIndex((l, i) => i >= from && l === closing)
    return [from, 0, to, closing.length]
  },
  /** One line, as the enclosing range of a one-line declaration. */
  line: (file: string, anchor: string): number[] => { const ls = lines(repo, file), l = ls.findIndex((x) => x.includes(anchor)); return [l, 0, l, ls[l]!.length] },
})

/** The hand-written index of fixtures/scip-calls: what scip-go and scip-java record for those files. */
function fixtureIndex(repo: string): Doc[] {
  const { at, block, line } = place(repo)
  const def = (symbol: string, file: string, anchor: string, name: string, enclosing: number[]): Occ => ({ symbol, range: at(file, anchor, name), enclosing, def: true })
  const C = 'cart/cart.go', P = 'pricing/pricing.go', H = 'api/handler.go', SH = 'java/Shape.java', CI = 'java/Circle.java', R = 'java/Report.java'
  return [
    { path: C, language: 'go', typed: true, occurrences: [
      { symbol: S.fmt, range: at(C, '"fmt"', 'fmt') }, { symbol: S.pkgPricing, range: at(C, '"example.com/shop/pricing"', 'example.com/shop/pricing') },
      def(S.cart, C, 'type Cart struct', 'Cart', block(C, 'type Cart struct')), def(S.prices, C, 'Prices []int', 'Prices', line(C, 'Prices []int')),
      def(S.checkout, C, 'func (c Cart) Checkout', 'Checkout', block(C, 'func (c Cart) Checkout')),
      { symbol: S.sprint, range: at(C, 'fmt.Sprint', 'Sprint') }, { symbol: S.total, range: at(C, 'pricing.Total', 'Total') }, { symbol: S.prices, range: at(C, 'c.Prices', 'Prices') },
    ], symbols: [{ symbol: S.cart, kind: 49 }, { symbol: S.prices, kind: 15 }, { symbol: S.checkout, kind: 26, signature: 'func (c Cart) Checkout() string' }] },
    { path: P, language: 'go', typed: true, occurrences: [def(S.total, P, 'func Total', 'Total', block(P, 'func Total')), { symbol: 'local 0', range: at(P, 'sum := 0', 'sum'), def: true }], symbols: [{ symbol: S.total, kind: 17, signature: 'func Total(prices []int) int' }] },
    { path: H, language: 'go', typed: true, occurrences: [
      { symbol: S.pkgCart, range: at(H, '"example.com/shop/cart"', 'example.com/shop/cart') }, { symbol: S.pkgPricing, range: at(H, '"example.com/shop/pricing"', 'example.com/shop/pricing') },
      def(S.handle, H, 'func Handle', 'Handle', block(H, 'func Handle')),
      { symbol: S.apply, range: at(H, 'apply(pricing.Total)', 'apply') }, { symbol: S.total, range: at(H, 'apply(pricing.Total)', 'Total') },
      { symbol: S.cart, range: at(H, 'cart.Cart{}', 'Cart') }, { symbol: S.checkout, range: at(H, 'cart.Cart{}.Checkout()', 'Checkout') },
      def(S.apply, H, 'func apply', 'apply', block(H, 'func apply')), { symbol: 'local 1', range: at(H, 'func apply', 'f'), def: true },
      { symbol: 'local 2', range: at(H, 'run := f', 'run'), def: true }, { symbol: 'local 1', range: at(H, 'run := f', 'f') }, { symbol: 'local 2', range: at(H, 'run(nil)', 'run') },
    ], symbols: [{ symbol: S.handle, kind: 17 }, { symbol: S.apply, kind: 17 }] },
    { path: SH, language: 'java', typed: true, occurrences: [def(S.shape, SH, 'interface Shape', 'Shape', block(SH, 'interface Shape')), def(S.area, SH, 'double area', 'area', line(SH, 'double area'))], symbols: [{ symbol: S.shape, kind: 21 }, { symbol: S.area, kind: 26 }] },
    { path: CI, language: 'java', typed: true, occurrences: [
      def(S.circle, CI, 'class Circle', 'Circle', block(CI, 'class Circle')), { symbol: S.shape, range: at(CI, 'implements Shape', 'Shape') },
      def(S.radius, CI, 'private final double radius', 'radius', line(CI, 'private final double radius')), def(S.circleArea, CI, 'public double area', 'area', block(CI, 'public double area', '    }')),
    ], symbols: [{ symbol: S.circle, kind: 7, implements: [S.shape] }, { symbol: S.radius, kind: 15 }, { symbol: S.circleArea, kind: 26, implements: [S.area] }] },
    { path: R, language: 'java', typed: true, occurrences: [
      def(S.report, R, 'class Report', 'Report', block(R, 'class Report')), def(S.describe, R, 'describe(Shape s)', 'describe', block(R, 'describe(Shape s)', '    }')),
      { symbol: S.shape, range: at(R, 'describe(Shape s)', 'Shape') }, { symbol: S.string, range: at(R, 'String.valueOf', 'String') }, { symbol: S.valueOf, range: at(R, 'String.valueOf', 'valueOf') }, { symbol: S.area, range: at(R, 's.area()', 'area') },
    ], symbols: [{ symbol: S.report, kind: 7 }, { symbol: S.describe, kind: 26 }] },
  ]
}

/** A copy of a fixture with the index named for it, as a person would after producing it, and indexed. */
function named(fixture: string, docs: (repo: string) => Doc[], edit: (repo: string) => void = () => {}) {
  const repo = fs.realpathSync(tmpDir('pm-scipcalls-'))
  fs.cpSync(fixtureRepo(fixture), repo, { recursive: true })
  edit(repo)
  const file = path.join(tmpDir('pm-scipcalls-index-'), 'shop.scip')
  fs.writeFileSync(file, encode(repo, 'hand-written', docs(repo)))
  const d = tmpDir()
  for (const args of [['init'], ['repo', 'add', repo], ['scip', 'add', repo, file], ['index', repo]]) { const r = cli(['--data-dir', d, ...args]); expect(r.status, r.stderr).toBe(0) }
  return { repo, file, d }
}

type Row = Record<string, string | number | null>
const q = <T = Row>(d: string, sql: string, ...args: unknown[]) => withSnapshot(d, (db) => db.prepare(sql).all(...args) as T[])
/** The symbol-to-symbol assertions of a type the SCIP adapter wrote: the source, target (a symbol or an external), resolution, origin and the line of its first evidence. */
const edges = (d: string, type: string) => q(d, `select a.resolution, a.origin, a.reason, a.detail, s.qualified_name as src, t.qualified_name as dst, x.module, x.name, min(ev.start_line) as line
  from assertion a join symbol s on s.id = a.source_id left join symbol t on t.id = a.target_id left join external_symbol x on x.id = a.target_id
  join assertion_evidence ae on ae.assertion_id = a.id join evidence ev on ev.id = ae.evidence_id where a.adapter = 'scip' and a.type = ? group by a.id order by s.qualified_name, line, dst`, type)
  .map((r) => [r.src, r.resolution, r.dst ?? (r.module ? `${r.module}:${r.name}` : null), r.origin, r.line, r.reason, r.detail ? JSON.parse(String(r.detail)) : null])
const imports = (d: string, file: string) => q(d, `select a.resolution, a.origin, a.reason, a.detail, tf.path as dst, x.module, x.name, min(ev.start_line) as line
  from assertion a join file f on f.id = a.source_id left join file tf on tf.id = a.target_id and a.target_kind = 'file' left join external_symbol x on x.id = a.target_id and a.target_kind = 'external'
  join assertion_evidence ae on ae.assertion_id = a.id join evidence ev on ev.id = ae.evidence_id where a.adapter = 'scip' and a.type = 'imports' and f.path = ? group by a.id order by line`, file)
  .map((r) => [r.line, r.resolution, r.dst ?? (r.module ? `${r.module}:${r.name}` : null), r.origin, r.reason, r.detail ? JSON.parse(String(r.detail)) : null])
const capability = (d: string, file: string, key: string) => (q(d, `select json_extract(capabilities, '$.${key}') as v from file where path = ?`, file)[0] as { v: string }).v
const idOf = (d: string, qualified: string) => (q(d, 'select id from symbol where qualified_name = ?', qualified)[0] as { id: string }).id

describe('FR161 FR162 FR163 FR169 calls, inheritance and imports from a SCIP index (fixtures/scip-calls)', () => {
  let d: string, repo: string
  beforeAll(() => { ({ d, repo } = named('scip-calls', fixtureIndex)) }, 240000)

  it('FR161 scenario 1: the inbound calls of pricing.Total are one row, from Checkout at its call line, resolved by the index', () => {
    const rows = (tool(d, 'get_relationships', { subject_id: idOf(d, 'pricing/pricing:Total'), direction: 'in', types: ['calls'], envelope: 'full' }).data as { relationships: Array<Record<string, unknown>> }).relationships
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: 'calls', resolution: 'resolved', origin: 'semantic_resolver' })
    expect(edges(d, 'calls').filter((r) => r[2] === 'pricing/pricing:Total')).toEqual([['cart/cart:Cart.Checkout', 'resolved', 'pricing/pricing:Total', 'semantic_resolver', 14, null, null]])
  })

  it('FR161 scenario 2: the function passed as a value is a references row, not a calls row', () => {
    const uses = (type: string) => edges(d, type).filter((r) => r[2] === 'pricing/pricing:Total' && String(r[0]).startsWith('api/handler'))
    expect(uses('references')).toEqual([['api/handler:Handle', 'resolved', 'pricing/pricing:Total', 'semantic_resolver', 9, null, null]])
    expect(uses('calls')).toEqual([])
  })

  it('FR161 scenario 6: a call to a symbol the index defines elsewhere is resolved_external with its package; a local variable holding a function is no call', () => {
    expect(edges(d, 'calls')).toEqual([
      ['api/handler:Handle', 'resolved', 'api/handler:apply', 'semantic_resolver', 9, null, null],
      ['api/handler:Handle', 'resolved', 'cart/cart:Cart.Checkout', 'semantic_resolver', 10, null, null],
      ['cart/cart:Cart.Checkout', 'resolved_external', 'github.com/golang/go/src:fmt.Sprint', 'semantic_resolver', 14, null, null],
      ['cart/cart:Cart.Checkout', 'resolved', 'pricing/pricing:Total', 'semantic_resolver', 14, null, null],
      ['com.shop.Report.describe', 'resolved_external', 'jdk:java.lang.String.valueOf', 'semantic_resolver', 5, null, null],
      ['com.shop.Report.describe', 'resolved', 'com.shop.Shape.area', 'semantic_resolver', 5, null, null],
    ])
    // `run(nil)` calls a local variable: the syntax tier saw the call and the index names only a local, so it is neither a call nor a row.
    expect(edges(d, 'calls').filter((r) => r[0] === 'api/handler:apply')).toEqual([])
    expect(edges(d, 'references').filter((r) => r[0] === 'api/handler:apply')).toEqual([])
    // A call is recorded once: its callee occurrence is no references row as well.
    expect(edges(d, 'references').filter((r) => r[4] === 14 && String(r[2]).includes('Total'))).toEqual([])
  })

  it('FR162 scenario 3: Circle implements Shape and Circle.area overrides Shape.area, from the index\'s relationships', () => {
    expect(edges(d, 'implements')).toEqual([['com.shop.Circle', 'resolved', 'com.shop.Shape', 'semantic_resolver', 3, null, null]])
    expect(edges(d, 'overrides')).toEqual([['com.shop.Circle.area', 'resolved', 'com.shop.Shape.area', 'semantic_resolver', 11, null, null]])
    expect(edges(d, 'inherits')).toEqual([])
  })

  it('FR169 scenario 4: analyze_impact on pricing.Total reaches Checkout at depth 1 and the handler at depth 2; Report.describe reaches Circle.area through Shape.area', () => {
    const impact = (subject: string) => (tool(d, 'analyze_impact', { subject_ids: [idOf(d, subject)], envelope: 'full' }).data as { dependents: Array<{ qualified_name: string; depth: number }> }).dependents
    expect(impact('pricing/pricing:Total').map((x) => [x.qualified_name, x.depth])).toEqual([['cart/cart:Cart.Checkout', 1], ['api/handler:Handle', 2]])
    expect(impact('com.shop.Circle.area').map((x) => [x.qualified_name, x.depth])).toContainEqual(['com.shop.Report.describe', 1])
  })

  it('FR163 scenario 5: an import is resolved to the package\'s file, or to its external module; occurrences inside it are no references', () => {
    expect(imports(d, 'cart/cart.go')).toEqual([
      [4, 'resolved_external', 'go:std:fmt', 'semantic_resolver', null, null],
      [6, 'resolved', 'pricing/pricing.go', 'semantic_resolver', null, null],
    ])
    expect(imports(d, 'api/handler.go')).toEqual([[4, 'resolved', 'cart/cart.go', 'semantic_resolver', null, null], [5, 'resolved', 'pricing/pricing.go', 'semantic_resolver', null, null]])
    expect(edges(d, 'references').filter((r) => /^(cart|api)\//.test(String(r[0])) && (r[4] === 4 || r[4] === 5 || r[4] === 6))).toEqual([])
    expect(capability(d, 'cart/cart.go', 'imports')).toBe('complete')
  })

  it('FR161 the file reports its resolved calls complete, and every call site it records has evidence at the callee name', () => {
    expect(capability(d, 'cart/cart.go', 'resolved_calls')).toBe('complete')
    expect(capability(d, 'api/handler.go', 'resolved_calls')).toBe('complete')
    const slices = q(d, `select ae.evidence_id as ev from assertion a join assertion_evidence ae on ae.assertion_id = a.id where a.adapter = 'scip' and a.type = 'calls'`)
      .map((r) => withSnapshot(d, (db) => evidenceSlice(d, db, String(r.ev)))).sort()
    expect(slices).toEqual(['Checkout', 'Sprint', 'Total', 'apply', 'area', 'valueOf'].sort())
  })

  it('FR165 naming the index changes no stable key and no body hash', () => {
    const keys = (dir: string) => q(dir, `select s.kind, s.qualified_name, s.stable_key, s.body_hash from symbol s order by s.qualified_name collate binary`)
    const plain = fs.realpathSync(tmpDir('pm-scipcalls-plain-'))
    fs.cpSync(fixtureRepo('scip-calls'), plain, { recursive: true })
    const p = tmpDir()
    for (const args of [['init'], ['repo', 'add', plain], ['index', plain]]) expect(cli(['--data-dir', p, ...args]).status).toBe(0)
    const without = keys(p), withIndex = keys(d)
    // Everything the syntax tier declares keeps its key and hash; the index adds only the fields it defines that the syntax tier leaves out.
    expect(without.length).toBeGreaterThan(8)
    for (const row of without) expect(withIndex).toContainEqual(row)
    expect(repo).toBeTruthy()
  }, 240000)
})

describe('FR166 FR167 FR168 FR170 edge cases of the join between call sites and occurrences', () => {
  it('FR166 occurrences that line up with no call site give no call, and the file says its calls are partial, with the count', async () => {
    // A stale index: every occurrence of cart.go starts one column late, so none sits on the callee name the syntax tier found.
    const shifted = (repo: string) => fixtureIndex(repo).map((doc) => (doc.path !== 'cart/cart.go' ? doc : { ...doc, occurrences: doc.occurrences.map((o) => (o.def ? o : { ...o, range: [o.range[0]!, o.range[1]! + 1, o.range[2]! + 1] })) }))
    const { d, repo, file } = named('scip-calls', shifted)
    expect(edges(d, 'calls').filter((r) => String(r[0]).startsWith('cart/'))).toEqual([])
    expect(capability(d, 'cart/cart.go', 'resolved_calls')).toBe('partial')
    expect(capability(d, 'api/handler.go', 'resolved_calls')).toBe('complete')
    // The count is in the adapter's warning for the file.
    const r = await rpc(repo, file, [{ path: 'cart/cart.go', language: 'go' }])
    expect(r.diagnostics.map((x) => x.message)).toContain('2 of 2 call sites in cart/cart.go match no occurrence in the index, so they are not recorded as calls')
  }, 240000)

  it('FR167 two occurrences at a callee name: the reference to a function wins over a definition and over a reference to a field', () => {
    const doubled = (repo: string) => fixtureIndex(repo).map((doc) => {
      if (doc.path !== 'cart/cart.go') return doc
      const { at } = place(repo), r = at('cart/cart.go', 'pricing.Total', 'Total')
      // A definition and a reference to a field at the same name, ahead of the reference to the function.
      return { ...doc, occurrences: [{ symbol: S.prices, range: r }, { symbol: 'local 9', range: r, def: true }, ...doc.occurrences] }
    })
    const { d } = named('scip-calls', doubled)
    expect(edges(d, 'calls').filter((r) => r[2] === 'pricing/pricing:Total')).toEqual([['cart/cart:Cart.Checkout', 'resolved', 'pricing/pricing:Total', 'semantic_resolver', 14, null, null]])
    // The field reference stays a reference.
    expect(edges(d, 'references').filter((r) => r[2] === 'cart/cart:Cart.Prices' && r[4] === 14)).toHaveLength(2)
  }, 240000)

  it('FR168 a call to a type is a call to its constructor symbol where the index has one, else to the type', () => {
    const K = 'scip-kotlin maven com.shop 1.0 '
    const docs = (repo: string): Doc[] => {
      const { at, block, line } = place(repo), F = 'kt/Shapes.kt'
      return [{ path: F, language: 'kotlin', typed: true, occurrences: [
        { symbol: `${K}com/shop/Circle#`, range: at(F, 'class Circle', 'Circle'), enclosing: line(F, 'class Circle'), def: true },
        { symbol: `${K}com/shop/Circle#\`<init>\`().`, range: at(F, 'class Circle', 'Circle'), enclosing: line(F, 'class Circle'), def: true },
        { symbol: `${K}com/shop/Square#`, range: at(F, 'class Square', 'Square'), enclosing: line(F, 'class Square'), def: true },
        { symbol: `${K}com/shop/build().`, range: at(F, 'fun build', 'build'), enclosing: block(F, 'fun build'), def: true },
        { symbol: `${K}com/shop/Circle#\`<init>\`().`, range: at(F, 'Circle(2.0)', 'Circle') }, { symbol: `${K}com/shop/Square#`, range: at(F, 'Square()', 'Square') },
      ], symbols: [{ symbol: `${K}com/shop/Circle#`, kind: 7 }, { symbol: `${K}com/shop/Circle#\`<init>\`().`, kind: 9 }, { symbol: `${K}com/shop/Square#`, kind: 7 }, { symbol: `${K}com/shop/build().`, kind: 17 }] }]
    }
    const kotlin = (repo: string) => { fs.mkdirSync(path.join(repo, 'kt')); fs.writeFileSync(path.join(repo, 'kt/Shapes.kt'), 'package com.shop\n\nclass Circle(val radius: Double)\n\nclass Square\n\nfun build(): Double {\n    val a = Circle(2.0)\n    val b = Square()\n    return a.radius\n}\n') }
    const { d } = named('scip-calls', docs, kotlin)
    expect(edges(d, 'calls').map((r) => [r[0], r[1], r[2]])).toEqual([['com.shop.build', 'resolved', 'com.shop.Circle.<init>'], ['com.shop.build', 'resolved', 'com.shop.Square']])
  }, 240000)

  it('FR170 a file in a language the syntax tier lacks keeps its references, and reports its calls and imports unsupported', () => {
    const r = fs.realpathSync(tmpDir('pm-scipcalls-zzz-'))
    fs.writeFileSync(path.join(r, 'a.zzz'), 'fn foo\n  bar\nend\nfn bar\nend\n')
    const index = path.join(tmpDir('pm-scipcalls-zzz-index-'), 'z.scip')
    fs.writeFileSync(index, encode(r, 'hand-written', [{ path: 'a.zzz', language: 'zzz', typed: true, occurrences: [
      { symbol: 'scip-zzz zzz pkg 1 foo().', range: [0, 3, 6], enclosing: [0, 0, 2, 3], def: true }, { symbol: 'scip-zzz zzz pkg 1 bar().', range: [3, 3, 6], enclosing: [3, 0, 4, 3], def: true }, { symbol: 'scip-zzz zzz pkg 1 bar().', range: [1, 2, 5] }] }]))
    const dd = tmpDir()
    for (const args of [['init'], ['repo', 'add', r], ['scip', 'add', r, index], ['index', r]]) { const x = cli(['--data-dir', dd, ...args]); expect(x.status, x.stderr).toBe(0) }
    expect(capability(dd, 'a.zzz', 'resolved_calls')).toBe('unsupported')
    expect(capability(dd, 'a.zzz', 'imports')).toBe('unsupported')
    expect(edges(dd, 'references')).toEqual([['a:foo', 'resolved', 'a:bar', 'semantic_resolver', 2, null, null]])
    expect(edges(dd, 'calls')).toEqual([])
  }, 240000)

  it('FR170 when the syntax tier cannot be reached, calls and imports are unsupported with a warning, and references stay', async () => {
    const { repo, file } = named('scip-calls', fixtureIndex)
    const r = await rpc(repo, file, [{ path: 'cart/cart.go', language: 'go' }], true)
    const result = r.file_results[0] as { capabilities: Record<string, string> }
    expect(result.capabilities).toMatchObject({ resolved_calls: 'unsupported', imports: 'unsupported' })
    expect(r.relationships.filter((x) => x.type === 'calls' || x.type === 'imports')).toEqual([])
    expect(r.relationships.filter((x) => x.type === 'references').length).toBeGreaterThan(0)
    expect(r.diagnostics.map((x) => x.message)).toContain('call sites and imports in cart/cart.go are not read: syntax_tier_unavailable')
  }, 240000)
})

/** Runs the SCIP adapter as the host does, and returns its answer to one analyze. `isolated` runs a copy of it where the syntax tier cannot be found. */
async function rpc(repo: string, index: string, files: Array<{ path: string; language: string }>, isolated = false) {
  let entry = path.join(ROOT, 'packages', 'proofmesh', 'dist', 'scip-adapter.mjs')
  if (isolated) { const copy = path.join(tmpDir('pm-scip-isolated-'), 'scip-adapter.mjs'); fs.copyFileSync(entry, copy); entry = copy }
  const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, NODE_PATH: '' } })
  const waiting = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>()
  readline.createInterface({ input: child.stdout }).on('line', (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m) })
  let id = 0
  const ask = (method: string, params: unknown) => new Promise<Record<string, unknown>>((resolve, reject) => {
    waiting.set(++id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result as Record<string, unknown>)))
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  try {
    await ask('initialize', { protocol_version: '1.0', workspace: repo, repository_root: repo, analysis_mode: 'no_execution', files: files.map((f) => ({ ...f, content_hash: '0'.repeat(64) })), config: { indexes: [{ name: 'shop', path: index, sha256: sha256File(index) }] } })
    return await ask('analyze', { paths: files.map((f) => f.path) }) as { relationships: Array<{ type: string }>; file_results: unknown[]; diagnostics: Array<{ message: string }> }
  } finally { child.kill() }
}
