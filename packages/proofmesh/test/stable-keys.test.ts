import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { encode, type Doc } from './helpers-scip.js'
import { cli, fixtureRepo, tmpDir, tool, withSnapshot } from './helpers.js'

type Row = { path: string; kind: string; qualified_name: string; stable_key: string; start_line: number; body_hash: string | null; producer: string }

const ids = (d: string, repo: string, ...args: string[][]) => { for (const a of [['init'], ['repo', 'add', repo], ...args]) { const r = cli(['--data-dir', d, ...a]); expect(r.status, r.stderr).toBe(0) } }
const index = (d: string, repo: string) => { const r = cli(['--data-dir', d, 'index', repo]); expect(r.status, r.stderr).toBe(0) }
const rows = (d: string, ...paths: string[]) => withSnapshot(d, (db) => db.prepare(`select f.path, s.kind, s.qualified_name, s.stable_key, s.start_line, s.body_hash, ev.extractor as producer from symbol s join file f on f.id = s.file_id join evidence ev on ev.id = s.evidence_id
  where f.path in (${paths.map(() => '?').join(',')}) order by s.stable_key collate binary`).all(...paths) as Row[])
const keys = (r: Row[]) => r.map((x) => x.stable_key)
const symbolsOf = (r: Row[]) => r.filter((x) => x.kind !== 'module')

/** The fixture copied to a real path; extra files are written by the caller. */
function copy(name = 'stable-keys') {
  const repo = fs.realpathSync(tmpDir('pm-keys-'))
  fs.cpSync(fixtureRepo(name), repo, { recursive: true })
  return repo
}

// 0-based lines and columns of each declaration's name in the fixture, written by hand from the files.
const GO = 'scip-go gomod example.com/shop v1 `example.com/shop/go`/', JAVA = 'semanticdb maven acme 1.0 com/acme/'
const INDEX: Doc[] = [
  {
    path: 'go/cart.go', language: 'go', typed: true,
    occurrences: [
      { symbol: `${GO}Cart#`, range: [2, 5, 9], def: true },
      { symbol: `${GO}Cart#Checkout().`, range: [6, 14, 22], def: true },
      { symbol: `${GO}Cart#Add().`, range: [10, 15, 18], def: true },
      { symbol: `${GO}New().`, range: [14, 5, 8], def: true },
    ],
    symbols: [{ symbol: `${GO}Cart#`, kind: 49 }, { symbol: `${GO}Cart#Checkout().`, kind: 26 }, { symbol: `${GO}Cart#Add().`, kind: 26 }, { symbol: `${GO}New().`, kind: 17 }],
  },
  {
    path: 'java/Shop.java', language: 'java', typed: true,
    occurrences: [
      { symbol: `${JAVA}Shop#`, range: [2, 13, 17], def: true },
      { symbol: `${JAVA}Shop#add().`, range: [3, 9, 12], def: true },
      { symbol: `${JAVA}Shop#add(+1).`, range: [7, 9, 12], def: true },
    ],
    symbols: [{ symbol: `${JAVA}Shop#`, kind: 7 }, { symbol: `${JAVA}Shop#add().`, kind: 3 }, { symbol: `${JAVA}Shop#add(+1).`, kind: 3 }],
  },
]
const name = (repo: string, d: string) => {
  const file = path.join(tmpDir('pm-keys-index-'), 'shop.scip')
  fs.writeFileSync(file, encode(repo, 'hand-written', INDEX))
  const r = cli(['--data-dir', d, 'scip', 'add', repo, file])
  expect(r.status, r.stderr).toBe(0)
}

const GO_KEYS = ['go/cart.go#go/cart#module', 'go/cart.go#go/cart:Cart#type_alias', 'go/cart.go#go/cart:Cart.Add#method', 'go/cart.go#go/cart:Cart.Checkout#method', 'go/cart.go#go/cart:New#function']
const JAVA_KEYS = ['java/Shop.java#com.acme.Shop#class', 'java/Shop.java#com.acme.Shop.add(String)#method', 'java/Shop.java#com.acme.Shop.add(int)#method', 'java/Shop.java#java/Shop#module']

