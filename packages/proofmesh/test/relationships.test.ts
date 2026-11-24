import { beforeAll, describe, expect, it } from 'vitest'
import { indexedDataDir, symbolId, tool } from './helpers.js'

let d: string
beforeAll(async () => { ({ dataDir: d } = await indexedDataDir()) })

describe('an external symbol is a subject for inbound calls', () => {
  it('lists the resolved calls into an ext_ id and says that only inbound calls are known', async () => {
    const { indexedDataDir, tool, withSnapshot } = await import('./helpers.js')
    const { dataDir } = await indexedDataDir()
    const ext = withSnapshot(dataDir, (db) => db.prepare("select target_id as id, count(*) as n from assertion where resolution = 'resolved_external' and type = 'calls' group by target_id order by n desc, target_id limit 1").get() as { id: string; n: number } | undefined)
    expect(ext, 'the fixture calls at least one external symbol').toBeDefined()
    const env = tool(dataDir, 'get_relationships', { subject_id: ext!.id, types: ['calls'] })
    expect((env.data.relationships as any[]).length).toBe(ext!.n)
    expect((env.data.relationships as any[]).every((r) => r.direction === 'in' && r.resolution === 'resolved_external')).toBe(true)
    expect(env.data.totals).toEqual({ in: ext!.n, out: 0 })
    expect(env.limitations.some((l) => l.startsWith('The subject is an external symbol'))).toBe(true)
  })
})

describe('get_relationships', () => {
  it('AC18 FR023 SC001 the decoy has no inbound relationships and exactly one boundary that could reach it', () => {
    const env = tool(d, 'get_relationships', { subject_id: symbolId(d, 'packages/legacy/src/format:formatAmount'), direction: 'in' })
    expect(env.data.relationships).toEqual([])
    expect((env.data.boundaries as any[]).map((b) => [b.reason, b.line, b.path])).toEqual([['dynamic_element_access', 11, 'packages/api/src/handler.ts']])
    expect(env.unresolved).toMatchObject({ count: 1, scope: 'query', by_reason: { dynamic_element_access: 1 } })
  })

  it('outbound calls default to code in the repository, count the external ones, and list them on request with evidence', () => {
    const rows = (env: ReturnType<typeof tool>) => (env.data.relationships as any[]).map((r) => [r.resolution, r.other.kind, r.other.qualified_name ?? `${r.other.module}:${r.other.name}`, r.site.start_line]).sort()
    const subject_id = symbolId(d, 'packages/billing/src/invoice:invoiceTotal')
    const own = tool(d, 'get_relationships', { subject_id, direction: 'out' })
    expect(rows(own)).toEqual([['resolved', 'symbol', 'packages/format/src/currency:formatAmount', 9]])
    expect((own.data.totals as any).out_external).toBe(1)
    expect(own.limitations.join(' ')).toMatch(/1 outbound call to code outside the repository .* is left out; pass include_external true/)
    const all = tool(d, 'get_relationships', { subject_id, direction: 'out', include_external: true })
    expect(rows(all)).toEqual([['resolved', 'symbol', 'packages/format/src/currency:formatAmount', 9], ['resolved_external', 'external', 'lib.es5.d.ts:Array.reduce', 8]])
    expect(all.evidence_ids.length).toBe(2)
  })

  it('file subjects default to imports, with every statement as evidence', () => {
    const files = tool(d, 'workspace_status', { files: {} }).data.files as any[]
    expect(files.length).toBe(10)
    const env = tool(d, 'find_symbols', { text: 'packages/billing/src/index', kinds: ['module'] })
    expect((env.data.symbols as any[]).length).toBe(1)
  })

  it('unknown subjects are NOT_FOUND', () => {
    expect(() => tool(d, 'get_relationships', { subject_id: 'sym_0000000000' })).toThrow(/not in snapshot/)
  })
})
