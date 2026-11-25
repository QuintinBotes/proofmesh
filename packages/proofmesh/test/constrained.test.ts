import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { RESOLUTION_VERSION } from '../src/indexer/constrained/index.js'
import { cli, expectedFor, fixtureRepo, indexedRepo, ROOT, symbolId, tmpDir, tool, withSnapshot } from './helpers.js'

const EXPECTED = expectedFor('constrained')
let indexed: string | undefined
const constrainedIndex = () => {
  if (!indexed) {
    const d = tmpDir()
    for (const args of [['init'], ['repo', 'add', fixtureRepo('constrained')], ['index', fixtureRepo('constrained')]]) expect(cli(['--data-dir', d, ...args]).status).toBe(0)
    indexed = d
  }
  return indexed
}

type Fact = { at: string; type: string; name: string; resolution: string; reason?: string; rule?: string; to?: string; candidates?: string[]; detail?: Record<string, string> }
type Row = { id: string; type: string; resolution: string; reason: string | null; detail: string | null; target_kind: string | null; target_id: string | null; source_kind: string; source_id: string }

/** Every call, supertype and import of the Go and Java files that the syntax tier read, as the oracle writes them. */
function facts(db: Database.Database, keep: (f: Fact) => boolean = () => true, wanted: Record<string, string[]> = {}): Fact[] {
  const found = (db.prepare("select id, type, resolution, reason, detail, target_kind, target_id, source_kind, source_id from assertion where origin = 'syntax' and type in ('calls', 'inherits', 'implements', 'imports') order by id").all() as Row[]).flatMap((r) => {
    const ev = db.prepare('select e.start_line as line, f.path as path from assertion_evidence ae join evidence e on e.id = ae.evidence_id join file f on f.id = e.file_id where ae.assertion_id = ? order by e.start_byte limit 1').get(r.id) as { line: number; path: string }
    if (!/\.(go|java)$/.test(ev.path)) return []
    const detail = (r.detail ? JSON.parse(r.detail) : {}) as Record<string, string>
    const at = `${ev.path}:${ev.line}`
    const name = r.type === 'calls' ? detail.callee! : r.type === 'imports' ? detail.module! : detail.name!
    const candidates = (db.prepare("select s.qualified_name || '@' || f.path as n from assertion_candidate c join symbol s on s.id = c.symbol_id join file f on f.id = s.file_id where c.assertion_id = ? order by c.rank").all(r.id) as Array<{ n: string }>).map((c) => c.n)
    const to = r.resolution === 'resolved' ? (db.prepare('select path as n from file where id = ?').get(r.target_id) as { n: string }).n : undefined
    const keys = wanted[`${at}:${name}`] ?? []
    const shown = Object.fromEntries(keys.filter((k) => detail[k] !== undefined).map((k) => [k, detail[k]!]))
    const fact: Fact = { at, type: r.type, name, resolution: r.resolution, ...(r.resolution === 'unresolved' ? { reason: r.reason! } : {}), ...(detail.rule ? { rule: detail.rule } : {}), ...(to ? { to } : {}), ...(candidates.length ? { candidates } : {}), ...(keys.length ? { detail: shown } : {}) }
    return keep(fact) ? [fact] : []
  })
  return found.sort((a, b) => a.at.localeCompare(b.at, 'en', { numeric: true }) || a.name.localeCompare(b.name))
}
/** The detail keys the oracle names for each row, so a row is compared on what the oracle says and on nothing else. */
const wantedDetail = (rows: Fact[]) => Object.fromEntries(rows.filter((r) => r.detail).map((r) => [`${r.at}:${r.name}`, Object.keys(r.detail!)]))
const sorted = (rows: Fact[]) => [...rows].sort((a, b) => a.at.localeCompare(b.at, 'en', { numeric: true }) || a.name.localeCompare(b.name))
const oracle = (section: string): Fact[] => EXPECTED[section]
const all = (): Fact[] => [...oracle('calls'), ...oracle('heritage'), ...oracle('imports')]
const only = (at: string, name: string): Fact => all().find((f) => f.at === at && f.name === name)!
const actual = (at: string, name: string) => withSnapshot(constrainedIndex(), (db) => facts(db, () => true, wantedDetail([only(at, name)])).find((f) => f.at === at && f.name === name))

