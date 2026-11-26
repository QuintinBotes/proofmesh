import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, beforeAll } from 'vitest'
import { cli, expectedFor, fixtureRepo, indexedDataDir, ROOT, tool, tmpDir } from './helpers.js'

const EXPECTED = expectedFor('cs-tables')
type Data = { tables: Array<{ qualified_name: string; path: string; symbols?: Array<{ qualified_name: string; path: string }>; entities: Array<{ qualified_name: string }>; reach: Array<{ kind: string; qualified_name: string; path: string; depth: number }>; horizon: boolean; observed: Array<{ source: string; metric: string; value: number; window: { from: string; to: string } }> }>; stopped_by: string | null }
const reach = (d: string, table: string, limits: Record<string, number> = {}) => tool(d, 'get_table_reach', { table, limits }) as unknown as { data: Data; limitations: string[]; completion: { stop_reasons: string[] } }

describe('A9 per-table static reach: a lower bound labelled as such, never load', () => {
  let d: string
  beforeAll(async () => { ({ dataDir: d } = await indexedDataDir(fixtureRepo('cs-tables'))) }, 180000)

  it('names the endpoints and jobs whose resolved paths reach each table, with the shortest path length, exactly as written by hand', () => {
    for (const e of EXPECTED.tables) {
      const r = reach(d, e.table)
      expect(r.data.tables.map((t) => ({ table: t.qualified_name, path: t.path, entities: t.entities.map((x) => x.qualified_name), reach: t.reach.map(({ kind, qualified_name, path, depth }) => ({ kind, qualified_name, path, depth })) }))).toEqual([{ table: e.table, path: e.path, entities: e.entities, reach: e.reach }])
      expect(r.data.tables[0]!.horizon).toBe(false)
      expect(r.data.tables[0]!.observed).toEqual([])
      expect(r.limitations).toContain('static reach, not load')
    }
    expect(() => reach(d, 'Nowhere')).toThrow(/no table named Nowhere/)
  })

  it('reports a horizon when a limit stops the search, so a short reach is a lower bound and not an absence', () => {
    const r = reach(d, 'Orders', { max_depth: 1 })
    expect(r.data.tables[0]!.reach).toEqual([])
    expect(r.data.tables[0]!.horizon).toBe(true)
    expect(r.data.stopped_by).toBe('max_depth')
    expect(r.completion.stop_reasons).toEqual(['max_depth'])
    expect(r.limitations).toContain('A limit stopped the search; the reach is a lower bound.')
  })
})

describe('A9 A36 a table is its name: table symbols that share a qualified name, ignoring case, are one table', () => {
  it('an EF entity mapped to Orders and a SQL CREATE TABLE orders are one table, asked for by either name, with both declarations, the entity and the reach', async () => {
    const repo = tmpDir('pm-a36-')
    fs.cpSync(fixtureRepo('cs-tables'), repo, { recursive: true })
    fs.mkdirSync(path.join(repo, 'db'))
    fs.writeFileSync(path.join(repo, 'db', 'orders.sql'), 'CREATE TABLE orders (\n  id INT PRIMARY KEY,\n  total DECIMAL(10, 2)\n);\n')
    const { dataDir: d } = await indexedDataDir(repo)
    const orders = (EXPECTED.tables as Array<{ table: string; reach: unknown[] }>).find((t) => t.table === 'Orders')!
    for (const name of ['Orders', 'orders']) {
      const r = reach(d, name)
      expect(r.data.tables.map((t) => ({ table: t.qualified_name, path: t.path, symbols: t.symbols, entities: t.entities.map((x) => x.qualified_name), reach: t.reach.map(({ kind, qualified_name, path, depth }) => ({ kind, qualified_name, path, depth })) }))).toEqual([{
        table: 'orders', path: 'db/orders.sql',
        symbols: [{ id: expect.any(String), key: expect.any(String), qualified_name: 'orders', path: 'db/orders.sql' }, { id: expect.any(String), key: expect.any(String), qualified_name: 'Orders', path: 'src/Shop.Data/Entities.cs' }],
        entities: ['Shop.Data.Order'], reach: orders.reach,
      }])
    }
  }, 240000)
})