describe('FR146 every tier names a declaration by the qualified name of its language, and FR147 a snapshot never seals two equal keys', () => {
  it('scenario 1: the syntax tier gives Go, Java, Rust, Python and C declarations the names of the table, all keys unique', () => {
    const d = tmpDir(), repo = copy()
    ids(d, repo, ['index', repo])
    const all = rows(d, 'go/cart.go', 'java/Shop.java', 'rust/lib.rs', 'py/calc.py', 'c/util.c')
    expect(keys(all.filter((r) => r.path === 'go/cart.go'))).toEqual(GO_KEYS)
    expect(keys(all.filter((r) => r.path === 'java/Shop.java'))).toEqual(JAVA_KEYS)
    expect(symbolsOf(all.filter((r) => r.path === 'rust/lib.rs')).map((r) => r.qualified_name)).toEqual(['rust/lib:Counter', 'rust/lib:Counter.bump', 'rust/lib:Counter.default', 'rust/lib:Timer', 'rust/lib:Timer.bump'])
    expect(symbolsOf(all.filter((r) => r.path === 'py/calc.py')).map((r) => [r.qualified_name, r.kind])).toEqual([['py/calc:C', 'class'], ['py/calc:C.x', 'property'], ['py/calc:C.x(value)', 'property']])
    // The prototype and the definition of `add` are one symbol, declared at the definition.
    expect(symbolsOf(all.filter((r) => r.path === 'c/util.c')).map((r) => [r.qualified_name, r.start_line])).toEqual([['c/util:add', 3]])
    const every = withSnapshot(d, (db) => db.prepare('select count(*) as n, count(distinct stable_key) as u from symbol').get() as { n: number; u: number })
    expect(every.n).toBe(every.u)
  }, 240000)

  it('a Rust impl of one generic trait for two arguments, and a C++ definition outside its class, are named by their owner and parameters', () => {
    const d = tmpDir(), repo = fs.realpathSync(tmpDir('pm-keys-edge-'))
    fs.mkdirSync(path.join(repo, 'src'))
    fs.writeFileSync(path.join(repo, 'src/conv.rs'), 'struct X;\nstruct A;\nstruct B;\nimpl From<A> for X {\n    fn from(a: A) -> X {\n        X\n    }\n}\nimpl From<B> for X {\n    fn from(b: B) -> X {\n        X\n    }\n}\n')
    fs.writeFileSync(path.join(repo, 'src/a.cpp'), 'class A {\n  int f();\n  int g(int x);\n  int g(double x);\n};\n\nint A::f() {\n  return 1;\n}\n')
    ids(d, repo, ['index', repo])
    expect(symbolsOf(rows(d, 'src/conv.rs')).map((r) => r.qualified_name).filter((n) => n.includes('from'))).toEqual(['src/conv:X.from(A)', 'src/conv:X.from(B)'])
    expect(symbolsOf(rows(d, 'src/a.cpp')).map((r) => [r.qualified_name, r.start_line])).toEqual([['src/a:A', 1], ['src/a:A.f', 7], ['src/a:A.g(double)', 4], ['src/a:A.g(int)', 3]])
  }, 240000)

  it('Kotlin, Scala and PHP take the package or namespace the source declares', () => {
    const d = tmpDir(), repo = fs.realpathSync(tmpDir('pm-keys-ns-'))
    fs.writeFileSync(path.join(repo, 'Greeter.kt'), 'package org.example.hello\n\nclass Greeter {\n    fun greet(name: String): String {\n        return name\n    }\n}\n')
    fs.writeFileSync(path.join(repo, 'Greeter.scala'), 'package org.example.hello\n\nclass Greeter {\n  def greet(name: String): String = name\n}\n')
    fs.writeFileSync(path.join(repo, 'Greeter.php'), '<?php\nnamespace Org\\Example;\n\nclass Greeter {\n    public function greet(string $name): string {\n        return $name;\n    }\n}\n')
    ids(d, repo, ['index', repo])
    expect(withSnapshot(d, (db) => (db.prepare("select qualified_name from symbol where kind <> 'module' order by qualified_name collate binary").all() as Array<{ qualified_name: string }>).map((r) => r.qualified_name))).toEqual([
      'Org.Example', 'Org.Example.Greeter', 'Org.Example.Greeter.greet', 'org.example.hello', 'org.example.hello.Greeter', 'org.example.hello.Greeter', 'org.example.hello.Greeter.greet', 'org.example.hello.Greeter.greet',
    ])
  }, 240000)

  it('FR147 edge: two declarations still sharing a name after every suffix take ~1 and ~2 in source order, from the core', () => {
    const d = tmpDir(), repo = fs.realpathSync(tmpDir('pm-keys-dup-'))
    fs.writeFileSync(path.join(repo, 'dup.py'), 'def f():\n    return 1\n\n\ndef f():\n    return 2\n')
    ids(d, repo, ['index', repo])
    expect(rows(d, 'dup.py').filter((r) => r.kind === 'function').map((r) => [r.stable_key, r.start_line])).toEqual([['dup.py#dup:f#function~1', 1], ['dup.py#dup:f#function~2', 5]])
  }, 240000)
})