describe('FR171 FR176 FR177 issue 16 SC-1: every site of fixtures/constrained is bound as the language rules say', () => {
  it('FR171 FR176 the calls, supertypes and imports of the fixture equal the hand-written oracle, row for row', () => {
    withSnapshot(constrainedIndex(), (db) => {
      expect(facts(db, () => true, wantedDetail(all()))).toEqual(sorted(all()))
    })
  }, 240000)
})

describe('FR173 issue 16 scenarios 1 and 2: Go binds a name through its package, its imports and its exports', () => {
  it('FR173 scenario 1: lib.Format(x) is one candidate, lib/lib.go Format, rule go_package_member; helper() is svc/util.go helper only, rule go_same_package, never other', () => {
    const format = actual('svc/main.go:9', 'Format'), helper = actual('svc/main.go:9', 'helper')
    expect(format).toMatchObject({ resolution: 'candidate', rule: 'go_package_member', candidates: ['lib/lib:Format@lib/lib.go'] })
    expect(helper).toMatchObject({ resolution: 'candidate', rule: 'go_same_package', candidates: ['svc/util:helper@svc/util.go'] })
    expect(JSON.stringify([format, helper])).not.toContain('other/')
  }, 240000)

  it('FR173 scenario 2: lib.format(x) is unresolved unknown_name with detail.visibility unexported; an unexported name is never a candidate across packages', () => {
    expect(actual('svc/main.go:6', 'format')).toMatchObject({ resolution: 'unresolved', reason: 'unknown_name', detail: { visibility: 'unexported' } })
    expect(actual('svc/main.go:8', 'reset')).toMatchObject({ resolution: 'unresolved', reason: 'outside_capability' })
    expect(actual('svc/main.go:8', 'reset')!.candidates).toBeUndefined()
  }, 240000)

  it('FR173 a local that hides a function or a package binds nothing: a local func value named helper, and a parameter named lib', () => {
    expect(actual('svc/main.go:14', 'helper')).toMatchObject({ resolution: 'unresolved', reason: 'unknown_name', detail: { shadowed: 'local' } })
    expect(actual('svc/main.go:18', 'Format')).toMatchObject({ resolution: 'unresolved' })
    expect(actual('svc/main.go:18', 'Format')!.candidates).toBeUndefined()
  }, 240000)

  it('FR173 a dot import brings the exported names of its package into scope, and a blank import binds nothing', () => {
    expect(actual('svc/dot.go:6', 'Render')).toMatchObject({ resolution: 'candidate', rule: 'go_dot_import', candidates: ['lib/lib:Render@lib/lib.go'] })
    expect(actual('svc/blank.go:6', 'Render')).toMatchObject({ resolution: 'unresolved', reason: 'outside_capability' })
  }, 240000)

  it('FR173 review 4: a method called on a receiver whose type the tier cannot know binds to nothing, whatever type of the repository has a method of that name', () => {
    // lib.Item has exported Total and Write methods; none of these receivers is known to be one.
    for (const [at, name] of [['svc/main.go:7', 'Total'], ['svc/collide.go:10', 'Write'], ['svc/collide.go:11', 'Write']] as const) {
      expect(actual(at, name)).toMatchObject({ resolution: 'unresolved', reason: 'outside_capability' })
      expect(actual(at, name)!.candidates).toBeUndefined()
    }
    // The positive control: a qualified call whose package is known does bind.
    expect(actual('svc/main.go:9', 'Format')).toMatchObject({ resolution: 'candidate' })
  }, 240000)

  it('FR173 a struct embeds the type of its own package, or of an imported one, as a candidate with its rule', () => {
    expect(actual('svc/util.go:12', 'Base')).toMatchObject({ resolution: 'candidate', rule: 'go_same_package', candidates: ['svc/util:Base@svc/util.go'] })
    expect(actual('svc/util.go:13', 'lib.Item')).toMatchObject({ resolution: 'candidate', rule: 'go_package_member', candidates: ['lib/lib:Item@lib/lib.go'] })
  }, 240000)
})

