import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runKit } from '../src/conformance/kit.js'
import { BUILT_IN } from '../src/indexer/languages.js'
import { cli, evidenceSlice, expectedFor, fixtureRepo, indexedRepo, ROOT, rows, tmpDir, withSnapshot } from './helpers.js'

const EXPECTED = expectedFor('syntax-structure')
const syntax = () => { const b = BUILT_IN.find((x) => x.id === 'syntax')!; return { id: 'syntax', entry: b.entry()!, extensions: b.extensions, configNames: [] } }
let indexed: string | undefined
const structureIndex = () => {
  if (!indexed) {
    const d = tmpDir()
    for (const args of [['init'], ['repo', 'add', fixtureRepo('syntax-structure')], ['index', fixtureRepo('syntax-structure')]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
    indexed = d
  }
  return indexed
}

/** Every unresolved import row of an indexed snapshot, as file, line and detail. */
const importRows = (d: string) => withSnapshot(d, (db) => (db.prepare(`select f.path, a.resolution, a.reason, a.target_id, a.detail, e.start_line as line from assertion a join file f on f.id = a.source_id join assertion_evidence ae on ae.assertion_id = a.id join evidence e on e.id = ae.evidence_id where a.type = 'imports' and a.origin = 'syntax'`).all() as Array<{ path: string; resolution: string; reason: string; target_id: string | null; detail: string; line: number }>)
  .map((r) => ({ path: r.path, line: r.line, detail: JSON.parse(r.detail) as Record<string, unknown>, state: `${r.resolution} ${r.reason} ${r.target_id}` })).sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line))

describe('FR115 FR116 FR117 the syntax tier records imports and heritage in Go and Java', () => {
  it('FR115 FR117 each import statement is one unresolved row with the module as written, its alias, and no target', () => {
    const d = structureIndex()
    withSnapshot(d, (db) => {
      const rows = (db.prepare(`select f.path, a.resolution, a.reason, a.target_id, a.detail, ae.evidence_id from assertion a join file f on f.id = a.source_id join assertion_evidence ae on ae.assertion_id = a.id where a.type = 'imports' and a.origin = 'syntax'`).all() as Array<{ path: string; resolution: string; reason: string; target_id: string | null; detail: string; evidence_id: string }>)
      expect(new Set(rows.map((r) => `${r.resolution} ${r.reason} ${r.target_id}`))).toEqual(new Set(['unresolved outside_capability null']))
      const facts = rows.map((r) => ({ from: r.path, line: (db.prepare('select start_line from evidence where id = ?').get(r.evidence_id) as { start_line: number }).start_line, site_text: evidenceSlice(d, db, r.evidence_id), detail: JSON.parse(r.detail) }))
      expect(facts.sort((a, b) => a.from.localeCompare(b.from) || a.line - b.line)).toEqual(EXPECTED.imports_unresolved)
      expect(db.prepare(`select path, json_extract(capabilities, '$.imports') as imports from file order by path`).all()).toEqual([
        { path: 'bash/run.sh', imports: 'partial' },
        { path: 'c/total.c', imports: 'partial' },
        { path: 'cpp/area.cpp', imports: 'partial' },
        { path: 'go/shape.go', imports: 'partial' },
        { path: 'java/Circle.java', imports: 'partial' },
        // #4 scenario 5: "nothing reports `complete` for imports, because nothing is resolved", also a file with no import.
        { path: 'java/Kind.java', imports: 'partial' },
        // FR221: Kotlin, PHP, Ruby and Rust name imports too, so each reports them partial.
        { path: 'kotlin/Circle.kt', imports: 'partial' },
        { path: 'php/Circle.php', imports: 'partial' },
        { path: 'ruby/circle.rb', imports: 'partial' },
        { path: 'rust/lib.rs', imports: 'partial' },
        // FR231: Swift, Scala, C, C++ and Bash name imports too.
        { path: 'scala/Circle.scala', imports: 'partial' },
        { path: 'swift/Circle.swift', imports: 'partial' },
      ])
    })
  }, 240000)

  it('FR116 FR117 SC014 heritage rows name each supertype from the type that declares it, unresolved unless a rule binds it, and pass the conformance kit', async () => {
    const r = await runKit(syntax(), fixtureRepo('syntax-structure'), EXPECTED)
    expect(r.checks.filter((c) => !c.passed).map((c) => `${c.id}: ${c.detail}`)).toEqual([])
    expect(r.checks.map((c) => c.id)).toEqual(expect.arrayContaining(['golden.symbols', 'golden.calls', 'golden.structure']))
    withSnapshot(structureIndex(), (db) => {
      // A Java supertype the files do not declare stays unresolved; a Go struct embedding a type of its own package is a candidate of it, never resolved (FR171).
      expect(db.prepare(`select distinct resolution, reason, target_id from assertion where type in ('inherits', 'implements') order by resolution`).all()).toEqual([{ resolution: 'candidate', reason: 'candidate', target_id: null }, { resolution: 'unresolved', reason: 'outside_capability', target_id: null }])
    })
  }, 240000)

  it('FR118 languages.md states imports, heritage and calls for every syntax-tier language', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'proofmesh', 'languages.md'), 'utf8')
    const rows = new Map(doc.split('\n').filter((l) => /^\| [A-Z]/.test(l) && !l.startsWith('| Language')).flatMap((l) => { const [names, ...cells] = l.split('|').slice(1, -1).map((c) => c.trim()); return names!.split(', ').map((n) => [n.toLowerCase().replace('c++', 'cpp').replace('c#', 'csharp'), cells] as const) }))
    const grammars = JSON.parse(fs.readFileSync(path.join(ROOT, 'adapters', 'syntax', 'dist', 'grammars', 'grammars.json'), 'utf8')) as Record<string, unknown>
    // Python goes to its own adapter, and HCL to the Terraform adapter.
    expect([...rows.keys()].sort()).toEqual(Object.keys(grammars).filter((l) => l !== 'hcl' && l !== 'python').sort())
    expect(rows.get('go')).toEqual(['yes, with module and alias', 'struct embedding', 'yes'])
    expect(rows.get('java')).toEqual(['yes, with module', '`extends`, `implements`', 'yes'])
  })
})

