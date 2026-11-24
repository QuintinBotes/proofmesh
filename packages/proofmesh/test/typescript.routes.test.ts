import type Database from 'better-sqlite3'
import { beforeAll, describe, expect, it } from 'vitest'
import { evidenceSlice, expectedFor, fixtureRepo, indexedDataDir, withSnapshot } from './helpers.js'

const EXPECTED = expectedFor('ts-routes')
const byKey = <T>(key: (x: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
const qn = (db: Database.Database, id: string) => (db.prepare('select qualified_name from symbol where id = ?').get(id) as { qualified_name: string }).qualified_name

describe('A7 A9 inbound HTTP endpoints from Express and NestJS on fixtures/ts-routes, with the C# rules\' fact shapes', () => {
  let dataDir: string
  beforeAll(async () => {
    ;({ dataDir } = await indexedDataDir(fixtureRepo('ts-routes')))
  }, 180000)
  const site = (db: Database.Database, assertionId: string) => {
    const evidenceId = (db.prepare('select evidence_id from assertion_evidence where assertion_id = ?').get(assertionId) as { evidence_id: string }).evidence_id
    return { line: (db.prepare('select start_line from evidence where id = ?').get(evidenceId) as { start_line: number }).start_line, site_text: evidenceSlice(dataDir, db, evidenceId) }
  }
  type Row = { id: string; source_id: string; target_id: string | null; resolution: string; reason: string | null; origin: string; detail: string }
  const exposes = (db: Database.Database) => db.prepare("select id, source_id, target_id, resolution, reason, origin, detail from assertion where type = 'exposes'").all() as Row[]

  it('A7 Express routes under their mounted routers and NestJS controller actions are endpoint symbols named by verb and path, :param written {param}, declared where the route is registered; decoys declare none', () => {
    withSnapshot(dataDir, (db) => {
      const rows = db.prepare("select s.qualified_name, f.path, s.start_line as line from symbol s join file f on f.id = s.file_id where s.kind = 'endpoint' order by s.qualified_name").all()
      expect(rows).toEqual(EXPECTED.endpoints)
    })
  })

  it('A7 each Express route exposes its named, inline or registering handler and each NestJS action its method, as framework facts', () => {
    withSnapshot(dataDir, (db) => {
      const rows = exposes(db).filter((r) => r.resolution === 'resolved')
      expect(new Set(rows.map((r) => r.origin))).toEqual(new Set(['framework_adapter']))
      const order = byKey((r: { from: string }) => r.from)
      expect(rows.map((r) => ({ from: qn(db, r.source_id), to: qn(db, r.target_id!), rule: JSON.parse(r.detail).rule, ...site(db, r.id) })).sort(order)).toEqual(EXPECTED.exposes)
    })
  })

  it('A7 an Express path built from a variable, a router under a variable prefix or mounted by nothing, and a NestJS path held in a constant stay unresolved with the reason', () => {
    withSnapshot(dataDir, (db) => {
      const rows = exposes(db).filter((r) => r.resolution !== 'resolved')
      const order = byKey((r: { from: string }) => r.from)
      expect(rows.map((r) => ({ from: qn(db, r.source_id), reason: r.reason, rule: JSON.parse(r.detail).rule, why: JSON.parse(r.detail).why, ...site(db, r.id) })).sort(order)).toEqual(EXPECTED.exposes_unresolved)
    })
  })

  it('A7 an inline Express handler is a function symbol named after its registration; get calls on objects that are not Express make none', () => {
    withSnapshot(dataDir, (db) => {
      const rows = db.prepare("select s.qualified_name, f.path, s.start_line as line from symbol s join file f on f.id = s.file_id where s.kind = 'function' and s.qualified_name like '%(%' order by s.qualified_name").all()
      expect(rows).toEqual(EXPECTED.inline_handlers)
    })
  })
})