describe('FR174 FR175 issue 16 scenario 3: Java binds a name through its imports, its package and its visibility, and a type is never a method', () => {
  it('FR174 scenario 3: Util.format(x) has exactly one candidate, a.Util.format, rule java_import, though the caller has its own package-mate b.Util.format', () => {
    expect(actual('java/b/src/main/java/b/Use.java:8', 'format')).toMatchObject({ resolution: 'candidate', rule: 'java_import', candidates: ['a.Util.format@java/a/src/main/java/a/Util.java'] })
  }, 240000)

  it('FR175 scenario 3: new Order() has one candidate, the class b.Order, and never the method order; order() inside Order is the method, never the class', () => {
    const made = actual('java/b/src/main/java/b/Use.java:7', 'Order')
    expect(made).toMatchObject({ resolution: 'candidate', rule: 'java_same_package', candidates: ['b.Order@java/b/src/main/java/b/Order.java'] })
    const called = actual('java/b/src/main/java/b/Order.java:5', 'order')
    expect(called).toMatchObject({ resolution: 'candidate', rule: 'java_same_class', candidates: ['b.Order.order@java/b/src/main/java/b/Order.java'] })
  }, 240000)

  it('FR174 a variable of the name of a type hides the type: Util.format("x") on a local named Util is not a static call on the import, and binds to nothing', () => {
    expect(actual('java/b/src/main/java/b/Use.java:20', 'format')).toMatchObject({ resolution: 'unresolved', reason: 'outside_capability' })
    expect(actual('java/b/src/main/java/b/Use.java:20', 'format')!.candidates).toBeUndefined()
    expect(actual('java/b/src/main/java/b/Use.java:8', 'format')).toMatchObject({ resolution: 'candidate', rule: 'java_import' })
  }, 240000)

  it('FR174 supertypes: a class extends the type a single import names, ahead of a type of the same name in its package, and implements the interface of its package', () => {
    expect(actual('java/b/src/main/java/b/Use.java:5', 'Util')).toMatchObject({ resolution: 'candidate', rule: 'java_import', candidates: ['a.Util@java/a/src/main/java/a/Util.java'] })
    expect(actual('java/b/src/main/java/b/Order.java:3', 'Named')).toMatchObject({ resolution: 'candidate', rule: 'java_same_package', candidates: ['b.Named@java/b/src/main/java/b/Named.java'] })
  }, 240000)
})

