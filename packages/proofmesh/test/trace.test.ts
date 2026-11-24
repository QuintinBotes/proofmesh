import { beforeAll, describe, expect, it } from 'vitest'
import { indexedDataDir, symbolId, tool } from './helpers.js'

let d: string
let id: (qn: string) => string
beforeAll(async () => {
  ;({ dataDir: d } = await indexedDataDir())
  id = (qn) => symbolId(d, qn)
})
const names = (env: any, ids: string[]) => ids.map((x) => env.data.nodes[x].qualified_name)

describe('trace_paths follows a call into an interface member to its implementations', () => {
  it('reaches the implementation through the implements edge read backwards, with the dispatch limitation stated', async () => {
    const { fixtureRepo, indexedDataDir, symbolId, tool } = await import('./helpers.js')
    const { dataDir } = await indexedDataDir(fixtureRepo('cs-orders'))
    const env = tool(dataDir, 'trace_paths', { source_id: symbolId(dataDir, 'Orders.Core.Checkout.Buy'), target_id: symbolId(dataDir, 'Orders.Core.OrderService.PlaceOrder') })
    expect(env.data.conclusion).toBe('path_found')
    expect((env.data.paths as any[]).map((p) => p.nodes.map((n: string) => (env.data.nodes as any)[n].qualified_name))).toEqual([['Orders.Core.Checkout.Buy', 'Orders.Core.IOrderService.PlaceOrder', 'Orders.Core.OrderService.PlaceOrder']])
    expect((env.data.paths as any[])[0].assertions.map((a: string) => (env.data.relationships as any)[a].type)).toEqual(['calls', 'implements'])
    expect(env.limitations).toContain('implements and overrides hops run both ways: a call to an interface or virtual member may dispatch to any implementation, and the path shows the one found.')
    const callsOnly = tool(dataDir, 'trace_paths', { source_id: symbolId(dataDir, 'Orders.Core.Checkout.Buy'), target_id: symbolId(dataDir, 'Orders.Core.OrderService.PlaceOrder'), types: ['calls'] })
    expect(callsOnly.data.conclusion).toBe('no_path_exhaustive')
  }, 180000)
})

describe('trace_paths conclusions', () => {
  it('AC13 finds the cross-package path', () => {
    const env = tool(d, 'trace_paths', { source_id: id('packages/api/src/handler:handleInvoice'), target_id: id('packages/format/src/currency:formatAmount') })
    expect(env.data.conclusion).toBe('path_found')
    expect((env.data.paths as any[]).map((p) => names(env, p.nodes))).toEqual([['packages/api/src/handler:handleInvoice', 'packages/billing/src/invoice:invoiceTotal', 'packages/format/src/currency:formatAmount']])
    expect(env.completion.truncated).toBe(false)
  })

  it('under a byte budget the explored edges go before the path: a found path is never reported with an empty paths list', () => {
    const input = { source_id: id('packages/api/src/handler:handleInvoice'), target_id: id('packages/format/src/currency:formatAmount') }
    const full = tool(d, 'trace_paths', input)
    const env = tool(d, 'trace_paths', { ...input, limits: { max_bytes: Math.floor(Buffer.byteLength(JSON.stringify(full.data)) / 2) } })
    expect(env.data.conclusion).toBe('path_found')
    expect((env.data.paths as any[]).map((p) => names(env, p.nodes))).toEqual([['packages/api/src/handler:handleInvoice', 'packages/billing/src/invoice:invoiceTotal', 'packages/format/src/currency:formatAmount']])
    expect(env.completion.stop_reasons).toContain('max_bytes')
    expect((env.data.search as any).explored.length).toBeLessThan((full.data.search as any).explored.length)
    expect((env.data.search as any).explored_truncated).toBe(true)
    const referenced = new Set<string>([...(env.data.paths as any[]).flatMap((p) => p.nodes), ...(env.data.search as any).horizon.map((h: any) => h.id), ...(env.data.search as any).explored.flatMap((e: any) => [e.from, e.to]), ...(env.data.boundaries as any[]).map((b) => b.from_id), input.source_id, input.target_id])
    expect(Object.keys(env.data.nodes as object).every((k) => referenced.has(k))).toBe(true)
  })

  it('AC14 depth 1 stops at a horizon and says it is not evidence of absence', () => {
    const env = tool(d, 'trace_paths', { source_id: id('packages/api/src/handler:handleInvoice'), target_id: id('packages/format/src/currency:formatAmount'), limits: { max_depth: 1 } })
    expect(env.data.conclusion).toBe('no_path_within_bounds')
    expect((env.data.search as any).stopped_by).toBe('max_depth')
    expect((env.data.search as any).horizon.map((h: any) => [env.data.nodes && (env.data.nodes as any)[h.id].qualified_name, h.unexplored_edges])).toEqual([['packages/billing/src/invoice:invoiceTotal', 1]])
    expect(env.completion).toMatchObject({ truncated: true, stop_reasons: ['max_depth'] })
    expect(env.limitations).toContain('No path was found within the limits. This is not evidence that no path exists.')
  })

  it('AC15 FR022 an unresolved boundary blocks an exhaustive negative', () => {
    const env = tool(d, 'trace_paths', { source_id: id('packages/api/src/handler:dispatch'), target_id: id('packages/legacy/src/format:formatAmount') })
    expect(env.data.conclusion).toBe('no_resolved_path')
    expect((env.data.boundaries as any[]).map((b) => [b.reason, b.line])).toEqual([['dynamic_element_access', 11]])
    expect(env.limitations).toContain('Unresolved call sites in the explored region could lead to the target.')
  })

  it('AC16 FR022 an exhausted search with no boundaries is exhaustive, with its scope stated', () => {
    const env = tool(d, 'trace_paths', { source_id: id('packages/format/src/currency:formatAmount'), target_id: id('packages/api/src/handler:handleInvoice') })
    expect(env.data.conclusion).toBe('no_path_exhaustive')
    expect(env.limitations).toEqual(expect.arrayContaining([
      'Exhaustive only for the declared relationship types and resolutions in this snapshot.',
      'Calls made from code outside the repository, such as library callbacks, are not modelled.',
    ]))
  })
})
