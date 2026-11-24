import { beforeAll, describe, expect, it } from 'vitest'
import { expectedFor, fixtureRepo, indexedDataDir, symbolId, tool } from './helpers.js'

const EXPECTED = expectedFor('cs-dispatch')
type Rel = { direction: string; type: string; other: { qualified_name?: string }; site: { start_line: number; path: string }; via?: { qualified_name: string } }
type Data = { relationships: Rel[]; boundaries: Array<{ from_id: string; line: number; reason: string; calls_name?: boolean }>; totals: { in: number; boundaries_calling_name?: number } }

describe('inbound relationships through dispatch, and likely callers by name (fixtures/cs-dispatch)', () => {
  let dataDir: string
  beforeAll(async () => {
    ;({ dataDir } = await indexedDataDir(fixtureRepo('cs-dispatch')))
  })

  it('FR012 calls naming the interface member an implementation implements are inbound calls of the implementation, marked via', () => {
    const r = tool(dataDir, 'get_relationships', { subject_id: symbolId(dataDir, EXPECTED.subject), direction: 'in' })
    const data = r.data as Data
    const calls = data.relationships.filter((x) => x.type === 'calls').map((x) => ({ from: x.other.qualified_name, line: x.site.start_line, via: x.via?.qualified_name }))
    const byFrom = (a: { from?: string }, b: { from?: string }) => ((a.from ?? '') < (b.from ?? '') ? -1 : 1)
    expect(calls.sort(byFrom)).toEqual(EXPECTED.inbound_calls.map(({ from, line, via }: { from: string; line: number; via: string }) => ({ from, line, via })).sort(byFrom))
    expect(data.totals.in).toBe(EXPECTED.inbound_calls.length)
    expect(r.limitations.join(' ')).toMatch(/implements or overrides/)
  })

  it('A3 unresolved calls that call the subject\'s name come first, its parameter count first, and are counted', () => {
    const r = tool(dataDir, 'get_relationships', { subject_id: symbolId(dataDir, EXPECTED.subject), direction: 'in' })
    const data = r.data as Data
    const name = (id: string) => (tool(dataDir, 'get_symbol', { symbol_id: id }).data as { symbol: { qualified_name: string } }).symbol.qualified_name
    expect(data.boundaries.map((b) => ({ from: name(b.from_id), line: b.line, reason: b.reason, calls_name: b.calls_name === true }))).toEqual(EXPECTED.boundaries_in_order)
    expect(data.totals.boundaries_calling_name).toBe(EXPECTED.boundaries_calling_name)
  })
})

describe('#34 the outbound default hides only external calls', () => {
  it('a package dependency, external by nature, is listed when its type is asked for', async () => {
    const { dataDir } = await indexedDataDir(fixtureRepo('cs-inherited'))
    const r = tool(dataDir, 'get_relationships', { subject_id: symbolId(dataDir, 'App'), direction: 'out', types: ['depends_on_package'] })
    expect((r.data.relationships as Array<{ resolution: string; other: { name: string } }>).map((x) => [x.resolution, x.other.name])).toContainEqual(['resolved_external', 'Contoso.Shared'])
    expect((r.data.totals as { out_external?: number }).out_external).toBeUndefined()
  })
})

