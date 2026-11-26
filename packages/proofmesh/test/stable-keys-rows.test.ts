import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { beforeAll, describe, expect, it } from 'vitest'
import { Catalog, initDataDir } from '../src/meshstore/catalog.js'
import { indexRepository } from '../src/indexer/coordinator.js'
import { openSnapshot } from '../src/meshstore/snapshot.js'
import { cli, expectedFor, fixtureRepo, indexedDataDir, ROOT, tmpDir, tool, withSnapshot } from './helpers.js'
import { writeLinkFile } from './helpers-links.js'

/** Every object under `data` that names a symbol by its snapshot id, with the id and the field its key belongs in. */
function namings(data: unknown): Array<{ row: Record<string, unknown>; id: string; field: string }> {
  const out: Array<{ row: Record<string, unknown>; id: string; field: string }> = []
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(walk)
    if (n === null || typeof n !== 'object') return
    const row = n as Record<string, unknown>
    for (const [id, field] of [['id', 'key'], ['symbol_id', 'symbol_key'], ['from_id', 'from_key']] as const) if (typeof row[id] === 'string') out.push({ row, id: row[id] as string, field })
    // An overview child's key is the id of a symbol child and the path of a file or directory.
    if (row.kind === 'symbol' && 'symbol_kind' in row && typeof row.key === 'string') out.push({ row, id: row.key, field: 'symbol_key' })
    // trace_paths names each node by the id it is keyed with.
    const nodes = row.nodes
    if (nodes !== null && typeof nodes === 'object' && !Array.isArray(nodes)) for (const [id, v] of Object.entries(nodes)) if (v !== null && typeof v === 'object') out.push({ row: v as Record<string, unknown>, id, field: 'key' })
    for (const v of Object.values(row)) walk(v)
  }
  walk(data)
  return out
}

/** Asserts that every naming whose id is a symbol of the snapshot carries that symbol's stable_key; returns how many it checked. */
function everyRowKeyed(db: Database.Database, data: unknown): number {
  const stable = db.prepare('select stable_key from symbol where id = ?')
  let checked = 0
  for (const { row, id, field } of namings(data)) {
    const s = stable.get(id) as { stable_key: string } | undefined
    if (!s) continue
    expect(row[field], `${field} of ${JSON.stringify(row).slice(0, 160)}`).toBe(s.stable_key)
    checked++
  }
  return checked
}

const KEY_FIELDS = new Set(['key', 'from_key', 'symbol_key', 'source_key', 'target_key'])
const SLOP = 64
const bytes = (x: unknown) => Buffer.byteLength(JSON.stringify(x))
/** The answer as it was before keys: every key field left out (never an overview child's `key`, which is its id). */
const withoutKeys = <T>(x: T): T => JSON.parse(JSON.stringify(x), function (this: Record<string, unknown>, k, v) { return KEY_FIELDS.has(k) && typeof v === 'string' && !('matches' in this) ? undefined : v })

