import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { CLI, expectedFor, fixtureRepo, indexedDataDir, ROOT, tool } from './helpers.js'

const EXPECTED = expectedFor('cs-reads')
type Pair = { entity: string; property: string }
const byKey = (a: Pair, b: Pair) => (`${a.entity}.${a.property}` < `${b.entity}.${b.property}` ? -1 : 1)
type Data = { static_reads: Array<Pair & { read_by: string[]; depth: number; symbol_id: string }>; static_bound: { endpoints: number; unresolved_calls: number; stopped_by: string | null } | null; comparison: { both: Pair[]; static_only: Pair[]; observed_only: Pair[] } | null }

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
    const data = tool(dataDir, 'get_property_reads', { endpoint: EXPECTED.endpoint }).data as Data
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
