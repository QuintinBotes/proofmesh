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
        { path: 'go/shape.go', imports: 'partial' },
        { path: 'java/Circle.java', imports: 'partial' },
        // #4 scenario 5: "nothing reports `complete` for imports, because nothing is resolved", also a file with no import.
        { path: 'java/Kind.java', imports: 'partial' },
        // FR221: Kotlin, PHP, Ruby and Rust name imports too, so each reports them partial.
        { path: 'kotlin/Circle.kt', imports: 'partial' },
        { path: 'php/Circle.php', imports: 'partial' },
        { path: 'ruby/circle.rb', imports: 'partial' },
        { path: 'rust/lib.rs', imports: 'partial' },
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
    const rows = new Map(doc.split('\n').filter((l) => /^\| [A-Z]/.test(l) && !l.startsWith('| Language')).flatMap((l) => { const [names, ...cells] = l.split('|').slice(1, -1).map((c) => c.trim()); return names!.split(', ').map((n) => [n.toLowerCase().replace('c++', 'cpp'), cells] as const) }))
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
    expect(importRows(structureIndex()).filter((r) => !/^(go|java|rust)\//.test(r.path)).map((r) => [r.path, r.line, r.detail, r.state])).toEqual([
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
        ['inherits', 'rust/lib:Named', { name: 'Shape' }, 'unresolved', 'outside_capability', null, 7],
        ['implements', 'rust/lib:Circle', { name: 'Shape' }, 'unresolved', 'outside_capability', null, 11],
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