describe('FR148 the SCIP importer names a definition as the syntax tier names it', () => {
  it('scenario 2: naming the index leaves every key and body_hash of go/cart.go and java/Shop.java as they were', () => {
    const d = tmpDir(), repo = copy()
    ids(d, repo, ['index', repo])
    const before = rows(d, 'go/cart.go', 'java/Shop.java')
    expect(keys(before)).toEqual([...GO_KEYS, ...JAVA_KEYS].sort())
    name(repo, d)
    index(d, repo)
    const after = rows(d, 'go/cart.go', 'java/Shop.java')
    expect(after.map((r) => r.producer)).toEqual(Array(after.length).fill('scip'))
    expect(after.map((r) => [r.stable_key, r.body_hash])).toEqual(before.map((r) => [r.stable_key, r.body_hash]))
    expect(after.every((r) => r.body_hash === null || /^[0-9a-f]{64}$/.test(r.body_hash))).toBe(true)
  }, 240000)

  it('scenario 3: editing go/cart.go returns it to the syntax tier (scip_stale) with every key unchanged', () => {
    const d = tmpDir(), repo = copy()
    ids(d, repo)
    name(repo, d)
    index(d, repo)
    fs.writeFileSync(path.join(repo, 'go/cart.go'), fs.readFileSync(path.join(repo, 'go/cart.go'), 'utf8').replace('return Cart{}', 'return Cart{Items: nil}'))
    index(d, repo)
    const go = rows(d, 'go/cart.go')
    expect(go.map((r) => r.producer)).toEqual(Array(go.length).fill('syntax'))
    expect(withSnapshot(d, (db) => db.prepare("select disposition_detail as detail from file where path = 'go/cart.go'").get())).toEqual({ detail: 'scip_stale:shop' })
    expect(keys(go)).toEqual(GO_KEYS)
  }, 240000)
})