describe('A30 observed property reads: which entity properties an endpoint was seen reading, beside the static reach', () => {
  it('imports a 0.2 file, reports each read with the property symbol when the snapshot has one, and labels absence as no evidence', async () => {
    const { dataDir: d, repoId } = await indexedDataDir(fixtureRepo('cs-tables'))
    const file = path.join(ROOT, 'fixtures', 'cs-tables', 'property-reads.json')
    const first = cli(['--data-dir', d, 'observe', 'import', repoId, file])
    expect(first.status, first.stderr).toBe(0)
    expect(first.stdout).toMatch(/^4 observations imported for \S+ from sample instrumented run, property access capture, window 2026-11-01T00:00:00Z to 2026-11-08T00:00:00Z \(3 property reads\)\n/)
    const r = tool(d, 'get_table_reach', { table: 'Orders' }) as unknown as { data: { tables: Array<{ property_reads: Array<{ endpoint: string; entity: string; property: string; reads: number; symbol_id: string | null; source: string }> }> }; limitations: string[] }
    const reads = r.data.tables[0]!.property_reads
    expect(reads.map((x) => [x.endpoint, x.entity, x.property, x.reads, x.symbol_id === null ? 'no symbol' : 'symbol'])).toEqual([
      ['GET api/Orders/{id}', 'Shop.Data.Order', 'Discount', 3, 'no symbol'],
      ['GET api/Orders/{id}', 'Shop.Data.Order', 'Id', 950, 'symbol'],
      ['GET api/Orders/{id}', 'Shop.Data.Order', 'Total', 950, 'symbol'],
    ])
    expect(reads.every((x) => x.source === 'sample instrumented run, property access capture')).toBe(true)
    expect(r.limitations.some((l) => l.startsWith('observed property reads come from an instrumented run'))).toBe(true)
    expect((reach(d, 'Shipments').data.tables[0] as unknown as { property_reads: unknown[] }).property_reads).toEqual([])
    expect(cli(['--data-dir', d, 'observe', 'import', repoId, file]).stdout).toMatch(/\(3 property reads\), replacing 4\n/)
    expect(cli(['--data-dir', d, 'observe', 'list', repoId]).stdout).toMatch(/^sample instrumented run, property access capture {2}2026-11-01T00:00:00Z to 2026-11-08T00:00:00Z {2}4 counts {2}by /)
  })
})

describe('A9 table-per-hierarchy: subtypes of a mapped entity share its table', () => {
  it('lists the mapped entity first and its subtypes through inherits, for EF Core and EF6', async () => {
    const { dataDir: d } = await indexedDataDir(fixtureRepo('cs-ef'))
    const entities = (table: string) => (tool(d, 'get_table_reach', { table }).data as any).tables[0].entities.map((e: any) => [e.qualified_name, e.via])
    expect(entities('Orders')).toEqual([['Shop.Core.Order', 'maps_to'], ['Shop.Core.RushOrder', 'inherits']])
    expect(entities('Invoice')).toEqual([['Shop.Legacy.Invoice', 'maps_to'], ['Shop.Legacy.CreditNote', 'inherits']])
    expect(entities('Payments')).toEqual([['Shop.Legacy.Payment', 'maps_to']])
    expect(entities('Shipment')).toEqual([['Shop.Core.Shipment', 'maps_to']])
  }, 180000)
})

describe('A30 observations 0.3: ORM reads apart from application reads, queried by endpoint and by entity', () => {
  it('imports a 0.3 file, lists loaded-but-unused properties and the mapped properties no import names, and validates files', async () => {
    const { dataDir: d, repoId } = await indexedDataDir(fixtureRepo('cs-tables'))
    const file = path.join(ROOT, 'fixtures', 'cs-tables', 'property-reads-0.3.json')
    expect(cli(['--data-dir', d, 'observe', 'validate', file]).stdout).toMatch(/is a valid observations 0.3 file: 1 counts, 4 property reads \(3 orm, 1 application\)/)
    const imported = cli(['--data-dir', d, 'observe', 'import', 'repo', file])
    expect(imported.status, imported.stderr).toBe(0)
    expect(imported.stdout).toMatch(/^5 observations imported for repo .* \(4 property reads\)\n/)
    type Read = { endpoint: string; entity: string; property: string; read_kind: string; reads: number; calls: number | null; callers: string[]; symbol_id: string | null }
    const byEndpoint = tool(d, 'get_property_reads', { endpoint: 'GET api/Orders/{id}' }) as unknown as { data: { reads: Read[]; loaded_not_used: Array<{ property: string }>; unread_mapped_properties: unknown[] }; limitations: string[] }
    expect(byEndpoint.data.reads.map((r) => [r.property, r.read_kind, r.reads, r.calls, r.callers, r.symbol_id === null ? 'no symbol' : 'symbol'])).toEqual([
      ['Id', 'application', 950, 950, ['Shop.Api.OrdersController.Get'], 'symbol'],
      ['Id', 'orm', 950, 1900, [], 'symbol'],
      ['Notes', 'orm', 950, null, [], 'symbol'],
      ['Total', 'orm', 950, null, [], 'symbol'],
    ])
    expect(byEndpoint.data.loaded_not_used.map((x) => x.property)).toEqual(['Notes', 'Total'])
    expect(byEndpoint.data.unread_mapped_properties).toEqual([])
    expect(byEndpoint.limitations.some((l) => l.startsWith('ORM reads are the properties the ORM materialised'))).toBe(true)
    const byEntity = tool(d, 'get_property_reads', { entity: 'Shop.Data.Order' }) as unknown as { data: { reads: Read[]; unread_mapped_properties: Array<{ property: string; symbol_id: string }> } }
    expect(byEntity.data.reads).toHaveLength(4)
    expect(byEntity.data.unread_mapped_properties).toEqual([])
    expect(() => tool(d, 'get_property_reads', {})).toThrow(/endpoint|entity/)
    const bad = path.join(tmpDir('pm-obs-'), 'bad-window.json')
    fs.writeFileSync(bad, fs.readFileSync(file, 'utf8').replace('2026-11-08T00:00:00Z', '2026-10-01T00:00:00Z'))
    expect(cli(['--data-dir', d, 'observe', 'validate', bad]).stderr).toContain('window.from is after window.to')
  })
})