describe('FR172 issue 16 scenario 4: no name binds across build modules without a declared dependency', () => {
  it('FR172 scenario 4: a.Back importing b.Use while a declares no dependency on b is unresolved dependency_missing naming module b, and so is the use of the type', () => {
    expect(actual('java/a/src/main/java/a/Back.java:3', 'b.Use')).toMatchObject({ resolution: 'unresolved', reason: 'dependency_missing', detail: { undeclared: 'example:b' } })
    expect(actual('java/a/src/main/java/a/Back.java:7', 'Use')).toMatchObject({ resolution: 'unresolved', reason: 'dependency_missing', detail: { undeclared: 'example:b' } })
    expect(actual('svc/bad.go:3', 'example.com/other')).toMatchObject({ resolution: 'unresolved', reason: 'dependency_missing', detail: { undeclared: 'example.com/other' } })
    expect(actual('svc/bad.go:6', 'Format')).toMatchObject({ resolution: 'unresolved', reason: 'dependency_missing', detail: { undeclared: 'example.com/other' } })
  }, 240000)

  it('FR172 SC-2: not one resolved or candidate row of the syntax tier ties a module to another it has no depends_on to', () => {
    withSnapshot(constrainedIndex(), (db) => {
      const crossing = db.prepare(`
        with owner as (select s.file_id as file_id, e.src as project from edge e join symbol s on s.id = e.dst and s.kind = 'module' join symbol p on p.id = e.src and p.kind = 'project' where e.type = 'contains'),
        bound as (select a.id, case a.source_kind when 'file' then a.source_id else (select file_id from symbol where id = a.source_id) end as src_file,
          case when a.resolution = 'resolved' then case a.target_kind when 'file' then a.target_id else (select file_id from symbol where id = a.target_id) end else (select file_id from symbol where id = c.symbol_id) end as dst_file
          from assertion a left join assertion_candidate c on c.assertion_id = a.id where a.origin = 'syntax' and a.resolution in ('resolved', 'candidate', 'ambiguous'))
        select count(*) as n from bound b join owner so on so.file_id = b.src_file join owner d on d.file_id = b.dst_file
        where so.project <> d.project and not exists (select 1 from edge e where e.type = 'depends_on' and e.src = so.project and e.dst = d.project)`).get() as { n: number }
      expect(crossing.n).toBe(0)
      // The control: the same query does see the edges that are declared, so zero is not an empty join.
      const declared = (db.prepare(`
        with owner as (select s.file_id as file_id, e.src as project from edge e join symbol s on s.id = e.dst and s.kind = 'module' join symbol p on p.id = e.src and p.kind = 'project' where e.type = 'contains')
        select count(*) as n from assertion a join assertion_candidate c on c.assertion_id = a.id join symbol cs on cs.id = c.symbol_id join symbol ss on ss.id = a.source_id join owner so on so.file_id = ss.file_id join owner d on d.file_id = cs.file_id where so.project <> d.project`).get() as { n: number }).n
      expect(declared).toBeGreaterThan(0)
    })
  }, 240000)

  it('FR172 a function or a type of the same name in a module the caller does not declare is never a candidate: other has Format, Render, helper, Item.Total', () => {
    withSnapshot(constrainedIndex(), (db) => {
      const names = (db.prepare("select count(*) as n from assertion_candidate c join symbol s on s.id = c.symbol_id join file f on f.id = s.file_id where f.path like 'other/%'").get() as { n: number }).n
      expect(names).toBe(0)
      // The positive control: the module the caller does declare does supply candidates.
      expect((db.prepare("select count(*) as n from assertion_candidate c join symbol s on s.id = c.symbol_id join file f on f.id = s.file_id where f.path like 'lib/%'").get() as { n: number }).n).toBeGreaterThan(4)
    })
  }, 240000)
})

describe('FR174 FR176 issue 16 scenario 5: visibility, receivers of unknown type, and the cap', () => {
  it('FR174 FR176 review 4 scenario 5: x.p() on a value of unknown type never lists the private a.Util.p, nor the package-private q, nor the public shown or format: no receiver of unknown type is bound', () => {
    for (const [line, name] of [[12, 'p'], [13, 'q'], [14, 'shown'], [15, 'format']] as const) {
      expect(actual(`java/b/src/main/java/b/Use.java:${line}`, name)).toMatchObject({ resolution: 'unresolved', reason: 'outside_capability' })
      expect(actual(`java/b/src/main/java/b/Use.java:${line}`, name)!.candidates).toBeUndefined()
    }
  }, 240000)

  it('FR176 scenario 5: two to five overloads are ambiguous and all listed; more than five are ambiguous with the first five by position and detail.more counting the rest', async () => {
    const TYPES = ['int', 'long', 'short', 'byte', 'char', 'float', 'double']
    const overloads = (n: number) => ({ 'p/T.java': `package p;\n\npublic class T {\n${TYPES.slice(0, n).map((t) => `    public static void run(${t} a) {\n    }\n`).join('\n')}}\n` })
    const caller = { 'p/Caller.java': 'package p;\n\npublic class Caller {\n    void go() {\n        T.run(1);\n    }\n}\n' }
    const call = async (n: number) => {
      const { dataDir } = await indexedRepo({ ...overloads(n), ...caller })
      return withSnapshot(dataDir, (db) => {
        const r = db.prepare("select a.id, a.resolution, a.detail from assertion a where a.type = 'calls' and a.origin = 'syntax' and json_extract(a.detail, '$.callee') = 'run'").get() as { id: string; resolution: string; detail: string }
        const cands = (db.prepare('select s.qualified_name as n from assertion_candidate c join symbol s on s.id = c.symbol_id where c.assertion_id = ? order by c.rank').all(r.id) as Array<{ n: string }>).map((c) => c.n)
        return { resolution: r.resolution, cands, detail: JSON.parse(r.detail) as Record<string, string> }
      })
    }
    const names = (n: number) => TYPES.slice(0, n).map((t) => `p.T.run(${t})`)
    const five = await call(5), seven = await call(7), two = await call(2), one = await call(1)
    expect(one).toMatchObject({ resolution: 'candidate', cands: ['p.T.run'] })
    expect(two).toMatchObject({ resolution: 'ambiguous', cands: names(2) })
    expect(five).toMatchObject({ resolution: 'ambiguous', cands: names(5) })
    expect(five.detail.more).toBeUndefined()
    expect(seven).toMatchObject({ resolution: 'ambiguous', cands: names(5), detail: { more: '2', rule: 'java_same_package' } })
  }, 240000)
})