/** An answer the keys alone push over max_bytes is cut by whole rows to fit it, and says so, as every other tool does (FR280 to FR289). */
function fitsWithoutItsKeys(d: string, name: string, input: Record<string, unknown>) {
  const full = tool(d, name, input)
  const budget = bytes(withoutKeys(full))
  expect(bytes(full), `${name} answers over ${budget} with its keys`).toBeGreaterThan(budget)
  const tight = tool(d, name, { ...input, limits: { ...(input.limits as object | undefined), max_bytes: budget } })
  // The pruner reserves a fixed length for the note and flags a cut answer gains, so a cut answer may pass the budget by a few dozen bytes; the keys are hundreds.
  expect(bytes(tight), `${name} within max_bytes ${budget}`).toBeLessThanOrEqual(budget + SLOP)
  expect(tight.completion.truncated, `${name} says it was cut`).toBe(true)
  expect(tight.completion.stop_reasons).toContain('max_bytes')
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim()
const idOf = (db: Database.Database, qualified: string) => (db.prepare('select id from symbol where qualified_name = ?').get(qualified) as { id: string }).id
const keyOf = (db: Database.Database, qualified: string) => (db.prepare('select stable_key from symbol where qualified_name = ?').get(qualified) as { stable_key: string }).stable_key

describe('FR280 FR281 FR282 FR283 FR284 every structured row that names a symbol carries its stable key (fixtures/change-reach)', () => {
  let d: string, repo: string, base: string, head: string
  beforeAll(async () => {
    repo = fs.realpathSync(tmpDir('pm-rowkeys-'))
    const fx = path.join(ROOT, 'fixtures', 'change-reach')
    fs.cpSync(path.join(fx, 'base'), repo, { recursive: true })
    fs.copyFileSync(path.join(fx, 'tsconfig.json'), path.join(repo, 'tsconfig.json'))
    git(repo, 'init', '-q'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base')
    base = git(repo, 'rev-parse', 'HEAD')
    fs.cpSync(path.join(fx, 'head'), repo, { recursive: true })
    fs.cpSync(path.join(fx, 'head-delete'), repo, { recursive: true })
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'head')
    head = git(repo, 'rev-parse', 'HEAD')
    ;({ dataDir: d } = await indexedDataDir(repo))
  }, 240000)
  const keyed = <T>(f: (db: Database.Database) => T) => withSnapshot(d, f)
  const mean = () => keyed((db) => ({ id: idOf(db, 'src/stats:mean'), key: keyOf(db, 'src/stats:mean') }))

  it('FR280 get_relationships: the far side, the member a call dispatches through and each unresolved site carry key', () => {
    const callee = keyed((db) => idOf(db, 'src/roles/analyst:analystScore'))
    for (const [id, direction] of [[mean().id, 'in'], [callee, 'out']] as const) {
      const data = tool(d, 'get_relationships', { subject_id: id, direction }).data
      expect(keyed((db) => everyRowKeyed(db, data))).toBeGreaterThan(0)
    }
    const all = tool(d, 'get_relationships', { subject_id: mean().id, direction: 'in' }).data as { relationships: Array<{ other: { kind: string; key?: string; qualified_name?: string } }> }
    const far = all.relationships.filter((r) => r.other.kind === 'symbol')
    expect(far.length).toBeGreaterThan(0)
    expect(far.map((r) => r.other.key)).toEqual(far.map((r) => keyed((db) => keyOf(db, r.other.qualified_name!))))
  })

  it('FR281 analyze_impact and find_tests: every dependent and every test, and every hop of a test chain, carries key', () => {
    const impact = tool(d, 'analyze_impact', { subject_ids: [mean().id], limits: { max_depth: 3 } }).data as { dependents: Array<{ key?: string; qualified_name: string }> }
    expect(impact.dependents.length).toBeGreaterThan(1)
    expect(impact.dependents.map((x) => x.key)).toEqual(impact.dependents.map((x) => keyed((db) => keyOf(db, x.qualified_name))))
    const found = tool(d, 'find_tests', { subject_ids: [mean().id] }).data as { tests: Array<{ key?: string; qualified_name: string; chain: Array<{ key?: string; name: string; path: string; line: number }> }> }
    expect(found.tests.length).toBeGreaterThan(0)
    for (const t of found.tests) {
      expect(t.key).toBe(keyed((db) => keyOf(db, t.qualified_name)))
      expect(t.chain.map((h) => h.key)).toEqual(t.chain.map((h) => keyed((db) => (db.prepare('select s.stable_key from symbol s join file f on f.id = s.file_id where f.path = ? and s.start_line = ? and s.kind <> ?').get(h.path, h.line, 'module') as { stable_key: string } | undefined)?.stable_key ?? '(a call site, not a declaration)')).map((k, i) => (k === '(a call site, not a declaration)' ? t.chain[i]!.key : k)))
      expect(t.chain.every((h) => typeof h.key === 'string' && h.key.length > 0)).toBe(true)
      // the last hop is the subject at its declaration
      expect(t.chain.at(-1)!.key).toBe(mean().key)
    }
  })

  it('FR282 trace_paths: every node of the path and each frontier node and unresolved site carry key', () => {
    const source = keyed((db) => idOf(db, 'test/analyst.test:analystScoreDoubles'))
    const r = tool(d, 'trace_paths', { source_id: source, target_id: mean().id }).data as { conclusion: string; nodes: Record<string, { key?: string }> }
    expect(r.conclusion).toBe('path_found')
    expect(Object.keys(r.nodes).length).toBeGreaterThan(2)
    expect(keyed((db) => everyRowKeyed(db, r))).toBe(Object.keys(r.nodes).length)
  })

  it('FR283 find_symbols, search_sources, get_overview of a file and workspace_status hubs carry key', () => {
    const found = tool(d, 'find_symbols', { text: 'mean' }).data
    expect(keyed((db) => everyRowKeyed(db, found))).toBeGreaterThan(0)
    const hits = tool(d, 'search_sources', { text: 'mean' }).data as { hits: Array<{ symbol: { key?: string } | null }> }
    expect(hits.hits.some((h) => h.symbol)).toBe(true)
    expect(keyed((db) => everyRowKeyed(db, hits))).toBe(hits.hits.filter((h) => h.symbol).length)
    const overview = tool(d, 'get_overview', { path: 'src/stats.ts' }).data as { scope: string; children: Array<{ kind: string; symbol_key?: string }> }
    expect(overview.scope).toBe('file')
    expect(overview.children.map((c) => c.symbol_key)).toEqual(['src/stats.ts#src/stats:mean#function'])
    const status = tool(d, 'workspace_status', {}).data as { hubs: Array<{ id: string }> }
    expect(status.hubs.length).toBeGreaterThan(0)
    expect(keyed((db) => everyRowKeyed(db, status))).toBe(status.hubs.length)
  })

  it('FR284 impact_completeness: changed symbols, dependents and the nearest test carry key, also for a deleted symbol', () => {
    expect(cli(['--data-dir', d, 'completeness', repo, `${base}..${head}`]).status, 'index base and head').toBeLessThanOrEqual(1)
    const catalogId = (tool(d, 'list_repositories').data as { repositories: Array<{ id: string; root: string }> }).repositories.find((x) => fs.realpathSync(x.root) === repo)!.id
    const data = tool(d, 'impact_completeness', { repository_id: catalogId, base, head }).data as { changed: Array<{ key?: string; name: string; path: string; test: { key?: string } | null; dependents: Array<{ key?: string; relation: string; test: { key?: string } | null }> }> }
    expect(data.changed.length).toBeGreaterThan(0)
    expect(data.changed.every((c) => typeof c.key === 'string')).toBe(true)
    expect(data.changed.some((c) => (c as { change?: string }).change === 'deleted')).toBe(true)
    const deps = data.changed.flatMap((c) => c.dependents)
    expect(deps.filter((x) => x.relation !== 'imports').every((x) => typeof x.key === 'string')).toBe(true)
    expect(deps.filter((x) => x.relation === 'imports').every((x) => x.key === undefined)).toBe(true)
    const tests = [...data.changed.map((c) => c.test), ...deps.map((x) => x.test)].filter((t) => t)
    expect(tests.length).toBeGreaterThan(0)
    expect(tests.every((t) => typeof t!.key === 'string')).toBe(true)
  }, 240000)
})

describe('FR280 to FR289 the keys count against max_bytes: every keyed list is cut by the byte budget (fixtures/change-reach, prisma-schema)', () => {
  let d: string
  beforeAll(async () => {
    const repo = fs.realpathSync(tmpDir('pm-rowkeys-budget-'))
    const fx = path.join(ROOT, 'fixtures', 'change-reach')
    fs.cpSync(path.join(fx, 'base'), repo, { recursive: true })
    fs.copyFileSync(path.join(fx, 'tsconfig.json'), path.join(repo, 'tsconfig.json'))
    ;({ dataDir: d } = await indexedDataDir(repo))
  }, 240000)
  const mean = () => withSnapshot(d, (db) => idOf(db, 'src/stats:mean'))

  it('relationships, impact, tests, symbols, hubs and source hits stay within max_bytes and report the cut', () => {
    fitsWithoutItsKeys(d, 'get_relationships', { subject_id: mean(), direction: 'in' })
    fitsWithoutItsKeys(d, 'analyze_impact', { subject_ids: [mean()], limits: { max_depth: 3 } })
    fitsWithoutItsKeys(d, 'find_tests', { subject_ids: [mean()] })
    fitsWithoutItsKeys(d, 'find_symbols', { text: 'a' })
    fitsWithoutItsKeys(d, 'workspace_status', {})
  })

  it('search_sources counts a hit\'s key in its own byte budget, which holds the hits less 128 bytes for the envelope', () => {
    const r = tool(d, 'search_sources', { text: 'export', limits: { max_bytes: 1000 } })
    const hits = (r.data as { hits: Array<{ symbol: { key?: string } | null }> }).hits
    expect(hits.some((h) => h.symbol?.key)).toBe(true)
    expect(bytes(hits)).toBeLessThanOrEqual(1000 - 128)
    expect(r.completion.stop_reasons).toContain('max_bytes')
  })

  it('trace_paths keeps its path and cuts the nodes', () => {
    const source = withSnapshot(d, (db) => idOf(db, 'test/analyst.test:analystScoreDoubles'))
    fitsWithoutItsKeys(d, 'trace_paths', { source_id: source, target_id: mean() })
  })

  it('get_table_reach cuts the lists of a table (fixtures/prisma-schema)', async () => {
    const { dataDir } = await indexedDataDir(fixtureRepo('prisma-schema'))
    fitsWithoutItsKeys(dataDir, 'get_table_reach', { table: expectedFor('prisma-schema').table_reach[0].table })
  }, 240000)
})

describe('FR286 get_ecosystem trims unresolved boundaries to max_bytes too', () => {
  it('a workspace whose links are all unresolved answers within max_bytes, cut by whole boundaries', async () => {
    const d = tmpDir()
    initDataDir(d)
    const members: Array<{ repository_id: string; snapshot_id: string; name: string; fns: string[] }> = []
    for (const [fixture, name] of [['ts-invoicing', 'alpha'], ['ts-packages', 'beta']] as const) {
      const repo = tmpDir(`pm-eco-${name}-`)
      fs.cpSync(fixtureRepo(fixture), repo, { recursive: true })
      const c = Catalog.open(d)
      const id = c.addRepository(repo, name).id
      c.close()
      const { snapshotId } = await indexRepository(d, id)
      const c2 = Catalog.open(d)
      const db = openSnapshot(c2, c2.snapshot(snapshotId)!)
      const fns = (db.prepare("select id from symbol where kind = 'function' order by qualified_name limit 6").all() as Array<{ id: string }>).map((f) => f.id)
      db.close(); c2.close()
      members.push({ repository_id: id, snapshot_id: snapshotId, name, fns })
    }
    const c = Catalog.open(d)
    c.addToWorkspace('shop', members.map((m) => m.repository_id), 'test')
    c.close()
    const links = members.flatMap((m) => (['calls_endpoint', 'messages'] as const).flatMap((type) => m.fns.map((fn) => ({ type, rule: type === 'messages' ? 'messaging' : 'http_route', source: [m.repository_id, fn] as [string, string], confidence: 1, resolution: 'unresolved' as const, reason: 'no_match' }))))
    writeLinkFile(d, 'shop', members, links, { http_route: '1', messaging: '1' })
    const full = tool(d, 'get_ecosystem', { workspace: 'shop' })
    const data = full.data as { boundaries: unknown[] }
    expect(data.boundaries.length).toBeGreaterThan(2)
    expect(full.completion.truncated).toBe(false)
    const budget = bytes({ ...full.data, boundaries: [] }) + 400
    expect(bytes(full.data)).toBeGreaterThan(budget)
    const tight = tool(d, 'get_ecosystem', { workspace: 'shop', limits: { max_bytes: budget } })
    expect(bytes(tight.data)).toBeLessThanOrEqual(budget)
    expect((tight.data as { boundaries: unknown[] }).boundaries.length).toBeLessThan(data.boundaries.length)
    expect(tight.completion.truncated).toBe(true)
    expect(tight.completion.stop_reasons).toContain('max_bytes')
  }, 240000)
})

describe('FR280 FR282 rows of a dispatch, an unresolved site, a frontier and a boundary carry key (a TypeScript interface, its implementation and an untyped caller)', () => {
  let d: string
  beforeAll(async () => {
    const repo = fs.realpathSync(tmpDir('pm-rowkeys-dispatch-'))
    fs.writeFileSync(path.join(repo, 'tsconfig.json'), '{ "compilerOptions": { "strict": true, "target": "es2022", "module": "esnext", "moduleResolution": "bundler" }, "include": ["*.ts"] }\n')
    fs.writeFileSync(path.join(repo, 'iface.ts'), 'export interface Shape {\n  area(): number\n}\nexport class Square implements Shape {\n  area(): number {\n    return 1\n  }\n}\n')
    fs.writeFileSync(path.join(repo, 'use.ts'), "import { Shape } from './iface'\nexport function total(s: Shape): number {\n  return s.area()\n}\ndeclare const loose: any\nexport function dyn(): number {\n  return loose.area()\n}\nexport function top(): number {\n  return total({ area: () => 2 })\n}\n")
    ;({ dataDir: d } = await indexedDataDir(repo))
  }, 240000)
  const id = (q: string) => withSnapshot(d, (db) => idOf(db, q))

  it('get_relationships: an inbound row names the member it dispatches through (via) and each unresolved site its symbol (from_key)', () => {
    const data = tool(d, 'get_relationships', { subject_id: id('iface:Square.area'), direction: 'in' }).data as { relationships: Array<{ via?: { id: string; key?: string } }>; boundaries: Array<{ from_id: string; from_key?: string }> }
    const via = data.relationships.filter((r) => r.via)
    expect(via.length, 'a dispatch row').toBeGreaterThan(0)
    expect(via.every((r) => r.via!.key === withSnapshot(d, (db) => (db.prepare('select stable_key from symbol where id = ?').get(r.via!.id) as { stable_key: string }).stable_key))).toBe(true)
    expect(data.boundaries.length, 'an unresolved site').toBeGreaterThan(0)
    expect(data.boundaries.every((b) => typeof b.from_key === 'string')).toBe(true)
    expect(withSnapshot(d, (db) => everyRowKeyed(db, data))).toBeGreaterThanOrEqual(via.length + data.boundaries.length)
  })

  it('trace_paths: a search stopped by max_depth keys its frontier, and an unresolved call keys its boundary', () => {
    const horizon = tool(d, 'trace_paths', { source_id: id('use:top'), target_id: id('iface:Square.area'), limits: { max_depth: 1 } }).data as { conclusion: string; search: { horizon: Array<{ id: string; key?: string }> } }
    expect(horizon.conclusion).toBe('no_path_within_bounds')
    expect(horizon.search.horizon.length, 'a frontier').toBeGreaterThan(0)
    expect(withSnapshot(d, (db) => everyRowKeyed(db, horizon))).toBeGreaterThanOrEqual(horizon.search.horizon.length)
    expect(horizon.search.horizon.every((h) => typeof h.key === 'string')).toBe(true)
    const bounded = tool(d, 'trace_paths', { source_id: id('use:dyn'), target_id: id('iface:Square.area') }).data as { boundaries: Array<{ from_id: string; from_key?: string }> }
    expect(bounded.boundaries.length, 'a boundary').toBeGreaterThan(0)
    expect(bounded.boundaries.every((b) => typeof b.from_key === 'string')).toBe(true)
    expect(withSnapshot(d, (db) => everyRowKeyed(db, bounded))).toBeGreaterThanOrEqual(bounded.boundaries.length)
  })
})

describe('FR285 get_table_reach rows carry key (fixtures/prisma-schema)', () => {
  it('the table, the symbols declaring it and the entity mapped to it', async () => {
    const { dataDir } = await indexedDataDir(fixtureRepo('prisma-schema'))
    const table = expectedFor('prisma-schema').table_reach[0].table
    const data = (tool(dataDir, 'get_table_reach', { table }).data as { tables: Array<{ key?: string; entities: Array<{ key?: string }> }> })
    expect(data.tables.length).toBeGreaterThan(0)
    expect(data.tables[0]!.entities.length).toBeGreaterThan(0)
    // table + entities, and the symbols the table is declared by
    expect(withSnapshot(dataDir, (db) => everyRowKeyed(db, data))).toBeGreaterThanOrEqual(1 + data.tables[0]!.entities.length)
    expect(data.tables.every((t) => typeof t.key === 'string' && t.entities.every((e) => typeof e.key === 'string'))).toBe(true)
  }, 240000)
})

describe('FR286 get_ecosystem sample rows carry the stable key of each end', () => {
  it('source_key and target_key are the keys of the member snapshots\' symbols, and an unresolved sample carries source_key', async () => {
    const d = tmpDir()
    initDataDir(d)
    const members: Array<{ repository_id: string; snapshot_id: string; name: string; fn: string; key: string }> = []
    for (const [fixture, name] of [['ts-invoicing', 'alpha'], ['ts-packages', 'beta']] as const) {
      const repo = tmpDir(`pm-eco-${name}-`)
      fs.cpSync(fixtureRepo(fixture), repo, { recursive: true })
      const c = Catalog.open(d)
      const id = c.addRepository(repo, name).id
      c.close()
      const { snapshotId } = await indexRepository(d, id)
      const c2 = Catalog.open(d)
      const db = openSnapshot(c2, c2.snapshot(snapshotId)!)
      const f = db.prepare("select id, stable_key from symbol where kind = 'function' order by qualified_name limit 1").get() as { id: string; stable_key: string }
      db.close(); c2.close()
      members.push({ repository_id: id, snapshot_id: snapshotId, name, fn: f.id, key: f.stable_key })
    }
    const c = Catalog.open(d)
    c.addToWorkspace('shop', members.map((m) => m.repository_id), 'test')
    c.close()
    const [a, b] = members as [typeof members[0], typeof members[0]]
    writeLinkFile(d, 'shop', members, [
      { type: 'calls_endpoint', rule: 'http_route', source: [a.repository_id, a.fn], target: [b.repository_id, b.fn], confidence: 1, resolution: 'resolved' },
      { type: 'calls_endpoint', rule: 'http_route', source: [a.repository_id, a.fn], confidence: 1, resolution: 'unresolved', reason: 'no_match' },
    ])
    const data = tool(d, 'get_ecosystem', { workspace: 'shop' }).data as { links: Array<{ sample: Array<{ source_key?: string; target_key?: string }> }>; boundaries: Array<{ sample: Array<{ source_key?: string }> }> }
    expect(data.links[0]!.sample[0]).toMatchObject({ source_key: a.key, target_key: b.key })
    expect(data.boundaries[0]!.sample[0]).toMatchObject({ source_key: a.key })
  }, 240000)
})

const csDb = <T>(d: string, f: (db: Database.Database) => T) => withSnapshot(d, f)

describe('FR287 FR288 FR289 property reads, table reach and query-source rows carry key (C# fixtures, which need the .NET adapter)', () => {
  it('FR287 get_property_reads: static, observed and unread mapped properties carry symbol_key (fixtures/cs-tables, cs-reads)', async () => {
    const { dataDir: d } = await indexedDataDir(fixtureRepo('cs-reads'))
    const stat = tool(d, 'get_property_reads', { endpoint: expectedFor('cs-reads').endpoint }).data as { static_reads: Array<{ symbol_id: string; symbol_key?: string }> }
    expect(stat.static_reads.length).toBeGreaterThan(0)
    expect(csDb(d, (db) => everyRowKeyed(db, stat))).toBe(stat.static_reads.length)

    const { dataDir: t, repoId } = await indexedDataDir(fixtureRepo('cs-tables'))
    const file = path.join(ROOT, 'fixtures', 'cs-tables', 'property-reads-0.3.json')
    expect(cli(['--data-dir', t, 'observe', 'import', repoId, file]).status).toBe(0)
    const observed = tool(t, 'get_property_reads', { endpoint: 'GET api/Orders/{id}' }).data as { reads: Array<{ symbol_id: string | null; symbol_key?: string }> }
    expect(observed.reads.length).toBeGreaterThan(0)
    expect(observed.reads.every((r) => r.symbol_id === null || typeof r.symbol_key === 'string')).toBe(true)
    expect(csDb(t, (db) => everyRowKeyed(db, observed))).toBe(observed.reads.filter((r) => r.symbol_id !== null).length)
  }, 240000)

  it('FR288 get_table_reach: reach, accessors and observed property reads carry key (fixtures/cs-tables)', async () => {
    const { dataDir: d, repoId } = await indexedDataDir(fixtureRepo('cs-tables'))
    expect(cli(['--data-dir', d, 'observe', 'import', repoId, path.join(ROOT, 'fixtures', 'cs-tables', 'property-reads-0.3.json')]).status).toBe(0)
    const r = tool(d, 'get_table_reach', { table: 'Orders' }).data as { tables: Array<{ reach: unknown[]; entities: unknown[]; property_reads: unknown[] }> }
    const t = r.tables[0]!
    expect(t.reach.length + t.entities.length).toBeGreaterThan(1)
    // table + entities + reach rows
    expect(csDb(d, (db) => everyRowKeyed(db, r))).toBeGreaterThanOrEqual(1 + t.entities.length + t.reach.length)
  }, 240000)

  it('FR287 FR288 get_property_reads and get_table_reach stay within max_bytes and report the cut (fixtures/cs-reads, cs-tables)', async () => {
    const { dataDir: r } = await indexedDataDir(fixtureRepo('cs-reads'))
    fitsWithoutItsKeys(r, 'get_property_reads', { endpoint: expectedFor('cs-reads').endpoint })
    const { dataDir: t, repoId } = await indexedDataDir(fixtureRepo('cs-tables'))
    expect(cli(['--data-dir', t, 'observe', 'import', repoId, path.join(ROOT, 'fixtures', 'cs-tables', 'property-reads-0.3.json')]).status).toBe(0)
    fitsWithoutItsKeys(t, 'get_table_reach', { table: 'Orders' })
  }, 240000)

  it('FR289 find_query_source: every candidate carries key (fixtures/cs-query-source)', async () => {
    const fx = path.join(ROOT, 'fixtures', 'cs-query-source')
    const d = tmpDir()
    initDataDir(d)
    const c = Catalog.open(d)
    const repoId = c.addRepository(fixtureRepo('cs-query-source')).id
    c.close()
    execFileSync(process.execPath, [path.join(ROOT, 'packages', 'proofmesh', 'bin', 'proofmesh.mjs'), '--data-dir', d, 'repo', 'conventions', repoId, path.join(fx, 'conventions.json')], { encoding: 'utf8' })
    await indexRepository(d, repoId)
    const data = tool(d, 'find_query_source', { sql: expectedFor('cs-query-source').sql }).data as { candidates: Array<{ key?: string; qualified_name: string }> }
    expect(data.candidates.length).toBeGreaterThan(0)
    expect(data.candidates.map((x) => x.key)).toEqual(data.candidates.map((x) => csDb(d, (db) => keyOf(db, x.qualified_name))))
  }, 240000)
})
