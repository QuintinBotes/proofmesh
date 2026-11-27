import { beforeAll, describe, expect, it } from 'vitest'
import { runTool } from '../src/query/tools.js'
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

  it('FR860 a compact row reached through dispatch alone says dispatch, at its declaration, as its lean row does', () => {
    const id = (tool(dataDir, 'find_symbols', { text: 'PriceCalculator', kinds: ['class'] }).data.symbols as Array<{ id: string }>)[0]!.id
    const rows = (tool(dataDir, 'analyze_impact', { subject_ids: [id], envelope: 'compact' }).data as any).dependents.map((x: any) => `${x.path}:${x.line} depth=${x.depth} ${x.relationship}`)
    const lean = runTool(dataDir, 'analyze_impact', { subject_ids: [id], envelope: 'lean' }).text!.split('\n').filter((l) => !l.startsWith('# ')).map((l) => l.split(' ').slice(1).join(' '))
    expect(rows).toEqual(lean)
    expect(rows.some((r: string) => r.endsWith(' dispatch'))).toBe(true)
  })
})

describe('FR860 FR861 analyze_impact compact rows carry the id, the site line and the relationship, and a cut answer its uncut total (#159)', () => {
  const compact = (limits?: Record<string, number>) => tool(d, 'analyze_impact', { subject_ids: [symbolId(d, 'packages/format/src/currency:formatAmount')], envelope: 'compact', ...(limits ? { limits } : {}) })

  it('FR860 each compact row has id, line and relationship: the line of the call that first reached it, and its type', () => {
    const env = compact()
    expect((env.data as any).dependents.map((x: any) => [x.id, x.name, x.path, x.line, x.relationship])).toEqual([
      [symbolId(d, 'packages/billing/src/invoice:invoiceTotal'), 'invoiceTotal', 'packages/billing/src/invoice.ts', 9, 'calls'],
      [symbolId(d, 'packages/api/src/handler:handleInvoice'), 'handleInvoice', 'packages/api/src/handler.ts', 5, 'calls'],
    ])
    // The same line and relationship as each dependent's lean row.
    const lean = runTool(d, 'analyze_impact', { subject_ids: [symbolId(d, 'packages/format/src/currency:formatAmount')], envelope: 'lean' }).text!.split('\n').slice(1, 3)
    expect(lean).toEqual(['invoiceTotal packages/billing/src/invoice.ts:9 depth=1 calls', 'handleInvoice packages/api/src/handler.ts:5 depth=2 calls'])
    expect(env.completion).toEqual({ truncated: false, stop_reasons: [], timed_out: false, next_cursor: null, total: 2 })
  })

  it('FR861 cut at max_rows 1, the answer says truncated and its uncut total beside it', () => {
    const env = compact({ max_rows: 1 })
    expect((env.data as any).dependents.map((x: any) => x.name)).toEqual(['invoiceTotal'])
    expect(env.completion).toMatchObject({ truncated: true, stop_reasons: ['max_rows'], total: 2 })
  })
})