describe('FR178 issue 16 scenario 6: workspace_status warns of a cycle among build modules that syntax-tier edges form', () => {
  const pom = (artifact: string, dep?: string) => `<?xml version="1.0"?>\n<project>\n  <modelVersion>4.0.0</modelVersion>\n  <groupId>g</groupId>\n  <artifactId>${artifact}</artifactId>\n  <version>1</version>\n${dep ? `  <dependencies>\n    <dependency>\n      <groupId>g</groupId>\n      <artifactId>${dep}</artifactId>\n      <version>1</version>\n    </dependency>\n  </dependencies>\n` : ''}</project>\n`
  const unit = (pkg: string, other: string) => `package ${pkg};\n\nimport ${other}.Peer;\n\npublic class Peer {\n    void go() {\n        new ${other}.Peer();\n    }\n}\n`

  it('FR178 scenario 6: the indexed fixture reports no module cycle', () => {
    const env = tool(constrainedIndex(), 'workspace_status')
    expect(env.data.module_cycles).toEqual([])
    expect(env.limitations.filter((l) => l.startsWith('Warning'))).toEqual([])
  }, 240000)

  it('FR178 scenario 6: two Maven modules that declare each other and bind names across both ways are reported, naming the cycle and the edges that form it', async () => {
    const { dataDir } = await indexedRepo({ 'a/pom.xml': pom('a', 'b'), 'b/pom.xml': pom('b', 'a'), 'a/src/main/java/a/Peer.java': unit('a', 'b'), 'b/src/main/java/b/Peer.java': unit('b', 'a') })
    const env = tool(dataDir, 'workspace_status')
    const cycles = env.data.module_cycles as Array<{ ecosystem: string; modules: string[]; edges: Array<{ from: string; to: string; type: string; path: string; line: number }> }>
    expect(cycles).toHaveLength(1)
    expect(cycles[0]).toMatchObject({ ecosystem: 'maven', modules: ['g:a', 'g:b'] })
    expect(cycles[0]!.edges.filter((e) => e.type === 'imports').map((e) => [e.from, e.to, e.path, e.line])).toEqual([['g:a', 'g:b', 'a/src/main/java/a/Peer.java', 3], ['g:b', 'g:a', 'b/src/main/java/b/Peer.java', 3]])
    expect(env.limitations.filter((l) => l.startsWith('Warning'))).toHaveLength(1)
    expect(env.limitations.find((l) => l.startsWith('Warning'))).toContain('maven forbids module cycles')
  }, 240000)

  it('FR178 one declared dependency and edges one way is no cycle', async () => {
    const { dataDir } = await indexedRepo({ 'a/pom.xml': pom('a', 'b'), 'b/pom.xml': pom('b'), 'a/src/main/java/a/Peer.java': unit('a', 'b'), 'b/src/main/java/b/Peer.java': 'package b;\n\npublic class Peer {\n}\n' })
    expect(tool(dataDir, 'workspace_status').data.module_cycles).toEqual([])
  }, 240000)
})