describe('A30 runtime observations: a file a person imports, shown beside static reach and never as load from code', () => {
  it('imports the sample file, reports its counts on the table, replaces them on re-import, and refuses an invalid file', async () => {
    const { dataDir: d, repoId } = await indexedDataDir(fixtureRepo('cs-tables'))
    const file = path.join(ROOT, 'fixtures', 'cs-tables', 'observations.json')
    const first = cli(['--data-dir', d, 'observe', 'import', repoId, file])
    expect(first.status, first.stderr).toBe(0)
    expect(first.stdout).toMatch(/^3 observations imported for \S+ from sample metrics export, query rows_by_table, window 2026-11-01T00:00:00Z to 2026-11-08T00:00:00Z\n/)
    const r = reach(d, 'Orders')
    expect(r.data.tables[0]!.observed).toEqual([
      { source: 'sample metrics export, query rows_by_table', window: { from: '2026-11-01T00:00:00Z', to: '2026-11-08T00:00:00Z' }, metric: 'rows_read', value: 1200 },
      { source: 'sample metrics export, query rows_by_table', window: { from: '2026-11-01T00:00:00Z', to: '2026-11-08T00:00:00Z' }, metric: 'rows_written', value: 40 },
    ])
    expect(r.limitations.some((l) => l.startsWith('observed in window, not load from code'))).toBe(true)
    expect(reach(d, 'Shipments').data.tables[0]!.observed).toEqual([])

    const edited = path.join(tmpDir('pm-obs-'), 'orders.json')
    fs.writeFileSync(edited, fs.readFileSync(file, 'utf8').replace('1200', '1300'))
    expect(cli(['--data-dir', d, 'observe', 'import', repoId, edited]).stdout).toMatch(/^3 observations imported .*, replacing 3\n/)
    expect(reach(d, 'Orders').data.tables[0]!.observed.map((o) => o.value)).toEqual([1300, 40])
    expect(cli(['--data-dir', d, 'observe', 'list', repoId]).stdout).toMatch(/^sample metrics export, query rows_by_table {2}2026-11-01T00:00:00Z to 2026-11-08T00:00:00Z {2}3 counts {2}by \S+ at /)

    const bad = path.join(tmpDir('pm-obs-'), 'bad.json')
    fs.writeFileSync(bad, JSON.stringify({ schema_version: '0.1', source: 'x', counts: [] }))
    const refused = cli(['--data-dir', d, 'observe', 'import', repoId, bad])
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toMatch(/is not an observations file/)
    expect(reach(d, 'Orders').data.tables[0]!.observed).toHaveLength(2)
  }, 240000)
})

describe('FR026 conflicting observations from different sources are all kept and all reported', () => {
  it('two imports that disagree on one table in one window keep both counts under their own sources, and re-importing one keeps the other', async () => {
    const { dataDir: d, repoId } = await indexedDataDir(fixtureRepo('cs-tables'))
    const window = { from: '2026-11-01T00:00:00Z', to: '2026-11-08T00:00:00Z' }
    const metrics = path.join(ROOT, 'fixtures', 'cs-tables', 'observations.json')
    const apm = path.join(tmpDir('pm-obs-'), 'apm.json')
    fs.writeFileSync(apm, JSON.stringify({ schema_version: '0.1', source: 'sample APM export', window, counts: [{ subject: { kind: 'table', name: 'Orders' }, metric: 'rows_read', value: 900 }] }))
    for (const f of [metrics, apm, metrics]) expect(cli(['--data-dir', d, 'observe', 'import', repoId, f]).status).toBe(0)
    expect(reach(d, 'Orders').data.tables[0]!.observed).toEqual([
      { source: 'sample APM export', window, metric: 'rows_read', value: 900 },
      { source: 'sample metrics export, query rows_by_table', window, metric: 'rows_read', value: 1200 },
      { source: 'sample metrics export, query rows_by_table', window, metric: 'rows_written', value: 40 },
    ])
  }, 240000)
})
