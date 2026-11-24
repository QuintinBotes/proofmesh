import type Database from 'better-sqlite3'
import { beforeAll, describe, expect, it } from 'vitest'
import { evidenceSlice, expectedFor, fixtureRepo, indexedDataDir, tool, withSnapshot } from './helpers.js'

const EXPECTED = expectedFor('ts-typeorm')
const byKey = <T>(key: (x: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
const qn = (db: Database.Database, id: string) => (db.prepare('select qualified_name from symbol where id = ?').get(id) as { qualified_name: string }).qualified_name

describe('A9 TypeORM entity-to-table rules on fixtures/ts-typeorm', () => {
  let dataDir: string
  beforeAll(async () => {
    ;({ dataDir } = await indexedDataDir(fixtureRepo('ts-typeorm')))
  }, 180000)
  const site = (db: Database.Database, assertionId: string) => {
    const evidenceId = (db.prepare('select evidence_id from assertion_evidence where assertion_id = ?').get(assertionId) as { evidence_id: string }).evidence_id
    return { line: (db.prepare('select start_line from evidence where id = ?').get(evidenceId) as { start_line: number }).start_line, site_text: evidenceSlice(dataDir, db, evidenceId) }
  }
  type Row = { id: string; source_id: string; target_id: string | null; resolution: string; reason: string | null; origin: string; detail: string }
  const facts = (db: Database.Database, type: string) => db.prepare('select id, source_id, target_id, resolution, reason, origin, detail from assertion where type = ?').all(type) as Row[]

  it('A9 each table is a framework symbol, one per name, declared at its first mapping in path order', () => {
    withSnapshot(dataDir, (db) => {
      const rows = db.prepare("select s.qualified_name, s.name, f.path, s.start_line as line from symbol s join file f on f.id = s.file_id where s.kind = 'table'").all()
      expect(rows.sort(byKey((t: any) => t.qualified_name))).toEqual([...EXPECTED.tables].sort(byKey((t: any) => t.qualified_name)))
    })
  })

  it('A9 @Entity() maps its class to the convention table, marked inferred; a named or schema-qualified @Entity maps to that table; a decoy decorator maps nothing', () => {
    withSnapshot(dataDir, (db) => {
      const rows = facts(db, 'maps_to')
      expect(new Set(rows.map((r) => r.origin))).toEqual(new Set(['framework_adapter']))
      const order = byKey((m: any) => m.from)
      expect(rows.filter((r) => r.resolution === 'resolved').map((r) => ({ from: qn(db, r.source_id), to: qn(db, r.target_id!), rule: JSON.parse(r.detail).rule, ...site(db, r.id) })).sort(order)).toEqual([...EXPECTED.maps_to].sort(order))
      expect(rows.filter((r) => r.resolution === 'unresolved').map((r) => ({ from: qn(db, r.source_id), reason: r.reason, rule: JSON.parse(r.detail).rule, ...site(db, r.id) })).sort(order)).toEqual([...EXPECTED.maps_to_unresolved].sort(order))
      expect(rows).toHaveLength(EXPECTED.maps_to.length + EXPECTED.maps_to_unresolved.length)
      expect(rows.filter((r) => r.resolution === 'resolved' && JSON.parse(r.detail).inferred).map((r) => qn(db, r.source_id)).sort()).toEqual(EXPECTED.inferred_maps_to)
    })
  })

  it('A9 a @ChildEntity() inherits its parent, so it shares the parent table', () => {
    withSnapshot(dataDir, (db) => {
      // The extends clause is also a language-level inherits (FR085); this is the rule's own fact.
      const rows = facts(db, 'inherits').filter((r) => r.origin === 'framework_adapter')
      expect(rows.map((r) => ({ from: qn(db, r.source_id), to: qn(db, r.target_id!), rule: JSON.parse(r.detail).rule, ...site(db, r.id) }))).toEqual(EXPECTED.inherits)
    })
  })

  it('A9 get_table_reach lists each table with the entities mapped to it, the child entities that share it, and the Express and NestJS endpoints whose calls construct them', () => {
    for (const [table, entities] of Object.entries(EXPECTED.table_entities as Record<string, string[][]>)) {
      const r = tool(dataDir, 'get_table_reach', { table }).data as { tables: Array<{ qualified_name: string; entities: Array<{ qualified_name: string; via: string }>; reach: Array<{ kind: string; qualified_name: string; path: string; depth: number }> }> }
      expect(r.tables.map((t) => [t.qualified_name, t.entities.map((e) => [e.qualified_name, e.via]), t.reach.map(({ kind, qualified_name, path, depth }) => ({ kind, qualified_name, path, depth }))])).toEqual([[table, entities, EXPECTED.table_reach[table]]])
    }
  })
})