describe('FR171 issue 16 scenario 7: a candidate is read as inferred, and no edge is made of it', () => {
  it('FR171 FR177 scenario 7: get_relationships calls into lib/lib.go Format answers one row, svc/main.go, a candidate from the syntax tier carrying its rule and, by its resolution, the inferred basis (FR188)', () => {
    const d = constrainedIndex()
    const env = tool(d, 'get_relationships', { subject_id: symbolId(d, 'lib/lib:Format'), direction: 'in', types: ['calls'] })
    const rows = env.data.relationships as Array<{ resolution: string; origin: string; other: { path: string; qualified_name: string }; detail: Record<string, string> }>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ resolution: 'candidate', origin: 'syntax', other: { path: 'svc/main.go' }, basis: 'inferred', detail: { rule: 'go_package_member' } })
  }, 240000)

  it('FR171 every candidate and ambiguous row names its rule, which is what reads it as inferred (FR188); no resolved row of a name match does; and none of them is an edge', () => {
    withSnapshot(constrainedIndex(), (db) => {
      const open = (db.prepare("select id, resolution, detail from assertion where origin = 'syntax' and type in ('calls', 'inherits', 'implements', 'imports') and resolution in ('candidate', 'ambiguous')").all() as Array<{ id: string; resolution: string; detail: string }>)
      expect(open.length).toBeGreaterThan(10)
      for (const r of open) expect(JSON.parse(r.detail)).toMatchObject({ rule: expect.stringMatching(/^(go|java)_/) })
      expect((db.prepare("select count(*) as n from edge e join assertion a on a.id = e.assertion_id where a.resolution in ('candidate', 'ambiguous')").get() as { n: number }).n).toBe(0)
      // No syntax-tier import is a resolved edge: a Go package is a directory and an import links files, so its row lists the package's files (FR177).
      expect((db.prepare("select count(*) as n from assertion where type = 'imports' and resolution = 'resolved' and origin = 'syntax'").get() as { n: number }).n).toBe(0)
    })
  }, 240000)
})

