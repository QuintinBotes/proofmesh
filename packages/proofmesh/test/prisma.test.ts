import type Database from 'better-sqlite3'
import { beforeAll, describe, expect, it } from 'vitest'
import { runKit } from '../src/conformance/kit.js'
import { BUILT_IN } from '../src/indexer/languages.js'
import { evidenceSlice, expectedFor, fixtureRepo, indexedDataDir, tool, withSnapshot } from './helpers.js'

const EXPECTED = expectedFor('prisma-schema')
const byKey = <T>(key: (x: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
const qn = (db: Database.Database, id: string) => (db.prepare('select qualified_name from symbol where id = ?').get(id) as { qualified_name: string }).qualified_name

describe('A9 Prisma schemas: models and views mapped to their tables, with the Entity Framework rule\'s fact shapes', () => {
  let dataDir: string
  beforeAll(async () => {
    ;({ dataDir } = await indexedDataDir(fixtureRepo('prisma-schema')))
  }, 180000)
  const site = (db: Database.Database, assertionId: string) => {
    const evidenceId = (db.prepare('select evidence_id from assertion_evidence where assertion_id = ?').get(assertionId) as { evidence_id: string }).evidence_id
    return { line: (db.prepare('select start_line from evidence where id = ?').get(evidenceId) as { start_line: number }).start_line, site_text: evidenceSlice(dataDir, db, evidenceId) }
  }

  it('A9 SC014 the syntax tier passes the conformance kit on Prisma schemas, with hand-written expected symbols', async () => {
    const b = BUILT_IN.find((x) => x.id === 'syntax')!
    const r = await runKit({ id: 'syntax', entry: b.entry()!, extensions: b.extensions, configNames: [] }, fixtureRepo('prisma-schema'), EXPECTED)
    expect(r.checks.filter((c) => !c.passed).map((c) => `${c.id}: ${c.detail}`)).toEqual([])
    expect(r.checks.map((c) => c.id)).toContain('golden.symbols')
  }, 240000)

  it('A9 tables are symbols declared at their first mapping, named by @@map or the model, in the schema @@schema names', () => {
    withSnapshot(dataDir, (db) => {
      const rows = db.prepare("select s.qualified_name, s.name, f.path, s.start_line as line from symbol s join file f on f.id = s.file_id where s.kind = 'table'").all()
      expect(rows.sort(byKey((t: any) => t.qualified_name))).toEqual([...EXPECTED.tables].sort(byKey((t: any) => t.qualified_name)))
    })
  })

  it('A9 each model maps_to its table: prisma_map where @@map names it, else prisma_convention, marked inferred', () => {
    withSnapshot(dataDir, (db) => {
      const rows = db.prepare("select id, source_id, target_id, resolution, origin, detail from assertion where type = 'maps_to'").all() as Array<{ id: string; source_id: string; target_id: string; resolution: string; origin: string; detail: string }>
      expect(new Set(rows.map((r) => `${r.origin} ${r.resolution}`))).toEqual(new Set(['framework_adapter resolved']))
      const order = byKey((m: any) => m.from)
      expect(rows.map((r) => ({ from: qn(db, r.source_id), to: qn(db, r.target_id), rule: JSON.parse(r.detail).rule, ...site(db, r.id) })).sort(order)).toEqual([...EXPECTED.maps_to].sort(order))
      expect(rows.filter((r) => JSON.parse(r.detail).inferred).map((r) => qn(db, r.source_id)).sort()).toEqual([...EXPECTED.inferred_maps_to].sort())
    })
  })

  it('A9 a relation between models is a reference; one to a model another file declares is unresolved', () => {
    withSnapshot(dataDir, (db) => {
      const rows = db.prepare("select id, source_id, target_id, resolution, reason, detail from assertion where type = 'references' and origin = 'framework_adapter'").all() as Array<{ id: string; source_id: string; target_id: string | null; resolution: string; reason: string | null; detail: string }>
      expect(rows.every((r) => JSON.parse(r.detail).rule === 'prisma_relation')).toBe(true)
      const order = byKey((m: any) => `${m.from} ${m.field}`)
      expect(rows.filter((r) => r.resolution === 'resolved').map((r) => ({ from: qn(db, r.source_id), to: qn(db, r.target_id!), field: JSON.parse(r.detail).field, ...site(db, r.id) })).sort(order)).toEqual([...EXPECTED.references].sort(order))
      expect(rows.filter((r) => r.resolution !== 'resolved').map((r) => ({ from: qn(db, r.source_id), reason: r.reason, field: JSON.parse(r.detail).field, name: JSON.parse(r.detail).name, ...site(db, r.id) }))).toEqual(EXPECTED.references_unresolved)
    })
  })

  it('A9 get_table_reach finds a Prisma table by its name or its schema-qualified name, with the model mapped to it', () => {
    for (const e of EXPECTED.table_reach) {
      const r = tool(dataDir, 'get_table_reach', { table: e.table }) as unknown as { data: { tables: Array<{ qualified_name: string; path: string; entities: Array<{ qualified_name: string; via: string }>; reach: unknown[] }> }; limitations: string[] }
      expect(r.data.tables.map((t) => ({ qualified_name: t.qualified_name, path: t.path, entities: t.entities.map((x) => x.qualified_name), reach: t.reach }))).toEqual(e.tables)
      expect(r.limitations).toContain('static reach, not load')
    }
  })
})

describe('A9 A36 Prisma Client model accesses in TypeScript reference their tables, which join the schema\'s tables by name', () => {
  const TS = expectedFor('ts-prisma')
  let dataDir: string
  beforeAll(async () => {
    ;({ dataDir } = await indexedDataDir(fixtureRepo('ts-prisma')))
  }, 180000)
  const site = (db: Database.Database, assertionId: string) => {
    const evidenceId = (db.prepare('select evidence_id from assertion_evidence where assertion_id = ?').get(assertionId) as { evidence_id: string }).evidence_id
    return { line: (db.prepare('select start_line from evidence where id = ?').get(evidenceId) as { start_line: number }).start_line, site_text: evidenceSlice(dataDir, db, evidenceId) }
  }
  const pathOf = (db: Database.Database, id: string) => (db.prepare('select f.path from symbol s join file f on f.id = s.file_id where s.id = ?').get(id) as { path: string }).path

  it('A9 A36 the TypeScript adapter declares each table at its first model access in path order, named as the schema maps it, beside the schema\'s own', () => {
    withSnapshot(dataDir, (db) => {
      const rows = db.prepare("select s.qualified_name, s.name, f.path, s.start_line as line from symbol s join file f on f.id = s.file_id where s.kind = 'table'").all()
      const order = byKey((t: any) => `${t.path} ${String(t.line).padStart(4, '0')}`)
      expect(rows.sort(order)).toEqual([...TS.tables].sort(order))
    })
  })

  it('A9 A36 a model access references its table from the enclosing function or method; an accessor naming no model is unresolved; lookalike clients reference nothing', () => {
    withSnapshot(dataDir, (db) => {
      const rows = (db.prepare("select id, source_id, target_id, resolution, reason, origin, detail from assertion where type = 'references'").all() as Array<{ id: string; source_id: string; target_id: string | null; resolution: string; reason: string | null; origin: string; detail: string }>)
        .filter((r) => JSON.parse(r.detail).rule === 'prisma_client')
      expect(new Set(rows.map((r) => r.origin))).toEqual(new Set(['framework_adapter']))
      const order = byKey((m: any) => m.from)
      const detail = (r: { detail: string }) => { const d = JSON.parse(r.detail); return { accessor: d.accessor, operation: d.operation } }
      expect(rows.filter((r) => r.resolution === 'resolved').map((r) => ({ from: qn(db, r.source_id), to: qn(db, r.target_id!), to_path: pathOf(db, r.target_id!), ...detail(r), ...site(db, r.id) })).sort(order)).toEqual([...TS.references].sort(order))
      expect(rows.filter((r) => r.resolution !== 'resolved').map((r) => ({ from: qn(db, r.source_id), reason: r.reason, ...detail(r), ...site(db, r.id) }))).toEqual(TS.references_unresolved)
    })
  })

  it('A9 A36 get_table_reach on a Prisma table reports one table: the model from the syntax tier, both declarations, and the Express endpoint that reaches it through the client', () => {
    for (const e of TS.table_reach) for (const table of e.ask) {
      const r = tool(dataDir, 'get_table_reach', { table }) as unknown as { data: { tables: Array<{ qualified_name: string; path: string; symbols?: Array<{ qualified_name: string; path: string }>; entities: Array<{ qualified_name: string }>; reach: Array<{ kind: string; qualified_name: string; path: string; depth: number }> }> } }
      expect(r.data.tables.map((t) => ({
        qualified_name: t.qualified_name, path: t.path, symbols: t.symbols?.map(({ qualified_name, path }) => ({ qualified_name, path })),
        entities: t.entities.map((x) => x.qualified_name), reach: t.reach.map(({ kind, qualified_name, path, depth }) => ({ kind, qualified_name, path, depth })),
      }))).toEqual(e.tables)
    }
  })
})
