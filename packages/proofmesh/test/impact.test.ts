import { beforeAll, describe, expect, it } from 'vitest'
import { fixtureRepo, indexedDataDir, symbolId, tool } from './helpers.js'

let d: string
beforeAll(async () => { ({ dataDir: d } = await indexedDataDir()) })
const impact = (qn: string, limits?: Record<string, number>) => tool(d, 'analyze_impact', { subject_ids: [symbolId(d, qn)], ...(limits ? { limits } : {}) })

describe('FR019 analyze_impact: potential impact, with its limits stated', () => {
  it('reaches every dependent breadth first, with totals by depth and area', () => {
    const env = impact('packages/format/src/currency:formatAmount')
    const data = env.data as any
    expect(data.dependents.map((x: any) => [x.qualified_name, x.depth])).toEqual([['packages/billing/src/invoice:invoiceTotal', 1], ['packages/api/src/handler:handleInvoice', 2]])
    expect(data.totals).toMatchObject({ dependents: 2, by_depth: { 1: 1, 2: 1 }, by_area: [{ name: 'packages/api/src', count: 1 }, { name: 'packages/billing/src', count: 1 }] })
    expect(data.stopped_by).toBeNull()
    expect(env.limitations).toContain('1 unresolved call site in this snapshot has an unknown target and could also reach these symbols.')
  })

  it('a depth limit stops the search and says more may be affected', () => {
    const env = impact('packages/format/src/currency:formatAmount', { max_depth: 1 })
    expect((env.data as any).dependents.map((x: any) => x.name)).toEqual(['invoiceTotal'])
    expect((env.data as any).stopped_by).toBe('max_depth')
    expect(env.completion.stop_reasons).toEqual(['max_depth'])
    expect(env.limitations).toContain('The search stopped at the depth limit; more code may be affected.')
  })

  it('the same-named decoy has no resolved dependents', () => {
    expect((impact('packages/legacy/src/format:formatAmount').data as any).totals.dependents).toBe(0)
  })
})

describe('FR019 analyze_impact on a type starts from its members', () => {
  let dataDir: string
  beforeAll(async () => { ({ dataDir } = await indexedDataDir(fixtureRepo('cs-orders'))) })

  it('a class is reached through the methods that are called', () => {
    const id = (tool(dataDir, 'find_symbols', { text: 'PriceCalculator', kinds: ['class'] }).data.symbols as Array<{ id: string }>)[0]!.id
    const data = tool(dataDir, 'analyze_impact', { subject_ids: [id] }).data as any
    expect(data.subject_members).toBe(1)
    // PlaceOrder implements the interface member that Checkout calls, so the change reaches Checkout through dispatch.
    expect(data.dependents.map((x: any) => [x.qualified_name, x.depth])).toEqual([['Orders.Core.IOrderService.PlaceOrder', 1], ['Orders.Core.OrderService.PlaceOrder', 1], ['Orders.Core.Checkout.Buy', 2]])
    expect(data.totals.by_project).toEqual([{ name: 'Orders.Core', count: 3 }])
  })

  it('an implementation is reached by callers of the interface member it implements', () => {
    const data = tool(dataDir, 'analyze_impact', { subject_ids: [symbolId(dataDir, 'Orders.Core.OrderService.PlaceOrder')] }).data as any
    expect(data.dependents.map((x: any) => [x.qualified_name, x.depth])).toEqual([['Orders.Core.Checkout.Buy', 1]])
  })
})