describe('FR177 issue 16 edge cases: an import fixed by a declared path lists the files of its package, and one found by name is a candidate', () => {
  it('FR177 review 5: a Go import path inside a module of the repository names the package, not one arbitrary file: its candidates are the module symbols of every non-test file, a build-ignored file left out; a Java import by name is a candidate', () => {
    expect(actual('svc/main.go:3', 'example.com/lib')).toMatchObject({ resolution: 'ambiguous', rule: 'go_import_path', candidates: ['lib/lib@lib/lib.go', 'lib/use@lib/use.go'], detail: { package: 'lib', files: '2' } })
    expect(actual('lib/use.go:3', 'example.com/lib/internal/secret')).toMatchObject({ resolution: 'candidate', rule: 'go_import_path', candidates: ['lib/internal/secret/secret@lib/internal/secret/secret.go'] })
    expect(actual('java/b/src/main/java/b/Use.java:3', 'a.Util')).toMatchObject({ resolution: 'candidate', rule: 'java_import', candidates: ['a.Util@java/a/src/main/java/a/Util.java'] })
  }, 240000)

  it('FR177 an import of a path no module of the repository holds, or a type the repository does not declare, keeps its unresolved row, beside one name that is bound', async () => {
    const { dataDir } = await indexedRepo({ 'go.mod': 'module example.com/app\n\ngo 1.22\n', 'main.go': 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("x")\n\thelper()\n}\n\nfunc helper() {\n}\n', 'A.java': 'package p;\n\nimport java.util.List;\n\nclass A {\n    void f(List<String> l) {\n        l.size();\n        Math.max(1, 2);\n    }\n}\n' })
    withSnapshot(dataDir, (db) => {
      const rows = facts(db)
      expect(rows.map((r) => [r.type, r.name, r.resolution, r.reason])).toEqual(expect.arrayContaining([['imports', 'fmt', 'unresolved', 'outside_capability'], ['calls', 'Println', 'unresolved', 'outside_capability'], ['imports', 'java.util.List', 'unresolved', 'outside_capability'], ['calls', 'max', 'unresolved', 'outside_capability'], ['calls', 'size', 'unresolved', 'outside_capability']]))
      // The positive control: the one name the repository does declare is bound, and nothing else is.
      expect(rows.filter((r) => r.resolution !== 'unresolved').map((r) => [r.name, r.resolution, r.rule])).toEqual([['helper', 'candidate', 'go_same_package']])
    })
  }, 240000)
})

describe('FR180 an incremental index of the constrained languages equals a clean one', () => {
  it('FR180 changing one file and indexing again seals the same bindings as indexing the changed tree from nothing', () => {
    const repo = tmpDir('pm-c-')
    fs.cpSync(fixtureRepo('constrained'), repo, { recursive: true })
    const data = tmpDir(), clean = tmpDir()
    for (const args of [['init'], ['repo', 'add', repo], ['index', repo]]) expect(cli(['--data-dir', data, ...args]).status).toBe(0)
    // A file with no bearing on any binding changes, and one that adds a caller of an existing name.
    fs.appendFileSync(path.join(repo, 'svc', 'util.go'), '\nfunc another() string {\n\treturn helper()\n}\n')
    expect(cli(['--data-dir', data, 'index', repo]).status).toBe(0)
    for (const args of [['init'], ['repo', 'add', repo], ['index', repo]]) expect(cli(['--data-dir', clean, ...args]).status).toBe(0)
    const bound = (d: string) => withSnapshot(d, (db) => facts(db, () => true, wantedDetail(all())))
    const afterEdit = bound(data), fresh = bound(clean)
    expect(afterEdit).toEqual(fresh)
    expect(afterEdit.filter((f) => f.at.startsWith('svc/util.go') && f.name === 'helper')).toMatchObject([{ resolution: 'candidate', rule: 'go_same_package', candidates: ['svc/util:helper@svc/util.go'] }])
  }, 240000)
})

describe('FR179 languages.md states the rules, one row per rule the tier applies', () => {
  it('FR179 every rule the fixtures show is named in docs/proofmesh/languages.md, and so is the cap and the cycle warning', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'proofmesh', 'languages.md'), 'utf8')
    const rules = new Set(all().flatMap((f) => (f.rule ? [f.rule] : [])))
    expect(rules.size).toBe(8)
    for (const rule of rules) expect(doc, rule).toContain(`\`${rule}\``)
    expect(doc).toContain('`module_cycles`')
    expect(doc).toContain('`detail.more`')
  })
})