describe('FR221 FR222 FR223 the syntax tier records imports and heritage in Kotlin, Rust, PHP and Ruby', () => {
  it('FR221 an import in Rust, even one inside a function body, is a row at its own line, and a grouped use keeps its names', () => {
    expect(importRows(structureIndex()).filter((r) => r.path === 'rust/lib.rs').map((r) => [r.line, r.detail, r.state])).toEqual([
      [1, { module: 'crate::geo', names: 'Point, Line' }, 'unresolved outside_capability null'],
      [3, { module: 'geo' }, 'unresolved outside_capability null'],
      [14, { module: 'std::fmt' }, 'unresolved outside_capability null'],
    ])
  }, 240000)

  it('FR221 Kotlin, PHP and Ruby give one unresolved row per import statement with the module as written', () => {
    expect(importRows(structureIndex()).filter((r) => /^(kotlin|php|ruby)\//.test(r.path)).map((r) => [r.path, r.line, r.detail, r.state])).toEqual([
      ['kotlin/Circle.kt', 3, { module: 'com.acme.geo.Point' }, 'unresolved outside_capability null'],
      ['php/Circle.php', 4, { module: 'App\\Geo\\Point' }, 'unresolved outside_capability null'],
      ['ruby/circle.rb', 1, { module: 'json' }, 'unresolved outside_capability null'],
      ['ruby/circle.rb', 2, { module: 'base' }, 'unresolved outside_capability null'],
    ])
  }, 240000)

  it('FR222 FR117 supertypes are named from the declaring type: Kotlin supertype, Rust impl and bound, PHP extends and implements, Ruby superclass and include, none with a target, and the kit passes', async () => {
    const r = await runKit(syntax(), fixtureRepo('syntax-structure'), EXPECTED)
    expect(r.checks.filter((c) => !c.passed).map((c) => `${c.id}: ${c.detail}`)).toEqual([])
    withSnapshot(structureIndex(), (db) => {
      const heritage = rows(db, 'inherits', 'implements').filter((x) => /^(kotlin|php|ruby|rust)\//.test(x.path))
      expect(heritage.map((x) => [x.type, x.from, x.detail, x.resolution, x.reason, x.to, x.line])).toEqual([
        ['inherits', 'App.Shapes.Circle', { name: 'Base' }, 'unresolved', 'outside_capability', null, 6],
        ['implements', 'App.Shapes.Circle', { name: 'Shape' }, 'unresolved', 'outside_capability', null, 6],
        ['inherits', 'com.acme.kshapes.Circle', { name: 'Base' }, 'unresolved', 'outside_capability', null, 5],
        ['inherits', 'com.acme.kshapes.Circle', { name: 'Shape', relation: 'supertype' }, 'unresolved', 'outside_capability', null, 5],
        ['inherits', 'rust/lib:Named', { name: 'Shape', rule: 'rust_same_module' }, 'candidate', 'candidate', null, 7], // a trait of its own module (FR750)
        ['implements', 'rust/lib:Circle', { name: 'Shape', rule: 'rust_same_module' }, 'candidate', 'candidate', null, 11],
        ['inherits', 'ruby/circle:Circle', { name: 'Base' }, 'unresolved', 'outside_capability', null, 4],
        ['inherits', 'ruby/circle:Circle', { name: 'Comparable', relation: 'include' }, 'unresolved', 'outside_capability', null, 5],
      ].sort((a, b) => String(a[1]).localeCompare(String(b[1])) || String(JSON.stringify(a[2])).localeCompare(String(JSON.stringify(b[2])))))
    })
  }, 240000)

  it('FR221 FR222 the other forms: aliases, wildcards, groups, generics, a trait impl for a type the file does not declare, include in a module', async () => {
    const { dataDir } = await indexedRepo({
      'a.kt': 'import com.a.b.*\nimport com.a.B as C\n\nclass A<T> : Base<T>(), com.x.Shape<T>, Named by impl\n\ninterface I : J, K\n\nclass H {\n  companion object : Factory\n}\n',
      'a.rs': 'use a::b as c;\nuse a::*;\nuse foo;\nuse a::{b::{c, d}, e};\nmod inline { }\n\nimpl<T> From<T> for Elsewhere {}\ntrait T2: A + B<X> {}\n',
      'a.php': '<?php\nuse A\\B as C;\nuse A\\{B, C\\D};\ninterface I extends J, K {}\nclass Q extends \\X\\Y implements \\A\\Z, W {}\n',
      'a.rb': 'class A < B::C\n  include Foo::Bar, Baz\n  extend X\nend\nmodule M\n  include N\nend\nrequire foo\nrequire \'x\'\n',
    })
    const imports = importRows(dataDir)
    expect(imports.map((r) => [r.path, r.line, r.detail])).toEqual([
      ['a.kt', 1, { module: 'com.a.b.*' }], ['a.kt', 2, { module: 'com.a.B', alias: 'C' }],
      ['a.php', 2, { module: 'A\\B', alias: 'C' }], ['a.php', 3, { module: 'A', names: 'B, C\\D' }],
      ['a.rb', 9, { module: 'x' }],
      ['a.rs', 1, { module: 'a::b', alias: 'c' }], ['a.rs', 2, { module: 'a::*' }], ['a.rs', 3, { module: 'foo' }], ['a.rs', 4, { module: 'a', names: 'b::{c, d}, e' }],
    ])
    withSnapshot(dataDir, (db) => {
      const heritage = rows(db, 'inherits', 'implements').map((x) => [x.path, x.line, x.type, x.from, x.detail])
      expect(heritage).toEqual(expect.arrayContaining([
        ['a.kt', 4, 'inherits', 'A', { name: 'Base' }], ['a.kt', 4, 'inherits', 'A', { name: 'com.x.Shape', relation: 'supertype' }], ['a.kt', 4, 'inherits', 'A', { name: 'Named', relation: 'supertype' }],
        ['a.kt', 6, 'inherits', 'I', { name: 'J', relation: 'supertype' }], ['a.kt', 6, 'inherits', 'I', { name: 'K', relation: 'supertype' }],
        ['a.rs', 7, 'implements', 'a', { name: 'From', for: 'Elsewhere' }],
        ['a.rs', 8, 'inherits', 'a:T2', { name: 'A' }], ['a.rs', 8, 'inherits', 'a:T2', { name: 'B' }],
        ['a.php', 4, 'inherits', 'I', { name: 'J' }], ['a.php', 4, 'inherits', 'I', { name: 'K' }],
        ['a.php', 5, 'inherits', 'Q', { name: '\\X\\Y' }], ['a.php', 5, 'implements', 'Q', { name: '\\A\\Z' }], ['a.php', 5, 'implements', 'Q', { name: 'W' }],
        ['a.rb', 1, 'inherits', 'a:A', { name: 'B::C' }], ['a.rb', 2, 'inherits', 'a:A', { name: 'Foo::Bar', relation: 'include' }], ['a.rb', 2, 'inherits', 'a:A', { name: 'Baz', relation: 'include' }], ['a.rb', 6, 'inherits', 'a:M', { name: 'N', relation: 'include' }],
      ]))
      // A companion object has no name of its own, so its supertype is nobody's row; `extend` and an inline `mod` are neither heritage nor import.
      expect(heritage.some((h) => (h[4] as { name: string }).name === 'Factory' || (h[4] as { name: string }).name === 'X')).toBe(false)
    })
  }, 240000)

  it('FR221 FR222 an impl runs from the type its written path names, a named companion owns its supertypes, a higher-ranked bound is a bound, a percent-literal require is its content, a conditional include is marked', async () => {
    const { dataDir } = await indexedRepo({
      'm.rs': 'mod a { pub struct Thing {} }\nmod b { pub struct Thing {} }\nimpl Shape for b::Thing {}\nimpl Shape for a::Thing {}\nimpl Shape for Thing {}\nimpl Shape for crate::a::Thing {}\nmod c { impl Shape for super::a::Thing {} }\ntrait T: for<\'a> Bound<\'a> {}\ntrait U: Send + for<\'a> Fn(&\'a u8) {}\n',
      'h.kt': 'class Host {\n  companion object Named : Registry { }\n  companion object : Factory { }\n}\n',
      'r.rb': 'require %q(foo)\nrequire %Q[bar]\nclass A\n  include M if enabled?\n  include N unless off\n  if cond\n    include O\n  end\n  include P\nend\nmodule B\n  include Q if z\nend\n',
    })
    expect(importRows(dataDir).map((r) => [r.path, r.line, r.detail.module])).toEqual([['r.rb', 1, 'foo'], ['r.rb', 2, 'bar']])
    withSnapshot(dataDir, (db) => {
      const by = (path: string) => rows(db, 'inherits', 'implements').filter((x) => x.path === path).map((x) => [x.line, x.type, x.from, x.detail]).sort((x, y) => Number(x[0]) - Number(y[0]) || String(x[2]).localeCompare(String(y[2])) || JSON.stringify(x[3]).localeCompare(JSON.stringify(y[3])))
      expect(by('m.rs')).toEqual([
        [3, 'implements', 'm:b.Thing', { name: 'Shape' }],
        [4, 'implements', 'm:a.Thing', { name: 'Shape' }],
        [5, 'implements', 'm', { name: 'Shape', for: 'Thing' }],
        [6, 'implements', 'm:a.Thing', { name: 'Shape' }],
        [7, 'implements', 'm:a.Thing', { name: 'Shape' }],
        [8, 'inherits', 'm:T', { name: 'Bound' }],
        [9, 'inherits', 'm:U', { name: 'Fn' }],
        [9, 'inherits', 'm:U', { name: 'Send' }],
      ])
      expect(by('h.kt')).toEqual([[2, 'inherits', 'Host.Named', { name: 'Registry', relation: 'supertype' }]])
      expect(by('r.rb')).toEqual([
        [4, 'inherits', 'r:A', { name: 'M', relation: 'include', conditional: 'true' }],
        [5, 'inherits', 'r:A', { name: 'N', relation: 'include', conditional: 'true' }],
        [7, 'inherits', 'r:A', { name: 'O', relation: 'include', conditional: 'true' }],
        [9, 'inherits', 'r:A', { name: 'P', relation: 'include' }],
        [12, 'inherits', 'r:B', { name: 'Q', relation: 'include', conditional: 'true' }],
      ])
    })
  }, 240000)

  it('FR221 a file the grammar only partly parses keeps the imports and heritage of the parsed part, and reports syntax partial', async () => {
    const { dataDir } = await indexedRepo({
      'broken.rs': 'use a::b;\ntrait T: U {}\nfn (((\n',
      'broken.kt': 'import a.b.C\nclass K : Base()\nfun ((( \n',
      'broken.rb': 'require "j"\nclass R < Q\nend\ndef ((( \n',
      'broken.php': '<?php\nuse A\\B;\nclass P extends Q {}\nfunction (((\n',
    })
    expect(importRows(dataDir).map((r) => [r.path, r.line, r.detail.module])).toEqual([['broken.kt', 1, 'a.b.C'], ['broken.php', 2, 'A\\B'], ['broken.rb', 1, 'j'], ['broken.rs', 1, 'a::b']])
    withSnapshot(dataDir, (db) => {
      expect(db.prepare(`select path, json_extract(capabilities, '$.syntax') as syntax, json_extract(capabilities, '$.imports') as imports from file order by path`).all()).toEqual(
        ['broken.kt', 'broken.php', 'broken.rb', 'broken.rs'].map((path) => ({ path, syntax: 'partial', imports: 'partial' })))
      expect(rows(db, 'inherits').map((x) => [x.path, x.from, x.detail]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([['broken.kt', 'K', { name: 'Base' }], ['broken.php', 'P', { name: 'Q' }], ['broken.rb', 'broken:R', { name: 'Q' }], ['broken.rs', 'broken:T', { name: 'U' }]])
    })
  }, 240000)

  it('FR223 languages.md states imports, heritage and calls for Kotlin, Rust, PHP and Ruby', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'proofmesh', 'languages.md'), 'utf8')
    const row = (name: string) => doc.split('\n').find((l) => l.startsWith('| ') && l.split('|')[1]!.trim().split(', ').includes(name))!.split('|').slice(2, -1).map((c) => c.trim())
    expect(row('Kotlin')).toEqual(['yes, with module, alias and wildcard', 'supertypes, as `inherits` with `detail.relation` `supertype` unless named in a constructor call', 'yes'])
    expect(row('Rust')).toEqual(['`use` and `mod x;`, with module, alias and grouped names', '`impl Trait for`, trait bounds', 'yes'])
    expect(row('PHP')).toEqual(['`use`, with module, alias and grouped names', '`extends`, `implements`', 'yes'])
    expect(row('Ruby')).toEqual(['`require` and `require_relative` of a string', 'superclass, `include`', 'yes'])
  })
})

