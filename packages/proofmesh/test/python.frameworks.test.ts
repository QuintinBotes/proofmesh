import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { beforeAll, describe, expect, it } from 'vitest'
import { evidenceSlice, expectedFor, fixtureRepo, indexedDataDir, tool, withSnapshot } from './helpers.js'

const byKey = <T>(key: (x: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
const qn = (db: Database.Database, id: string) => (db.prepare('select qualified_name from symbol where id = ?').get(id) as { qualified_name: string }).qualified_name
type Row = { id: string; source_id: string; target_id: string | null; resolution: string; reason: string | null; origin: string; detail: string | null }

/** The table facts of an indexed fixture, in the shapes its hand-written oracle uses. */
function tableFacts(dataDir: string) {
  return withSnapshot(dataDir, (db) => {
    const site = (assertionId: string) => {
      const evidenceId = (db.prepare('select evidence_id from assertion_evidence where assertion_id = ?').get(assertionId) as { evidence_id: string }).evidence_id
      return { line: (db.prepare('select start_line from evidence where id = ?').get(evidenceId) as { start_line: number }).start_line, site_text: evidenceSlice(dataDir, db, evidenceId) }
    }
    const of = (type: string) => db.prepare('select id, source_id, target_id, resolution, reason, origin, detail from assertion where type = ?').all(type) as Row[]
    const mapsTo = of('maps_to'), inherits = of('inherits')
    return {
      tables: db.prepare("select s.qualified_name, s.name, f.path, s.start_line as line from symbol s join file f on f.id = s.file_id where s.kind = 'table'").all(),
      variables: db.prepare("select qualified_name, start_line, end_line from symbol where kind = 'variable'").all(),
      origins: [...new Set(mapsTo.map((r) => r.origin))],
      maps_to: mapsTo.filter((r) => r.resolution === 'resolved').map((r) => ({ from: qn(db, r.source_id), to: qn(db, r.target_id!), rule: JSON.parse(r.detail!).rule, ...site(r.id) })),
      maps_to_unresolved: mapsTo.filter((r) => r.resolution === 'unresolved').map((r) => ({ from: qn(db, r.source_id), reason: r.reason, rule: JSON.parse(r.detail!).rule, ...site(r.id) })),
      inferred_maps_to: mapsTo.filter((r) => r.resolution === 'resolved' && JSON.parse(r.detail!).inferred).map((r) => qn(db, r.source_id)).sort(),
      inherits: inherits.map((r) => ({ from: qn(db, r.source_id), to: qn(db, r.target_id!), ...site(r.id) })),
      total: mapsTo.length,
    }
  })
}

const reachOf = (dataDir: string, table: string) => {
  const r = tool(dataDir, 'get_table_reach', { table }) as unknown as { data: { tables: Array<{ qualified_name: string; path: string; entities: Array<{ qualified_name: string; via: string }>; reach: Array<{ kind: string; qualified_name: string; path: string; depth: number }> }> }; limitations: string[] }
  return { limitations: r.limitations, tables: r.data.tables.map((t) => ({ table: t.qualified_name, path: t.path, entities: t.entities.map((e) => [e.qualified_name, e.via]), reach: t.reach.map(({ kind, qualified_name, path, depth }) => ({ kind, qualified_name, path, depth })) })) }
}
const impactOf = (dataDir: string, table: string) => {
  const id = withSnapshot(dataDir, (db) => (db.prepare("select id from symbol where kind = 'table' and qualified_name = ?").get(table) as { id: string }).id)
  return ((tool(dataDir, 'analyze_impact', { subject_ids: [id] }).data as { dependents: Array<{ qualified_name: string; depth: number }> }).dependents).map((d) => [d.qualified_name, d.depth])
}

for (const [fixture, title] of [
  ['py-sqlalchemy', 'A9 SQLAlchemy entity-to-table rules on fixtures/py-sqlalchemy: __tablename__, Table(...) assigned to a name, __table__, single-table inheritance, reached from a FastAPI router and a Celery task'],
  ['py-django', 'A9 Django entity-to-table rules on fixtures/py-django: Meta.db_table, the app-label convention, abstract and proxy models, reached from Django URLconfs, with django not installed'],
] as const) {
  describe(title, () => {
    const EXPECTED = expectedFor(fixture)
    let dataDir: string
    beforeAll(async () => { ({ dataDir } = await indexedDataDir(fixtureRepo(fixture))) }, 240000)

    it('A9 tables are framework symbols, one per name, declared at their first mapping, and every mapping equals the hand-written oracle', () => {
      const facts = tableFacts(dataDir)
      const order = byKey((m: any) => `${m.from}|${m.line}`)
      expect(facts.tables.sort(byKey((t: any) => t.qualified_name))).toEqual([...EXPECTED.tables].sort(byKey((t: any) => t.qualified_name)))
      expect(facts.variables).toEqual(EXPECTED.variables)
      expect(facts.origins).toEqual(['framework_adapter'])
      expect(facts.maps_to.sort(order)).toEqual([...EXPECTED.maps_to].sort(order))
      expect(facts.maps_to_unresolved.sort(order)).toEqual([...EXPECTED.maps_to_unresolved].sort(order))
      expect(facts.total).toBe(EXPECTED.maps_to.length + EXPECTED.maps_to_unresolved.length)
      // A table name the rules infer rather than read says so.
      expect(facts.inferred_maps_to).toEqual(EXPECTED.inferred_maps_to)
      expect(facts.inherits.sort(order)).toEqual([...EXPECTED.inherits].sort(order))
    })

    it('A9 get_table_reach on a Python repository lists each table\'s entities, subtypes through inherits, and the endpoints and jobs whose resolved calls reach it at their shortest depth, labelled static reach; the impact search from a table reaches the functions that build its entities and the routes and tasks that call them', () => {
      for (const e of EXPECTED.table_reach) {
        const r = reachOf(dataDir, e.table)
        expect(r.tables).toEqual([e])
        expect(r.limitations).toContain('static reach, not load')
      }
      for (const [table, dependents] of Object.entries(EXPECTED.impact)) expect(impactOf(dataDir, table)).toEqual(dependents)
    })
  })
}

type Fact = { type: string; from: string; to?: string; reason?: string | null; detail: Record<string, string>; line: number; site_text: string }

describe('A9 A7 Python entry points on fixtures/py-routes: FastAPI and Flask routes, Django URLconfs and Celery tasks, with none of the four installed', () => {
  const EXPECTED = expectedFor('py-routes') as { symbols: Array<{ kind: string; qualified_name: string }>; relationships: Fact[] }
  let dataDir: string
  beforeAll(async () => { ({ dataDir } = await indexedDataDir(fixtureRepo('py-routes'))) }, 240000)

  it('A9 A7 each FastAPI, Flask and Django route is an endpoint named VERB path and each Celery task a job, declared at its route or decorator, as the hand-written oracle says', () => {
    const order = byKey((s: { kind: string; qualified_name: string }) => `${s.kind} ${s.qualified_name}`)
    const rows = withSnapshot(dataDir, (db) => db.prepare("select s.kind, s.qualified_name, s.name, f.path, s.start_line as line from symbol s join file f on f.id = s.file_id where s.kind in ('endpoint', 'job')").all() as Array<{ kind: string; qualified_name: string }>)
    expect(rows.sort(order)).toEqual([...EXPECTED.symbols].sort(order))
  })

  it('A9 A7 exposes and runs facts equal the oracle: FastAPI, Flask and Django prefixes compose across files, a router nothing mounts says so, decoys yield nothing, and a route, method list or URLconf the rules cannot read stays unresolved on its handler', () => {
    const facts = withSnapshot(dataDir, (db) => {
      const ref = (id: string) => { const s = db.prepare('select kind, qualified_name from symbol where id = ?').get(id) as { kind: string; qualified_name: string }; return `${s.kind} ${s.qualified_name}` }
      const rows = db.prepare("select a.type, a.source_id, a.target_id, a.resolution, a.reason, a.detail, ae.evidence_id from assertion a join assertion_evidence ae on ae.assertion_id = a.id where a.origin = 'framework_adapter' and a.type in ('exposes', 'runs')").all() as Array<Row & { type: string; evidence_id: string }>
      return rows.map((r): Fact => ({
        type: r.type, from: ref(r.source_id), ...(r.resolution === 'resolved' ? { to: ref(r.target_id!) } : { reason: r.reason }), detail: JSON.parse(r.detail!),
        line: (db.prepare('select start_line from evidence where id = ?').get(r.evidence_id) as { start_line: number }).start_line, site_text: evidenceSlice(dataDir, db, r.evidence_id),
      }))
    })
    const order = byKey((f: Fact) => JSON.stringify([f.type, f.from, f.to ?? '', f.line]))
    expect(facts.sort(order)).toEqual([...EXPECTED.relationships].sort(order))
    // A decorated route declares what the service serves; it is never an outbound call.
    expect(withSnapshot(dataDir, (db) => db.prepare("select count(*) as n from assertion where type = 'dispatches_to'").get())).toEqual({ n: 0 })
  })
})

describe('A8 A25 Pulumi rules: a resource graph from Python, named as the TypeScript rules name it', () => {
  const EXPECTED = expectedFor('py-pulumi')
  it('A8 each resource a Python program constructs is a symbol named by its type and name, related to the resources it reads and depends on, with no package installed', async () => {
    const { dataDir: d } = await indexedDataDir(fixtureRepo('py-pulumi'))
    expect(withSnapshot(d, (db) => db.prepare(`select qualified_name, name, signature, start_line, end_line from symbol where kind = 'resource' order by qualified_name`).all())).toEqual(EXPECTED.resources)
    const facts = withSnapshot(d, (db) => db.prepare(`
      select a.type, s.qualified_name as src, t.qualified_name as dst, ev.start_line as line, ev.start_byte as start, ev.end_byte as end, f.path
      from assertion a join symbol s on s.id = a.source_id join symbol t on t.id = a.target_id
      join assertion_evidence ae on ae.assertion_id = a.id join evidence ev on ev.id = ae.evidence_id join file f on f.id = ev.file_id
      where a.origin = 'framework_adapter' and a.type in ('references', 'depends_on') order by f.path, ev.start_byte`).all() as Array<{ type: string; src: string; dst: string; line: number; start: number; end: number; path: string }>)
    const text = fs.readFileSync(path.join(fixtureRepo('py-pulumi'), '__main__.py'), 'utf8')
    expect(facts.map((r) => [r.line, r.type, r.src, r.dst, Buffer.from(text).subarray(r.start, r.end).toString()])).toEqual(EXPECTED.relationships)
    expect(new Set(facts.map((r) => r.path))).toEqual(new Set(['__main__.py']))
    expect(withSnapshot(d, (db) => db.prepare(`select path, json_extract(capabilities, '$.references') as refs from file where language = 'python' order by path`).all())).toEqual(EXPECTED.references_capability)
  }, 240000)
})