const B = (f: string) => `java/b/src/main/java/b/${f}`
describe('FR172 FR173 FR174 FR177 FR180 review of the first version: precision where a name could be hidden, inherited or out of reach', () => {
  it('FR174 review 1: a single-type import of a name the repository does not declare (java.util.List) hides the same-package b.List, so List.of() binds to nothing', () => {
    expect(actual(`${B('Lists.java')}:7`, 'of')).toMatchObject({ resolution: 'unresolved', reason: 'outside_capability' })
    expect(actual(`${B('Lists.java')}:7`, 'of')!.candidates).toBeUndefined()
    // The positive control: without that import the same-package type is the one named.
    expect(actual(`${B('Use.java')}:7`, 'Order')).toMatchObject({ resolution: 'candidate', rule: 'java_same_package' })
  }, 240000)

  it('FR174 review 2: overloads include the inherited methods of the name (B extends A, foo(int) and foo(String)), and an unknown supertype makes even one candidate ambiguous', () => {
    expect(actual(`${B('Derived.java')}:8`, 'foo')).toMatchObject({ resolution: 'ambiguous', rule: 'java_same_class', candidates: [`b.Derived.foo@${B('Derived.java')}`, `b.Base.foo@${B('Base.java')}`] })
    expect(actual(`${B('Ext.java')}:8`, 'bar')).toMatchObject({ resolution: 'ambiguous', candidates: [`b.Ext.bar@${B('Ext.java')}`] })
  }, 240000)

  it('FR174 review 3: a bare call past an unknown supertype does not fall through to a static import, which an inherited method would hide', () => {
    expect(actual(`${B('Stat.java')}:7`, 'format')).toMatchObject({ resolution: 'unresolved', reason: 'outside_capability' })
    // The positive control: the same import in a class with no unknown supertype binds.
    expect(actual(`${B('Stat2.java')}:7`, 'format')).toMatchObject({ resolution: 'candidate', rule: 'java_static_import' })
  }, 240000)

  it('FR177 review 5: a directory that holds a build-ignored package main beside the library still imports as the library, not as import_unresolved', () => {
    expect(fs.existsSync(path.join(fixtureRepo('constrained'), 'lib', 'gen.go'))).toBe(true)
    const row = actual('svc/main.go:3', 'example.com/lib')!
    expect(row.resolution).toBe('ambiguous')
    expect(row.candidates).toEqual(['lib/lib@lib/lib.go', 'lib/use@lib/use.go'])
  }, 240000)

  it('FR173 review 6: an internal package is importable only from the parent of internal, and vendor and testdata packages are never matched', () => {
    expect(actual('svc/internal_use.go:3', 'example.com/lib/internal/secret')).toMatchObject({ resolution: 'unresolved', reason: 'import_unresolved', detail: { visibility: 'internal' } })
    expect(actual('svc/internal_use.go:6', 'Hidden')).toMatchObject({ resolution: 'unresolved', reason: 'unknown_name', detail: { visibility: 'internal' } })
    // The positive control: the package that sits under the parent of internal imports it and binds.
    expect(actual('lib/use.go:6', 'Hidden')).toMatchObject({ resolution: 'candidate', rule: 'go_package_member' })
    for (const at of ['svc/ignored_use.go:4', 'svc/ignored_use.go:5']) expect(actual(at, at.endsWith('4') ? 'example.com/lib/testdata/fix' : 'example.com/lib/vendor/v')).toMatchObject({ resolution: 'unresolved', reason: 'outside_capability' })
    expect(actual('svc/ignored_use.go:9', 'Format')).toMatchObject({ resolution: 'unresolved', reason: 'outside_capability' })
  }, 240000)

  it('FR172 review 7: only a direct, compile-scope dependency makes names visible: a test-scope one reaches test sources and not main sources, a transitive one reaches none', () => {
    expect(actual('java/c/src/main/java/c/M.java:3', 'a.Util')).toMatchObject({ resolution: 'unresolved', reason: 'dependency_missing', detail: { undeclared: 'example:a' } })
    expect(actual('java/c/src/main/java/c/M.java:7', 'format')).toMatchObject({ resolution: 'unresolved', reason: 'dependency_missing' })
    expect(actual('java/c/src/test/java/c/T.java:3', 'a.Util')).toMatchObject({ resolution: 'candidate', rule: 'java_import' })
    expect(actual('java/d/src/main/java/d/D.java:3', 'a.Util')).toMatchObject({ resolution: 'unresolved', reason: 'dependency_missing' })
    // The positive control: b declares a compile-scope dependency on a.
    expect(actual(`${B('Use.java')}:3`, 'a.Util')).toMatchObject({ resolution: 'candidate', rule: 'java_import' })
  }, 240000)

  it('FR180 review 8: the rules\' version is bumped whenever the rules change: the hash of constrained/*.ts is kept beside it in resolution.lock.json', () => {
    const dir = path.join(ROOT, 'packages', 'proofmesh', 'src', 'indexer', 'constrained')
    const hash = createHash('sha256')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ts')).sort()) hash.update(`${f}\n${fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n')}\n`)
    const lock = JSON.parse(fs.readFileSync(path.join(dir, 'resolution.lock.json'), 'utf8')) as { version: number; sha256: string }
    expect(lock.version, 'resolution.lock.json names another version than RESOLUTION_VERSION').toBe(RESOLUTION_VERSION)
    expect(hash.digest('hex'), 'the rules changed: bump RESOLUTION_VERSION in constrained/index.ts, then set the new version and hash in resolution.lock.json').toBe(lock.sha256)
  })
})