const NEW = /^(swift|scala|c|cpp|bash)\//
const calls = (dataDir: string) => withSnapshot(dataDir, (db) => rows(db, 'calls').map((x) => [x.path, x.line, x.from, x.detail?.callee, x.resolution, x.reason] as const))

describe('FR231 FR232 FR233 the syntax tier records imports and heritage in Swift, Scala, C, C++ and Bash, and calls in C and C++', () => {
  it('FR231 each import statement of the fixture is one unresolved row with the module as written, and a C include says whether it is a system include and whether #if wraps it', () => {
    expect(importRows(structureIndex()).filter((r) => NEW.test(r.path)).map((r) => [r.path, r.line, r.detail, r.state])).toEqual([
      ['bash/run.sh', 1, { module: './lib.sh' }, 'unresolved outside_capability null'],
      ['bash/run.sh', 2, { module: './lib.sh' }, 'unresolved outside_capability null'],
      ['c/total.c', 1, { module: 'stdio.h', system: 'true' }, 'unresolved outside_capability null'],
      ['c/total.c', 2, { module: 'add.h', system: 'false' }, 'unresolved outside_capability null'],
      ['c/total.c', 5, { module: 'extra.h', system: 'false', conditional: 'true' }, 'unresolved outside_capability null'],
      ['cpp/area.cpp', 1, { module: 'shape.hpp', system: 'false' }, 'unresolved outside_capability null'],
      ['scala/Circle.scala', 3, { module: 'com.acme.geo', names: 'Point, Line' }, 'unresolved outside_capability null'],
      ['scala/Circle.scala', 7, { module: 'scala.math.Pi' }, 'unresolved outside_capability null'],
      ['swift/Circle.swift', 1, { module: 'Foundation' }, 'unresolved outside_capability null'],
    ])
  }, 240000)

  it('FR232 FR233 FR117 heritage and the calls of the fixture hold as a closed world, from the declaring type or function, with no target', async () => {
    const r = await runKit(syntax(), fixtureRepo('syntax-structure'), EXPECTED)
    expect(r.checks.filter((c) => !c.passed).map((c) => `${c.id}: ${c.detail}`)).toEqual([])
    withSnapshot(structureIndex(), (db) => {
      expect(rows(db, 'inherits', 'implements').filter((x) => NEW.test(x.path)).map((x) => [x.type, x.from, x.detail, x.resolution, x.reason, x.to, x.line])).toEqual([
        ['inherits', 'com.acme.sshapes.Circle', { name: 'Base' }, 'unresolved', 'outside_capability', null, 5],
        ['implements', 'com.acme.sshapes.Circle', { name: 'Shape' }, 'unresolved', 'outside_capability', null, 5],
        ['inherits', 'cpp/area:Circle', { name: 'Shape' }, 'unresolved', 'outside_capability', null, 3],
        ['inherits', 'swift/Circle:Circle', { name: 'Base', relation: 'supertype' }, 'unresolved', 'outside_capability', null, 3],
        ['inherits', 'swift/Circle:Circle', { name: 'Shape', relation: 'supertype' }, 'unresolved', 'outside_capability', null, 3],
      ])
    })
  }, 240000)

  it('FR233 a C function has a call row for the call in its body, a macro call is a call, and every function of the C fixture with a call has one (SC-3)', () => {
    const c = withSnapshot(structureIndex(), (db) => rows(db, 'calls').filter((x) => x.path === 'c/total.c').map((x) => [x.from, x.detail?.callee, x.resolution, x.reason, x.to]))
    expect(c).toEqual([['c/total:biggest', 'MAX', 'unresolved', 'outside_capability', null], ['c/total:total', 'add', 'unresolved', 'outside_capability', null]])
    // Every function of the file whose body has a call: both of them, by the fixture's own text.
    const text = fs.readFileSync(path.join(fixtureRepo('syntax-structure'), 'c', 'total.c'), 'utf8')
    const withCall = [...text.matchAll(/^int (\w+)\([^)]*\) \{.*\w\(.*\}$/gm)].map((m) => `c/total:${m[1]}`)
    expect(withCall.sort()).toEqual(c.map((x) => x[0]).sort())
  }, 240000)

  it('FR233 a C++ call names its last identifier, qualified, templated or through an object, from the function or method that holds it, and a callee with no name is no row', async () => {
    const { dataDir } = await indexedRepo({
      'k.cpp': 'void g() { h<int>(2); ns::k(); a::b::c(); std::make_unique<T>(1); this->m(); p.q<int>(1); (*fp)(1); r(); }\nclass W { double area() { return z(); } };\n',
      'k.c': 'int f(void) { (*fp)(1); return s(2) + t->u(3) + tab[0](4); }\n',
    })
    expect(calls(dataDir).map(([p, l, from, callee]) => [p, l, from, callee]).sort((x, y) => String(x[0]).localeCompare(String(y[0])) || String(x[3]).localeCompare(String(y[3])))).toEqual([
      ['k.c', 1, 'k:f', 's'], ['k.c', 1, 'k:f', 'u'],
      ['k.cpp', 1, 'k:g', 'c'], ['k.cpp', 1, 'k:g', 'h'], ['k.cpp', 1, 'k:g', 'k'], ['k.cpp', 1, 'k:g', 'm'], ['k.cpp', 1, 'k:g', 'make_unique'], ['k.cpp', 1, 'k:g', 'q'], ['k.cpp', 1, 'k:g', 'r'],
      ['k.cpp', 2, 'k:W.area', 'z'],
    ])
  }, 240000)

  it('FR231 the other forms: Scala wildcard, rename and selectors, Swift attribute and kind, a C include guard, #else and a computed include, Bash quoted, expanded and later arguments', async () => {
    const { dataDir } = await indexedRepo({
      'a.scala': 'import a.b._\nimport a.b.*\nimport a.b.{C => D, E}\nimport a.b.C as D\nimport a.B, c.D\nobject O { def f = { import x.y.Z\n 1 } }\n',
      'a.swift': '@testable import Foo\nimport struct Foo.Bar\nimport Foo.Bar.Baz\n',
      'g.c': '#ifndef G_H\n#define G_H\n#include <a.h>\n#endif\n',
      'e.c': '#if X\n#include "p.h"\n#else\n#include "q.h"\n#endif\n#include "r.h"\n#include MACRO\n',
      'b.sh': 'source "./a.sh"\nsource \'b.sh\'\nsource "$DIR/c.sh"\nsource $DIR/d.sh\nsource <(foo)\nsource e.sh extra\nsource\n[ -f x ] && source f.sh\n',
    })
    expect(importRows(dataDir).map((r) => [r.path, r.line, r.detail])).toEqual([
      ['a.scala', 1, { module: 'a.b._' }], ['a.scala', 2, { module: 'a.b.*' }], ['a.scala', 3, { module: 'a.b', names: 'C => D, E' }], ['a.scala', 4, { module: 'a.b.C', alias: 'D' }], ['a.scala', 5, { module: 'a.B, c.D' }], ['a.scala', 6, { module: 'x.y.Z' }],
      ['a.swift', 1, { module: 'Foo' }], ['a.swift', 2, { module: 'Foo.Bar' }], ['a.swift', 3, { module: 'Foo.Bar.Baz' }],
      ['b.sh', 1, { module: './a.sh' }], ['b.sh', 2, { module: 'b.sh' }], ['b.sh', 6, { module: 'e.sh' }], ['b.sh', 8, { module: 'f.sh' }],
      // The include guard wraps the whole file, so it does not make the include conditional.
      ['e.c', 2, { module: 'p.h', system: 'false', conditional: 'true' }], ['e.c', 4, { module: 'q.h', system: 'false', conditional: 'true' }], ['e.c', 6, { module: 'r.h', system: 'false' }],
      ['g.c', 3, { module: 'a.h', system: 'true' }],
    ])
  }, 240000)

  it('FR232 the other forms: Swift struct, enum, protocol, generic and qualified supertypes and no extension; Scala trait, with, comma, generic and qualified; C++ several bases, qualified, templated, struct', async () => {
    const { dataDir } = await indexedRepo({
      'a.swift': 'struct S: Equatable, Hashable {}\nprotocol P: Q, R {}\nextension S: P {}\nenum E: Int, Codable { case a }\nclass G: Base<Int>, Mod.Proto {}\n',
      'a.scala': 'class A extends B(1) with C with D[Int]\ntrait T extends U with V\nobject O extends X\nclass F(x: Int) extends G.H with I.J\nclass K extends L, M\n',
      'a.cpp': 'class A : public B, virtual C, private ns::D, E<int> {};\nstruct S : B {};\ntemplate<class T> class U : public V<T> {};\n',
    })
    withSnapshot(dataDir, (db) => {
      const by = (p: string) => rows(db, 'inherits', 'implements').filter((x) => x.path === p).map((x) => [x.line, x.type, x.from, x.detail])
      expect(by('a.swift')).toEqual(expect.arrayContaining([
        [1, 'inherits', 'a:S', { name: 'Equatable', relation: 'supertype' }], [1, 'inherits', 'a:S', { name: 'Hashable', relation: 'supertype' }],
        [2, 'inherits', 'a:P', { name: 'Q', relation: 'supertype' }], [2, 'inherits', 'a:P', { name: 'R', relation: 'supertype' }],
        [4, 'inherits', 'a:E', { name: 'Int', relation: 'supertype' }], [4, 'inherits', 'a:E', { name: 'Codable', relation: 'supertype' }],
        [5, 'inherits', 'a:G', { name: 'Base', relation: 'supertype' }], [5, 'inherits', 'a:G', { name: 'Mod.Proto', relation: 'supertype' }],
      ]))
      expect(by('a.swift')).toHaveLength(8)
      expect(by('a.scala')).toEqual(expect.arrayContaining([
        [1, 'inherits', 'A', { name: 'B' }], [1, 'implements', 'A', { name: 'C' }], [1, 'implements', 'A', { name: 'D' }],
        [2, 'inherits', 'T', { name: 'U' }], [2, 'implements', 'T', { name: 'V' }],
        [3, 'inherits', 'O', { name: 'X' }],
        [4, 'inherits', 'F', { name: 'G.H' }], [4, 'implements', 'F', { name: 'I.J' }],
        [5, 'inherits', 'K', { name: 'L' }], [5, 'implements', 'K', { name: 'M' }],
      ]))
      expect(by('a.scala')).toHaveLength(10)
      expect(by('a.cpp')).toEqual(expect.arrayContaining([
        [1, 'inherits', 'a:A', { name: 'B' }], [1, 'inherits', 'a:A', { name: 'C' }], [1, 'inherits', 'a:A', { name: 'ns::D' }], [1, 'inherits', 'a:A', { name: 'E' }],
        [2, 'inherits', 'a:S', { name: 'B' }], [3, 'inherits', 'a:U', { name: 'V' }],
      ]))
      expect(by('a.cpp')).toHaveLength(6)
    })
  }, 240000)

  it('FR231 only a real include guard is no condition: #if FEATURE and an #ifndef with no #define still mark an include conditional', async () => {
    const { dataDir } = await indexedRepo({
      'f.c': '#if FEATURE\n#include "f.h"\n#endif\n',
      'g.c': '#ifndef X\n#define X\n#include "a.h"\n#endif\n',
      'h.c': '#ifndef X\n#include "a.h"\n#endif\n',
      'p.c': '#pragma once\n#include "a.h"\n',
    })
    expect(importRows(dataDir).map((r) => [r.path, r.line, r.detail.conditional ?? null])).toEqual([['f.c', 2, 'true'], ['g.c', 3, null], ['h.c', 2, 'true'], ['p.c', 2, null]])
  }, 240000)

  it('FR231 FR232 a Scala import of several clauses keeps its module as written, and a package object has no heritage row of its own', async () => {
    const { dataDir } = await indexedRepo({ 'm.scala': 'import a._, b.C\nimport a.{B, C}, d.E\npackage object p extends Base\nobject Q extends Z\n' })
    expect(importRows(dataDir).map((r) => [r.line, r.detail])).toEqual([[1, { module: 'a._, b.C' }], [2, { module: 'a.{B, C}, d.E' }]])
    withSnapshot(dataDir, (db) => expect(rows(db, 'inherits', 'implements').map((x) => [x.line, x.from, x.detail?.name])).toEqual([[4, 'Q', 'Z']]))
  }, 240000)

  it('FR233 a C++ dependent call names its last identifier, and a method defined outside its template class owns the calls in its body', async () => {
    const { dataDir } = await indexedRepo({
      'd.cpp': 'template<class T> void u(T& p) { p.template g<int>(); T::template h<int>(); p.k<int>(); }\ntemplate<class T> struct A { void f(); };\ntemplate<class T> void A<T>::f() { z(); }\nvoid B::m() { y(); }\n',
    })
    expect(calls(dataDir).map(([, l, from, callee]) => [l, from, callee]).sort((a, b) => String(a[2]).localeCompare(String(b[2])))).toEqual([
      [1, 'd:u', 'g'], [1, 'd:u', 'h'], [1, 'd:u', 'k'], [4, 'd:B.m', 'y'], [3, 'd:A.f', 'z'],
    ])
  }, 240000)

  it('FR231 a Bash source of a glob is a call and no import, and a quoted star is a literal path', async () => {
    const { dataDir } = await indexedRepo({ 'g.sh': 'source *.sh\nsource a?.sh\nsource "*.sh"\nsource ~/x.sh\n' })
    expect(importRows(dataDir).map((r) => [r.line, r.detail.module])).toEqual([[3, '*.sh'], [4, '~/x.sh']])
  }, 240000)

  it('FR231 FR232 FR233 a file the grammar only partly parses keeps the imports, heritage and calls of the parsed part, and reports syntax partial', async () => {
    const { dataDir } = await indexedRepo({
      'broken.c': '#include <a.h>\nint f(void) { return g(1); }\nint (((\n',
      'broken.cpp': '#include "x.h"\nclass A : public B {};\nvoid h() { k(); }\nvoid (((\n',
      'broken.scala': 'import a.b.C\nclass K extends B with D\ndef ((( \n',
      'broken.swift': 'import Foo\nclass S: Base {}\nfunc ((( \n',
      'broken.sh': 'source ./a.sh\nif (((\n',
    })
    expect(importRows(dataDir).map((r) => [r.path, r.line, r.detail.module])).toEqual([['broken.c', 1, 'a.h'], ['broken.cpp', 1, 'x.h'], ['broken.scala', 1, 'a.b.C'], ['broken.sh', 1, './a.sh'], ['broken.swift', 1, 'Foo']])
    withSnapshot(dataDir, (db) => {
      expect(db.prepare(`select path, json_extract(capabilities, '$.syntax') as syntax, json_extract(capabilities, '$.imports') as imports from file order by path`).all()).toEqual(
        ['broken.c', 'broken.cpp', 'broken.scala', 'broken.sh', 'broken.swift'].map((path) => ({ path, syntax: 'partial', imports: 'partial' })))
      expect(rows(db, 'inherits', 'implements').map((x) => [x.path, x.type, x.detail?.name]).sort((a, b) => a.join().localeCompare(b.join()))).toEqual([['broken.cpp', 'inherits', 'B'], ['broken.scala', 'implements', 'D'], ['broken.scala', 'inherits', 'B'], ['broken.swift', 'inherits', 'Base']])
    })
    expect(calls(dataDir).filter(([p]) => /^broken\.c(pp)?$/.test(p)).map(([p, , from, callee]) => [p, from, callee])).toEqual([['broken.c', 'broken:f', 'g'], ['broken.cpp', 'broken:h', 'k']])
  }, 240000)

  it('FR233 a call inside a googletest macro body is a call, and so is the assertion macro itself', async () => {
    const { dataDir } = await indexedRepo({ 't_test.cc': '#include <gtest/gtest.h>\nTEST(Calc, Adds) { EXPECT_EQ(add(1, 2), 3); }\n' })
    expect(calls(dataDir).map(([p, l, , callee]) => [p, l, callee]).sort()).toEqual([['t_test.cc', 2, 'EXPECT_EQ'], ['t_test.cc', 2, 'add']])
  }, 240000)

  it('FR231 FR232 FR233 languages.md states imports, heritage and calls for Swift, Scala, C, C++ and Bash', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'proofmesh', 'languages.md'), 'utf8')
    const row = (name: string) => doc.split('\n').find((l) => l.startsWith('| ') && l.split('|')[1]!.trim().split(', ').includes(name))!.split('|').slice(2, -1).map((c) => c.trim())
    expect(row('Swift')).toEqual(['yes, with module', 'supertypes, as `inherits` with `detail.relation` `supertype`', 'yes'])
    expect(row('Scala')).toEqual(['yes, with module, wildcard, alias and selector names', '`extends` as `inherits`, `with` as `implements`', 'yes'])
    expect(row('C')).toEqual(['`#include`, with `detail.system` and `detail.conditional`', 'no', 'yes'])
    expect(row('C++')).toEqual(['`#include`, with `detail.system` and `detail.conditional`', 'base classes, as `inherits`', 'yes'])
    expect(row('Bash')).toEqual(['`source` and `.` of a literal path', 'no', 'yes'])
  })
})

