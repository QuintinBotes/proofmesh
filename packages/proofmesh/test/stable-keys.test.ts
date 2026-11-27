import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { encode, type Doc } from './helpers-scip.js'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'
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

const GO_KEYS = ['go/cart.go#go/cart#module', 'go/cart.go#go/cart:Cart#struct', 'go/cart.go#go/cart:Cart.Add#method', 'go/cart.go#go/cart:Cart.Checkout#method', 'go/cart.go#go/cart:New#function']
const JAVA_KEYS = ['java/Shop.java#com.acme.Shop#class', 'java/Shop.java#com.acme.Shop.add(String)#method', 'java/Shop.java#com.acme.Shop.add(int)#method', 'java/Shop.java#java/Shop#module']

describe('FR146 every tier names a declaration by the qualified name of its language, and FR147 a snapshot never seals two equal keys', () => {
  it('scenario 1: the syntax tier gives Go, Java, Rust, Python and C declarations the names of the table, all keys unique', () => {
    const d = tmpDir(), repo = copy()
    ids(d, repo, ['index', repo])
    const all = rows(d, 'go/cart.go', 'java/Shop.java', 'rust/lib.rs', 'py/calc.py', 'c/util.c')
    expect(keys(all.filter((r) => r.path === 'go/cart.go'))).toEqual(GO_KEYS)
    expect(keys(all.filter((r) => r.path === 'java/Shop.java'))).toEqual(JAVA_KEYS)
    expect(symbolsOf(all.filter((r) => r.path === 'rust/lib.rs')).map((r) => r.qualified_name)).toEqual(['rust/lib:Counter', 'rust/lib:Counter.<Default>.default', 'rust/lib:Counter.bump', 'rust/lib:Timer', 'rust/lib:Timer.bump'])
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
    expect(symbolsOf(rows(d, 'src/conv.rs')).map((r) => r.qualified_name).filter((n) => n.includes('from'))).toEqual(['src/conv:X.<From>.from(A)', 'src/conv:X.<From>.from(B)'])
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

  it('FR147 edge: two declarations still sharing a name after every suffix take ~<hash of their text>, from the core', () => {
    const d = tmpDir(), repo = fs.realpathSync(tmpDir('pm-keys-dup-'))
    fs.writeFileSync(path.join(repo, 'dup.py'), 'def f():\n    return 1\n\n\ndef f():\n    return 2\n')
    ids(d, repo, ['index', repo])
    expect(rows(d, 'dup.py').filter((r) => r.kind === 'function').map((r) => [r.stable_key, r.start_line]).sort((a, b) => (a[1] as number) - (b[1] as number))).toEqual([[expect.stringMatching(/^dup\.py#dup:f#function~[0-9a-f]{8}$/), 1], [expect.stringMatching(/^dup\.py#dup:f#function~[0-9a-f]{8}$/), 5]])
  }, 240000)
})

describe('FR148 the SCIP importer names a definition as the syntax tier names it', () => {
  it('scenario 2: naming the index leaves every key and body_hash of go/cart.go and java/Shop.java as they were', () => {
    const d = tmpDir(), repo = copy()
    ids(d, repo, ['index', repo])
    const before = rows(d, 'go/cart.go', 'java/Shop.java')
    expect(keys(before)).toEqual([...GO_KEYS, ...JAVA_KEYS].sort())
    expect(before.every((r) => r.body_hash !== null)).toBe(true)
    name(repo, d)
    index(d, repo)
    const after = rows(d, 'go/cart.go', 'java/Shop.java')
    expect(after.map((r) => r.producer)).toEqual(Array(after.length).fill('scip'))
    expect(after.map((r) => [r.stable_key, r.body_hash])).toEqual(before.map((r) => [r.stable_key, r.body_hash]))
    expect(after.every((r) => /^[0-9a-f]{64}$/.test(r.body_hash ?? ''))).toBe(true)
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
    expect(n.staleness).toBe('ambiguous')
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
    expect(n().staleness).toBe('current')
  }, 240000)
})

/** A repository of the given files, indexed. */
function indexed(files: Record<string, string>) {
  const d = tmpDir(), repo = fs.realpathSync(tmpDir('pm-keys-x-'))
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), text) }
  ids(d, repo, ['index', repo])
  return { d, repo }
}
const names = (d: string, file: string) => withSnapshot(d, (db) => (db.prepare("select s.qualified_name from symbol s join file f on f.id = s.file_id where f.path = ? and s.kind <> 'module' order by s.start_byte, s.qualified_name").all(file) as Array<{ qualified_name: string }>).map((r) => r.qualified_name))
const meta = (d: string, key: string) => withSnapshot(d, (db) => { const r = db.prepare('select value from meta where key = ?').get(key) as { value: string } | undefined; return r ? JSON.parse(r.value) : undefined })

describe('FR146 a trait impl names its trait, so two traits with one method do not collide', () => {
  it('impl Display for X and impl Debug for X both declare fmt: X.<Display>.fmt and X.<Debug>.fmt, with no ~n', () => {
    const { d } = indexed({ 'src/t.rs': 'struct X;\nimpl fmt::Display for X {\n    fn fmt(&self, f: &mut Formatter) -> Result { Ok(()) }\n}\nimpl Debug for X {\n    fn fmt(&self, f: &mut Formatter) -> Result { Ok(()) }\n}\n' })
    expect(names(d, 'src/t.rs')).toEqual(['src/t:X', 'src/t:X.<Display>.fmt', 'src/t:X.<Debug>.fmt'])
    expect(meta(d, 'key_disambiguated')).toBeUndefined()
  }, 240000)
})

describe('FR147 a duplicate key is told apart by its content, so inserting one above an existing one renames nothing', () => {
  it('the keys of existing duplicates survive a new duplicate inserted above them, with no nested suffix, and the meta lists every one', () => {
    const body = (n: number) => `def f():\n    return ${n}\n\n\n`
    const first = indexed({ 'dup.py': body(1) + body(2) })
    const before = rows(first.d, 'dup.py').filter((r) => r.kind === 'function')
    expect(before.map((r) => r.stable_key)).toEqual(before.map((r) => expect.stringMatching(/^dup\.py#dup:f#function~[0-9a-f]{8}$/)))
    fs.writeFileSync(path.join(first.repo, 'dup.py'), body(0) + body(1) + body(2))
    index(first.d, first.repo)
    const after = rows(first.d, 'dup.py').filter((r) => r.kind === 'function')
    expect(after).toHaveLength(3)
    for (const r of before) expect(after.map((a) => a.stable_key)).toContain(r.stable_key)
    expect(after.every((r) => (r.stable_key.match(/~/g) ?? []).length === 1)).toBe(true)
    const m = meta(first.d, 'key_disambiguated') as { count: number; truncated: boolean; keys: Array<[string, string]> }
    expect(m.count).toBe(3)
    expect(m.truncated).toBe(false)
    expect(m.keys.map(([base]) => base)).toEqual(Array(3).fill('dup.py#dup:f#function'))
    expect(m.keys.map(([, key]) => key).sort()).toEqual(after.map((r) => r.stable_key).sort())
  }, 240000)
})

describe('FR146 a Go struct is a struct and an interface an interface, in the syntax tier and in a SCIP index', () => {
  it('type X struct, type Y interface and type Z = X are struct, interface and type_alias; find_symbols by kind finds the SCIP-tier struct', () => {
    const { d } = indexed({ 'a.go': 'package a\n\ntype X struct{}\n\ntype Y interface{ M() }\n\ntype Z = X\n\ntype W int\n' })
    expect(withSnapshot(d, (db) => db.prepare("select name, kind from symbol where kind <> 'module' order by start_byte").all())).toEqual([{ name: 'X', kind: 'struct' }, { name: 'Y', kind: 'interface' }, { name: 'Z', kind: 'type_alias' }, { name: 'W', kind: 'type_alias' }])
    const repo = copy(), dir = tmpDir()
    ids(dir, repo)
    name(repo, dir)
    index(dir, repo)
    const found = tool(dir, 'find_symbols', { text: 'Cart', kinds: ['struct'] }).data as { symbols: Array<{ path: string; kind: string; qualified_name: string }> }
    expect(found.symbols.map((x) => [x.path, x.kind, x.qualified_name])).toEqual([['go/cart.go', 'struct', 'go/cart:Cart']])
    // A struct root is a type root for find_tests, by key, in the SCIP tier.
    const reach = tool(dir, 'find_tests', { key: 'go/cart.go#go/cart:Cart#struct' }).data as { tests: unknown[]; totals: unknown }
    expect(reach.tests).toEqual([])
    expect(reach.totals).toBeDefined()
  }, 240000)
})

describe('FR146 parameter types are read as the declaration writes them', () => {
  it('Java varargs, C++ qualifiers, Kotlin defaults and grouped Go names', () => {
    const { d } = indexed({
      'V.java': 'class V {\n  void add(int... xs) {}\n  void add(String s) {}\n}\n',
      'q.cpp': 'void f(const char* a) {}\nvoid f(char* a) {}\n',
      'k.kt': 'class K {\n    fun f(a: Int = 3) {}\n    fun f(a: String) {}\n}\n',
      'g.go': 'package g\n\nfunc init(a, b int) {}\n\nfunc init() {}\n',
    })
    expect(names(d, 'V.java')).toEqual(['V', 'V.add(int...)', 'V.add(String)'])
    expect(names(d, 'q.cpp')).toEqual(['q:f(const char*)', 'q:f(char*)'])
    expect(names(d, 'k.kt')).toEqual(['K', 'K.f(Int)', 'K.f(String)'])
    expect(names(d, 'g.go')).toEqual(['g:init(int,int)', 'g:init()'])
  }, 240000)
})

describe('FR146 a file with several packages or namespaces names each declaration under its own', () => {
  it('Scala nested and chained packages, PHP several namespaces and the global one', () => {
    const { d } = indexed({
      'n.scala': 'package a {\n  package b {\n    class C\n  }\n  class D\n}\n',
      'c.scala': 'package p\npackage q\n\nclass E\n',
      'm.php': '<?php\nnamespace A { class X {} }\nnamespace B { class Y {} }\nnamespace { class G {} }\n',
      'u.php': '<?php\nnamespace A;\nclass X {}\nnamespace B;\nclass Y {}\n',
    })
    expect(names(d, 'n.scala').filter((n) => /C$|D$/.test(n))).toEqual(['a.b.C', 'a.D'])
    expect(names(d, 'c.scala').filter((n) => /E$/.test(n))).toEqual(['p.q.E'])
    expect(names(d, 'm.php').filter((n) => /[XYG]$/.test(n))).toEqual(['A.X', 'B.Y', 'G'])
    expect(names(d, 'u.php').filter((n) => /[XY]$/.test(n))).toEqual(['A.X', 'B.Y'])
  }, 240000)
})

describe('FR146 two same-named classes in different files stay apart in name lookups', () => {
  it('a new file declaring Main.run is added, not a modification of the Main.run another file already has', () => {
    const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' }).trim()
    const repo = fs.realpathSync(tmpDir('pm-keys-git-')), d = tmpDir()
    fs.mkdirSync(path.join(repo, 'a'))
    fs.writeFileSync(path.join(repo, 'a/Main.java'), 'class Main {\n  void run() {\n    System.out.println(1);\n  }\n}\n')
    git(repo, 'init', '-q'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base')
    const base = git(repo, 'rev-parse', 'HEAD')
    fs.mkdirSync(path.join(repo, 'c'))
    fs.writeFileSync(path.join(repo, 'c/Main.java'), 'class Main {\n  void run() {\n    System.out.println(2);\n  }\n}\n')
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'head')
    const head = git(repo, 'rev-parse', 'HEAD')
    expect(cli(['--data-dir', d, 'init']).status).toBe(0)
    expect(cli(['--data-dir', d, 'repo', 'add', repo]).status).toBe(0)
    const out = cli(['--data-dir', d, 'completeness', repo, `${base}..${head}`])
    expect(out.status, out.stderr).toBe(0)
    expect(out.stdout).toMatch(/^changed Main\.run c\/Main\.java:2 added/m)
    expect(out.stdout).not.toMatch(/^changed Main\.run c\/Main\.java:2 modified/m)
  }, 240000)
})

describe('FR149 key and an id or a path are not given together', () => {
  const setup = () => { const d = tmpDir(), repo = copy(); ids(d, repo, ['index', repo]); return d }
  const KEY = 'go/cart.go#go/cart:Cart.Checkout#method'
  const code = (d: string, t: string, input: Record<string, unknown>) => { try { tool(d, t, input) } catch (e) { return [(e as { code?: string }).code, (e as Error).message] as const } return ['none', ''] as const }
  it('rejects key with an id or a path, and an unknown target_key, naming each', () => {
    const d = setup()
    const id = withSnapshot(d, (db) => (db.prepare('select id from symbol where stable_key = ?').get(KEY) as { id: string }).id)
    for (const [t, input] of [['get_symbol', { key: KEY, symbol_id: id }], ['get_symbol', { key: KEY, path: 'go/cart.go' }], ['get_relationships', { key: KEY, subject_id: id }], ['get_relationships', { key: KEY, path: 'go/cart.go' }], ['analyze_impact', { key: KEY, subject_ids: [id] }], ['analyze_impact', { key: KEY, paths: ['go/cart.go'] }], ['find_tests', { key: KEY, paths: ['go/cart.go'] }], ['get_memory', { key: KEY, path: 'go/cart.go' }], ['trace_paths', { source_key: KEY, source_id: id, target_id: id }], ['trace_paths', { source_key: KEY, source_path: 'go/cart.go', target_id: id }]] as const) {
      expect([t, code(d, t, input)[0]]).toEqual([t, 'INVALID_ARGUMENT'])
    }
    const unknown = code(d, 'trace_paths', { source_key: KEY, target_key: 'nowhere#x#function' })
    expect(unknown[0]).toBe('NOT_FOUND')
    expect(unknown[1]).toContain('nowhere#x#function')
  }, 240000)
  it('get_memory by key finds the notes that name the symbol', () => {
    const d = tmpDir(), repo = copy(), notes = tmpDir('pm-keys-notes-')
    fs.writeFileSync(path.join(notes, 'n.md'), '---\nid: n\ntitle: "n title"\nkind: invariant\nnodes:\n  - method:go/cart:Cart.Checkout\n---\n\nBody.\n')
    ids(d, repo, ['index', repo], ['notes', 'add', notes])
    cli(['--data-dir', d, 'notes', 'sync'])
    expect((tool(d, 'get_memory', { key: KEY }).data as { notes: Array<{ id: string }> }).notes.map((n) => n.id)).toEqual(['n'])
    expect((tool(d, 'get_memory', { key: 'go/cart.go#go/cart:New#function' }).data as { notes: unknown[] }).notes).toEqual([])
  }, 240000)
  it('a key two symbols share, in a snapshot sealed before keys were unique, is INVALID_ARGUMENT ambiguous_key', () => {
    const d = setup()
    const catalog = new Database(path.join(d, 'catalog.db'))
    const snap = (catalog.prepare("select id from snapshot where state = 'published'").get() as { id: string }).id
    catalog.close()
    const file = path.join(d, 'snapshots', `${snap}.db`)
    fs.chmodSync(file, 0o644)
    const sealed = new Database(file)
    sealed.exec('drop index symbol_by_key')
    sealed.prepare('update symbol set stable_key = ? where stable_key = ?').run(KEY, 'go/cart.go#go/cart:Cart.Add#method')
    sealed.close()
    fs.chmodSync(file, 0o444)
    const c2 = new Database(path.join(d, 'catalog.db'))
    c2.prepare('update snapshot set store_digest = ? where id = ?').run(require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex'), snap)
    c2.close()
    const r = code(d, 'get_symbol', { key: KEY })
    expect(r[0]).toBe('INVALID_ARGUMENT')
    expect(r[1]).toContain('index again')
  }, 240000)
})

describe('FR150 a note whose reference used a name of an older format is told to rename it', () => {
  it('a missing reference says that names changed with snapshot format 0.8', () => {
    const d = tmpDir(), repo = copy(), notes = tmpDir('pm-keys-notes-')
    fs.writeFileSync(path.join(notes, 'old.md'), '---\nid: old\ntitle: "old title"\nkind: invariant\nnodes:\n  - method:java/Shop:Shop.add\n---\n\nBody.\n')
    ids(d, repo, ['index', repo], ['notes', 'add', notes])
    cli(['--data-dir', d, 'notes', 'sync'])
    const r = tool(d, 'get_memory', { query: 'old title' })
    expect((r.data as { notes: Array<{ missing_refs: string[] }> }).notes[0]!.missing_refs).toEqual(['method:java/Shop:Shop.add'])
    expect(r.limitations.join(' ')).toMatch(/snapshot format 0\.8.*qualified names changed.*rewrite/i)
  }, 240000)
})

describe('FR440 trace_paths explored edges and get_overview links name each symbol end by its key too', () => {
  it('from_key and to_key sit beside from and to where that end is a symbol', () => {
    const { d } = indexed({ 'a.ts': 'export function b(): number {\n  return 1\n}\n\nexport function a(): number {\n  return b()\n}\n' })
    const key = (name: string) => `a.ts#a:${name}#function`
    const idOf = (k: string) => withSnapshot(d, (db) => (db.prepare('select id from symbol where stable_key = ?').get(k) as { id: string }).id)
    const links = (tool(d, 'get_overview', { path: 'a.ts' }).data as { links: Array<Record<string, unknown>> }).links
    expect(links).toEqual([expect.objectContaining({ from: idOf(key('a')), to: idOf(key('b')), from_key: key('a'), to_key: key('b') })])
    const explored = (tool(d, 'trace_paths', { source_key: key('a'), target_key: key('b') }).data as { search: { explored: Array<Record<string, unknown>> } }).search.explored
    expect(explored.length).toBeGreaterThan(0)
    for (const e of explored) expect(e).toEqual(expect.objectContaining({ from_key: key('a'), to_key: key('b') }))
  }, 240000)
})

describe('FR441 a symbol the SCIP importer declares keeps the index\'s own symbol in detail.scip', () => {
  it('get_symbol gives detail.scip on the SCIP tier, and no detail on the syntax tier', () => {
    const d = tmpDir(), repo = copy()
    ids(d, repo, ['index', repo])
    const symbol = (key: string) => (tool(d, 'get_symbol', { key }).data as { symbol: Record<string, unknown> }).symbol
    expect(symbol('go/cart.go#go/cart:Cart.Checkout#method').detail).toBeUndefined()
    name(repo, d)
    index(d, repo)
    expect(symbol('go/cart.go#go/cart:Cart.Checkout#method').detail).toEqual({ scip: `${GO}Cart#Checkout().` })
    expect(symbol('java/Shop.java#com.acme.Shop.add(String)#method').detail).toEqual({ scip: `${JAVA}Shop#add(+1).` })
    expect(withSnapshot(d, (db) => db.prepare("select detail from symbol where stable_key = 'go/cart.go#go/cart:New#function'").get())).toEqual({ detail: JSON.stringify({ scip: `${GO}New().` }) })
  }, 240000)
})
