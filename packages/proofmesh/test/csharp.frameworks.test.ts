import type Database from 'better-sqlite3'
import { beforeAll, describe, expect, it } from 'vitest'
import { evidenceSlice, expectedFor, fixtureRepo, indexedDataDir, withSnapshot } from './helpers.js'

const EXPECTED = expectedFor('cs-ef')
const byKey = <T>(key: (x: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
const qn = (db: Database.Database, id: string) => (db.prepare('select qualified_name from symbol where id = ?').get(id) as { qualified_name: string }).qualified_name

describe('built-in Entity Framework rules on fixtures/cs-ef', () => {
  let dataDir: string
  beforeAll(async () => {
    ;({ dataDir } = await indexedDataDir(fixtureRepo('cs-ef')))
  })
  const site = (db: Database.Database, assertionId: string) => {
    const evidenceId = (db.prepare('select evidence_id from assertion_evidence where assertion_id = ?').get(assertionId) as { evidence_id: string }).evidence_id
    return { line: (db.prepare('select start_line from evidence where id = ?').get(evidenceId) as { start_line: number }).start_line, site_text: evidenceSlice(dataDir, db, evidenceId) }
  }

  it('FR016 tables are framework symbols, one per name, declared at their first mapping', () => {
    withSnapshot(dataDir, (db) => {
      const rows = db.prepare("select s.qualified_name, s.name, f.path, s.start_line as line from symbol s join file f on f.id = s.file_id where s.kind = 'table'").all()
      expect(rows.sort(byKey((t: any) => t.qualified_name))).toEqual([...EXPECTED.tables].sort(byKey((t: any) => t.qualified_name)))
    })
  })

  it('FR016 entity-to-table mappings equal the oracle: explicit mappings win, each cites its rule and site', () => {
    withSnapshot(dataDir, (db) => {
      const rows = db.prepare("select id, source_id, target_id, resolution, reason, origin, detail from assertion where type = 'maps_to'").all() as Array<{ id: string; source_id: string; target_id: string | null; resolution: string; reason: string | null; origin: string; detail: string }>
      expect(new Set(rows.map((r) => r.origin))).toEqual(new Set(['framework_adapter']))
      const resolved = rows.filter((r) => r.resolution === 'resolved').map((r) => ({ from: qn(db, r.source_id), to: qn(db, r.target_id!), rule: JSON.parse(r.detail).rule, ...site(db, r.id) }))
      const unresolved = rows.filter((r) => r.resolution === 'unresolved').map((r) => ({ from: qn(db, r.source_id), reason: r.reason, rule: JSON.parse(r.detail).rule, ...site(db, r.id) }))
      const order = byKey((m: any) => m.from)
      expect(resolved.sort(order)).toEqual([...EXPECTED.maps_to].sort(order))
      expect(unresolved.sort(order)).toEqual([...EXPECTED.maps_to_unresolved].sort(order))
      expect(rows).toHaveLength(EXPECTED.maps_to.length + EXPECTED.maps_to_unresolved.length)
      // A table name the rules infer rather than read says so.
      expect(rows.filter((r) => r.resolution === 'resolved' && JSON.parse(r.detail).inferred).map((r) => qn(db, r.source_id)).sort()).toEqual(EXPECTED.inferred_maps_to)
    })
  })
})
