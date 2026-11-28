import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { cli, CLI, expectedFor, fixtureRepo, indexedDataDir, ROOT, tmpDir, tool } from './helpers.js'

const EXPECTED = expectedFor('cs-reads')
type Pair = { entity: string; property: string }
const byKey = (a: Pair, b: Pair) => (`${a.entity}.${a.property}` < `${b.entity}.${b.property}` ? -1 : 1)
type Data = { static_reads: Array<Pair & { read_by: string[]; depth: number; symbol_id: string }>; static_analysis: string | null; static_bound: { endpoints: number; methods: number; unresolved_calls: number; stopped_by: string | null; not_visited: number } | null; reads: unknown[]; comparison: { both: Pair[]; static_only: Pair[]; observed_only: Pair[] } | null }

describe('A9 static entity property reads per endpoint, compared with imported runtime reads (fixtures/cs-reads)', () => {
  let dataDir: string, repoId: string
  beforeAll(async () => {
    ;({ dataDir, repoId } = await indexedDataDir(fixtureRepo('cs-reads')))
  })

  it('lists the mapped entity properties read on resolved paths from the endpoint, with the unresolved calls that bound the answer', () => {
    const r = tool(dataDir, 'get_property_reads', { endpoint: EXPECTED.endpoint })
    const data = r.data as Data
    expect(data.static_reads.map(({ entity, property, read_by, depth }) => ({ entity, property, read_by, depth }))).toEqual(EXPECTED.static_reads)
    expect(data.static_bound).toMatchObject({ endpoints: 1, unresolved_calls: EXPECTED.unresolved_calls, stopped_by: null })
    expect(data.comparison).toBeNull()
    expect(r.limitations.join(' ')).toMatch(/static reach, not load/)
  })

  it('compares static reads with the application reads an import observed', () => {
    execFileSync(process.execPath, [CLI, '--data-dir', dataDir, 'observe', 'import', repoId, path.join(ROOT, 'fixtures', 'cs-reads', 'property-reads.json')], { encoding: 'utf8' })
    const r = tool(dataDir, 'get_property_reads', { endpoint: EXPECTED.endpoint })
    const data = r.data as Data
    // FR1700 an answer with observed reads keeps the window note and the read_kind note (#235).
    expect(r.limitations.join(' ')).toMatch(/was not seen read in that window.*ORM reads are the properties/)
    const c = data.comparison!
    expect({ both: [...c.both].sort(byKey), static_only: [...c.static_only].sort(byKey), observed_only: [...c.observed_only].sort(byKey) }).toEqual(EXPECTED.comparison)
  })

  it('an endpoint the snapshot does not have yields no static reads and says so', () => {
    const r = tool(dataDir, 'get_property_reads', { endpoint: 'GET api/nowhere' })
    expect((r.data as Data).static_reads).toEqual([])
    expect(r.limitations.join(' ')).toMatch(/no endpoint named GET api\/nowhere/)
  })

  it('A9 a table is reached through code that reads its entity\'s DbSet property', () => {
    const want = EXPECTED.table_reach
    const t = (tool(dataDir, 'get_table_reach', { table: want.table }).data as { tables: Array<{ accessors: Array<{ qualified_name: string; readers: number }>; reach: Array<{ kind: string; qualified_name: string; depth: number }> }> }).tables[0]!
    expect(t.accessors.map(({ qualified_name, readers }) => ({ qualified_name, readers }))).toEqual(want.accessors)
    expect(t.reach.map(({ kind, qualified_name, depth }) => ({ kind, qualified_name, depth }))).toContainEqual(want.reached_through_accessor)
  })
})

describe('FR390 FR391 FR392 an empty get_property_reads answer says why it is empty (fixtures/cs-reads)', () => {
  let dataDir: string
  beforeAll(async () => {
    ;({ dataDir } = await indexedDataDir(fixtureRepo('cs-reads')))
  })

  it('FR390 FR392 a full traversal ran, and with nothing imported the first limitation says the observed lists are empty for that reason', () => {
    const r = tool(dataDir, 'get_property_reads', { endpoint: EXPECTED.endpoint })
    const data = r.data as Data
    expect(data.static_analysis).toBe('ran')
    expect(data.static_bound!.not_visited).toBe(0)
    expect(data.reads).toEqual([])
    expect(r.limitations[0]).toMatch(/^No imported run observed property reads for GET api\/orders\/\{id\}\/summary/)
  })

  it('FR1700 with nothing imported, the first limitation is the only one about observed reads (#235)', () => {
    for (const input of [{ endpoint: EXPECTED.endpoint }, { entity: 'Shop.Data.Order' }]) {
      const notes = tool(dataDir, 'get_property_reads', { ...input, envelope: 'compact' }).limitations.join(' ')
      expect(notes).toMatch(/^No imported run observed property reads/)
      expect(notes).not.toMatch(/was not seen read in that window/)
      expect(notes).not.toMatch(/read_kind/)
    }
  })

  it('FR390 FR391 a traversal cut by max_depth keeps the reads found so far and counts the methods one hop past the cut', () => {
    const r = tool(dataDir, 'get_property_reads', { endpoint: EXPECTED.endpoint, limits: { max_depth: 3 } })
    const data = r.data as Data
    expect(data.static_analysis).toBe('cut_by_depth')
    expect(data.static_reads.map(({ entity, property }) => ({ entity, property }))).toEqual(EXPECTED.static_reads.map(({ entity, property }: Pair) => ({ entity, property })))
    expect(data.static_bound).toMatchObject({ stopped_by: 'max_depth', not_visited: 2 })
    expect(r.completion.stop_reasons).toContain('max_depth')
    expect(r.limitations.join(' ')).toMatch(/stopped at max_depth 3: static_reads lists the reads found within 3 hops; 2 symbols one hop further were not visited/)
  })

  it('FR390 FR391 a cut that leaves static_reads empty says so instead of reading as no reads', () => {
    const r = tool(dataDir, 'get_property_reads', { endpoint: EXPECTED.endpoint, limits: { max_depth: 2 } })
    const data = r.data as Data
    expect(data.static_reads).toEqual([])
    expect(data.static_analysis).toBe('cut_by_depth')
    expect(data.static_bound!.not_visited).toBe(1)
  })

  it('FR390 an endpoint the snapshot does not name is no_endpoint, and without an endpoint there is no static analysis', () => {
    expect((tool(dataDir, 'get_property_reads', { endpoint: 'GET api/nowhere' }).data as Data).static_analysis).toBe('no_endpoint')
    expect((tool(dataDir, 'get_property_reads', { entity: 'Shop.Data.Order' }).data as Data).static_analysis).toBeNull()
  })

  it('FR390 when the C# adapter was unavailable and the syntax tier read the code, static analysis is not_available_in_mode and says why', () => {
    const d = tmpDir()
    for (const args of [['init'], ['repo', 'add', fixtureRepo('cs-reads')], ['index', fixtureRepo('cs-reads')]]) {
      const c = cli(['--data-dir', d, ...args], { PROOFMESH_CS_ADAPTER: '/nonexistent/Proofmesh.Adapter.CSharp.dll' })
      expect(c.status, c.stderr).toBe(0)
    }
    const r = tool(d, 'get_property_reads', { endpoint: EXPECTED.endpoint })
    expect((r.data as Data).static_analysis).toBe('not_available_in_mode')
    expect(r.limitations.join(' ')).toMatch(/syntax tier read 3 files .*csharp.*records no endpoints and no property reads/)
  })
})