describe('FR850 FR851 FR852 the syntax tier records a PHP call by a plain or qualified name and a new', () => {
  it('FR850 FR851 helper(), \\App\\helper(), \\strlen(), new Mailer(), new \\App\\Mailer(), Mailer::make(), parent::boot() and $this->send() each give one unresolved calls row, with the qualifier as written and form new on a creation', async () => {
    const { dataDir } = await indexedRepo({
      'src/a.php': '<?php\nnamespace App;\n\nfunction helper() {}\n\nclass Mailer {\n    public function send() {\n        helper();\n        \\App\\helper();\n        new Mailer();\n        $this->send();\n        new \\App\\Mailer();\n        Mailer::make();\n        \\strlen(\'\');\n        parent::boot();\n    }\n}\n',
    })
    const php = withSnapshot(dataDir, (db) => rows(db, 'calls')).map((r) => [r.from, r.line, r.resolution, r.reason, r.detail?.callee, r.detail?.qualifier, r.detail?.form])
    const call = (line: number, callee: string, qualifier?: string, form?: string) => ['App.Mailer.send', line, 'unresolved', 'outside_capability', callee, qualifier, form]
    expect(php).toEqual([
      call(8, 'helper'),
      call(9, 'helper', '\\App'),
      call(10, 'Mailer', undefined, 'new'),
      call(11, 'send'),
      call(12, 'Mailer', '\\App', 'new'),
      call(13, 'make', 'Mailer'),
      call(14, 'strlen', '\\'),
      call(15, 'boot', 'parent'),
    ])
  }, 240000)

  it('FR852 languages.md states the PHP plain call, new and qualifier', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'proofmesh', 'languages.md'), 'utf8')
    expect(doc).toContain('A PHP call by a plain name (`helper()`) or a `new C()` is a call like any other (FR850)')
    expect(doc).toContain('a static call (`Mailer::make()`, `parent::boot()`) has its scope as written, and a `new` has `form` `new` (FR851)')
  })
})
