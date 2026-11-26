import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { compare } from '../src/query/compare.js'
import { runTool } from '../src/query/tools.js'
import { indexedRepo, ROOT, withSnapshot } from './helpers.js'

// Review of issue 70: ordering reads a page without sorting every row, labels a reached member by its overrides edge, and breaks ties by position.
const rows = (dataDir: string, tool: string, input: Record<string, unknown>): string[] => runTool(dataDir, tool, { ...input, envelope: 'lean' }).text!.split('\n').slice(1).filter((l) => !l.startsWith('# '))

describe('FR235 a page of relationships is read in site order from an index, without sorting the rows of the hub', () => {
  const CALLERS = 3000
  const MAX_ROWS = 20
  const prepare = Database.prototype.prepare
  const fn = Database.prototype.function
  afterEach(() => { Database.prototype.prepare = prepare; Database.prototype.function = fn })

  it('FR235 a hub of three thousand callers: the page query uses the site index with no temp b-tree, and examines about a page of rows', async () => {
    const callers = Array.from({ length: CALLERS }, (_, i) => `export function c${i}(): void { target() }`).join('\n')
    const { dataDir } = await indexedRepo({ 'src/hub.ts': 'export function target(): number { return 1 }\n', 'src/callers.ts': `import { target } from './hub'\n${callers}\n` })
    const target = (runTool(dataDir, 'find_symbols', { text: 'target', envelope: 'full' }).data.symbols as Array<{ id: string; name: string }>).find((s) => s.name === 'target')!.id

    const sql: string[] = []
    let paging = false, examined = 0
    Database.prototype.prepare = function (this: Database.Database, source: string) {
      const st = (prepare as (this: Database.Database, s: string) => Database.Statement).call(this, source)
      if (/_path/.test(source) && /limit \?/.test(source)) {
        sql.push(source)
        const all = st.all.bind(st)
        st.all = ((...args: unknown[]) => { paging = true; try { return all(...args) } finally { paging = false } }) as typeof st.all
      }
      return st
    } as typeof prepare
    Database.prototype.function = function (this: Database.Database, name: string, ...rest: unknown[]) {
      const last = rest.length - 1, f = rest[last] as (...a: unknown[]) => unknown
      if (name === 'pm_is_test') rest[last] = (...a: unknown[]) => { if (paging) examined++; return f(...a) }
      return (fn as (...a: unknown[]) => unknown).call(this, name, ...rest)
    } as typeof fn

    const answer = rows(dataDir, 'get_relationships', { subject_id: target, direction: 'in', types: ['calls'], include_tests: false, limits: { max_rows: MAX_ROWS } })
    expect(answer.map((r) => r.split(' ')[0])).toEqual(Array.from({ length: MAX_ROWS }, (_, i) => `c${i}`))
    // The rows examined are counted, not timed: a read that sorted the hub would examine every one of its callers.
    expect(examined, 'rows examined by the page queries').toBeLessThanOrEqual(MAX_ROWS * 3)

    const plans = (withSnapshot(dataDir, (db) => (fn as (...a: unknown[]) => unknown).call(db, 'pm_is_test', { varargs: true }, () => 0) && sql.filter((s) => /assertion_by_(target|source)_site|candidate_by_site/.test(s)).map((s) => (db.prepare(`explain query plan ${s}`).all(...Array.from({ length: (s.match(/\?/g) ?? []).length }, () => 1)) as Array<{ detail: string }>).map((r) => r.detail)))) as unknown as string[][]
    expect(plans.length, 'the page queries that name a site index').toBeGreaterThan(0)
    for (const plan of plans) {
      expect(plan.join('\n')).not.toMatch(/TEMP B-TREE/)
      expect(plan.join('\n')).toMatch(/USING (COVERING )?INDEX (assertion_by_(target|source)_site|candidate_by_site)/)
    }
  }, 600000)
})

describe('FR236 a member reached through its class and by its overrides edge is labelled overrides, whatever the order', () => {
  it('FR236 impact of a base class lists each subclass member as overrides, not dispatch', async () => {
    const { dataDir } = await indexedRepo({ 'shapes.py': 'class Shape:\n    def area(self):\n        return 0\n\n\nclass Circle(Shape):\n    def area(self):\n        return 1\n\n\nclass Square(Shape):\n    def area(self):\n        return 2\n' })
    const shape = (runTool(dataDir, 'find_symbols', { text: 'Shape', kinds: ['class'], envelope: 'full' }).data.symbols as Array<{ id: string; name: string }>).find((s) => s.name === 'Shape')!.id
    const impact = rows(dataDir, 'analyze_impact', { subject_ids: [shape], types: ['calls', 'inherits', 'overrides'], limits: { max_depth: 3 } })
    expect(impact.filter((r) => /^(Circle|Square)\.area /.test(r)).map((r) => r.replace(/ shapes\.py:\d+/, ''))).toEqual(['Circle.area depth=1 overrides', 'Square.area depth=1 overrides'])
  }, 120000)
})

describe('FR237 two partial declarations on one line are told apart by position, so compare_snapshots is the same in every checkout', () => {
  const snapshot = (ids: [string, string], changedSecond: boolean) => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = off')
    db.exec(fs.readFileSync(path.join(ROOT, 'schemas', 'snapshot-format', '0.10.sql'), 'utf8'))
    db.prepare("insert into file (id, path, content_hash, size, language, disposition, capabilities) values ('f', 'P.cs', 'h', 100, 'csharp', 'indexed', '{}')").run()
    const insert = db.prepare("insert into symbol (id, file_id, kind, name, qualified_name, start_byte, end_byte, start_line, end_line, signature, stable_key, evidence_id) values (?, 'f', 'class', 'A', 'N.A', ?, ?, 1, 1, ?, ?, 'ev')")
    insert.run(ids[0], 0, 30, 'partial class A first', 'P.cs#N.A#class')
    insert.run(ids[1], 40, 70, changedSecond ? 'partial class A second, edited' : 'partial class A second', 'P.cs#N.A#class.2')
    return db
  }
  const changed = (ids: [string, string]) => (compare(snapshot(ids, false), snapshot(ids, true), { base: { id: 'snap_b', published_at: 'x' }, head: { id: 'snap_h', published_at: 'x' } }, 100).data.symbols.changed as Array<{ signature: string }>).map((c) => c.signature)

  it('FR237 the edited second declaration is reported whichever order their ids sort in', () => {
    expect(changed(['sym_a', 'sym_b'])).toEqual(['partial class A second, edited'])
    expect(changed(['sym_b', 'sym_a'])).toEqual(['partial class A second, edited'])
  })
})

describe('FR238 tests on one line are listed by position, and a page boundary falls between them in that order', () => {
  it('FR238 the test that comes first in the file is first, and a page of one holds it', async () => {
    const { dataDir } = await indexedRepo({
      'src/lib.ts': 'export function target(): number { return 1 }\n',
      'src/lib.test.ts': "import { target } from './lib'\nexport function zeta() { target() } export function alpha() { target() }\n",
    })
    const target = (runTool(dataDir, 'find_symbols', { text: 'target', envelope: 'full' }).data.symbols as Array<{ id: string; name: string }>).find((s) => s.name === 'target')!.id
    const names = (limits: Record<string, number>) => rows(dataDir, 'find_tests', { subject_ids: [target], limits }).map((r) => r.split(' ')[0])
    expect(names({ max_rows: 100 })).toEqual(['zeta', 'alpha'])
    expect(names({ max_rows: 1 })).toEqual(['zeta'])
  }, 120000)
})