describe('FR149 every tool that takes a subject accepts its key', () => {
  it('scenario 4: get_symbol, get_relationships, analyze_impact, find_tests and trace_paths answer by key as by id; an unknown key is NOT_FOUND naming it', () => {
    const d = tmpDir(), repo = copy()
    ids(d, repo, ['index', repo])
    const idOf = (key: string) => withSnapshot(d, (db) => (db.prepare('select id from symbol where stable_key = ?').get(key) as { id: string }).id)
    const checkout = 'go/cart.go#go/cart:Cart.Checkout#method', add = 'go/cart.go#go/cart:Cart.Add#method'
    const data = (name: string, input: Record<string, unknown>) => tool(d, name, input).data
    expect(data('get_symbol', { key: checkout })).toEqual(data('get_symbol', { symbol_id: idOf(checkout) }))
    expect((data('get_symbol', { key: checkout }) as { symbol: { stable_key: string } }).symbol.stable_key).toBe(checkout)
    expect(data('get_relationships', { key: checkout })).toEqual(data('get_relationships', { subject_id: idOf(checkout) }))
    expect(data('analyze_impact', { key: checkout })).toEqual(data('analyze_impact', { subject_ids: [idOf(checkout)] }))
    expect(data('find_tests', { key: checkout })).toEqual(data('find_tests', { subject_ids: [idOf(checkout)] }))
    expect(data('trace_paths', { source_key: checkout, target_key: add })).toEqual(data('trace_paths', { source_id: idOf(checkout), target_id: idOf(add) }))
    for (const [t, input] of [['get_symbol', { key: 'nowhere#x#function' }], ['get_relationships', { key: 'nowhere#x#function' }], ['analyze_impact', { key: 'nowhere#x#function' }], ['find_tests', { key: 'nowhere#x#function' }], ['trace_paths', { source_key: 'nowhere#x#function', target_key: add }]] as const) {
      let error: { code?: string; message?: string } = {}
      try { tool(d, t, input) } catch (e) { error = e as typeof error }
      expect([t, error.code, error.message]).toEqual([t, 'NOT_FOUND', expect.stringContaining('nowhere#x#function')])
    }
  }, 240000)
})

describe('FR150 a note reference that matches several symbols is ambiguous, and a tier switch is not a change', () => {
  const note = (id: string, ref: string) => `---\nid: ${id}\ntitle: "${id} title"\nkind: invariant\nnodes:\n  - ${ref}\n---\n\nBody of ${id}.\n`
  const memory = (d: string) => (tool(d, 'get_memory', { query: 'title' }).data as { notes: Array<{ id: string; staleness: string; ambiguous_refs: Array<{ ref: string; keys: string[] }>; missing_refs: string[] }> }).notes
  const setup = () => {
    const d = tmpDir(), repo = copy(), notes = tmpDir('pm-keys-notes-')
    fs.writeFileSync(path.join(notes, 'overloads.md'), note('overloads', 'method:com.acme.Shop.add'))
    fs.writeFileSync(path.join(notes, 'checkout.md'), note('checkout', 'method:go/cart:Cart.Checkout'))
    ids(d, repo, ['index', repo], ['notes', 'add', notes])
    expect(cli(['--data-dir', d, 'notes', 'sync']).status).toBe(0)
    for (const id of ['overloads', 'checkout']) expect(cli(['--data-dir', d, 'notes', 'accept', id]).status).toBe(0)
    return { d, repo }
  }

  it('scenario 5: method:com.acme.Shop.add lists both overload keys under ambiguous_refs and is not current', () => {
    const { d } = setup()
    const n = memory(d).find((x) => x.id === 'overloads')!
    expect(n.ambiguous_refs).toEqual([{ ref: 'method:com.acme.Shop.add', keys: ['java/Shop.java#com.acme.Shop.add(String)#method', 'java/Shop.java#com.acme.Shop.add(int)#method'] }])
    expect(n.missing_refs).toEqual([])
    expect(n.staleness).not.toBe('current')
  }, 240000)

  it('scenario 6: a note on go/cart:Cart.Checkout accepted on the syntax tier is tier_changed, not changed, after the SCIP index is named', () => {
    const { d, repo } = setup()
    const n = () => memory(d).find((x) => x.id === 'checkout')!
    expect(n().staleness).toBe('current')
    name(repo, d)
    index(d, repo)
    expect(rows(d, 'go/cart.go').every((r) => r.producer === 'scip')).toBe(true)
    expect(n().staleness).toBe('tier_changed')
    // A content change under the accepted tier is not a tier change.
    fs.writeFileSync(path.join(repo, 'go/cart.go'), fs.readFileSync(path.join(repo, 'go/cart.go'), 'utf8').replace('return "done"', 'return "done!"'))
    index(d, repo)
    expect(n().staleness).not.toBe('tier_changed')
  }, 240000)
})
