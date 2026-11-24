import { beforeAll, describe, expect, it } from 'vitest'
import { SIDE_LIMIT, toNeighbourhood, type Focus, type RelationshipsEnvelope } from '../src/explore'
import { indexedDataDir, symbolId, tool } from '../../../packages/proofmesh/test/helpers.js'

let d: string
beforeAll(async () => {
  ;({ dataDir: d } = await indexedDataDir())
})

describe('Explore: a symbol and its neighbourhood', () => {
  it('callers sit on the left, callees on the right, external targets marked, the focus in the middle', () => {
    const id = symbolId(d, 'packages/billing/src/invoice:invoiceTotal')
    const focus = tool(d, 'get_symbol', { symbol_id: id }).data.symbol as Focus
    const env = tool(d, 'get_relationships', { subject_id: id, direction: 'both', include_external: true }) as unknown as RelationshipsEnvelope
    const scene = toNeighbourhood(env, focus)
    const byLabel = (a: { label: string }, b: { label: string }) => (a.label < b.label ? -1 : 1)
    expect(scene.nodes.map((n) => ({ label: n.label, role: n.role, x: n.x })).sort(byLabel)).toEqual([
      { label: 'Array.reduce', role: 'external', x: 1 },
      { label: 'formatAmount', role: 'callee', x: 1 },
      { label: 'handleInvoice', role: 'caller', x: -1 },
      { label: 'invoiceTotal', role: 'focus', x: 0 },
    ])
    const label = (nodeId: string) => scene.nodes.find((n) => n.id === nodeId)!.label
    expect(scene.edges.map((e) => [label(e.source), label(e.target), e.style]).sort()).toEqual([
      ['handleInvoice', 'invoiceTotal', 'resolved'],
      ['invoiceTotal', 'Array.reduce', 'resolved_external'],
      ['invoiceTotal', 'formatAmount', 'resolved'],
    ])
    expect(scene.conclusion).toBe('invoiceTotal: 1 incoming, 2 outgoing. Click a node to explore from it.')
  })
})

describe('A11 B23 two relationships of different kinds between the same symbols are both drawn', () => {
  it('a neighbour reached by a call and by a framework rule gets one node and two edges', () => {
    const focus: Focus = { id: 'f', kind: 'method', name: 'Handle', qualified_name: 'Handle', path: 'a.cs', start_line: 1 }
    const other = { kind: 'symbol', symbol_kind: 'class', id: 'o', name: 'Client', qualified_name: 'Client', path: 'b.cs', start_line: 1 }
    const rel = (assertion_id: string, type: string, origin: string) => ({ assertion_id, type, direction: 'out' as const, resolution: 'resolved', origin, other, site: { path: 'a.cs', start_line: 3 }, reason: null, detail: origin === 'framework_adapter' ? { rule: 'di' } : null })
    const env = { data: { relationships: [rel('a1', 'calls', 'semantic_resolver'), rel('a2', 'injects', 'framework_adapter')], boundaries: [], totals: { in: 0, out: 2 } }, completion: { truncated: false } } as RelationshipsEnvelope
    const scene = toNeighbourhood(env, focus)
    expect(scene.nodes.map((n) => n.id)).toEqual(['f', 'o'])
    expect(scene.edges.map((e) => [e.assertionId, e.style, e.label])).toEqual([['a1', 'resolved', undefined], ['a2', 'framework', 'injects · di']])
  })
})

describe('A11 B1 FR058 a hub shows how many neighbours it does not draw', () => {
  it('draws at most the side limit and counts the rest on a badge and in the conclusion', () => {
    const focus: Focus = { id: 'f', kind: 'method', name: 'Hub', qualified_name: 'Hub', path: 'a.cs', start_line: 1 }
    const callee = (i: number) => ({ assertion_id: `a${i}`, type: 'calls', direction: 'out' as const, resolution: 'resolved', origin: 'semantic_resolver', other: { kind: 'symbol', symbol_kind: 'method', id: `o${i}`, name: `m${i}`, qualified_name: `m${i}`, path: 'b.cs', start_line: i }, site: { path: 'a.cs', start_line: i }, reason: null, detail: null })
    const env = { data: { relationships: Array.from({ length: 30 }, (_, i) => callee(i)), boundaries: [], totals: { in: 0, out: 70 } }, completion: { truncated: true } } as RelationshipsEnvelope
    const scene = toNeighbourhood(env, focus)
    expect(scene.nodes.filter((n) => n.role === 'callee')).toHaveLength(SIDE_LIMIT)
    expect(scene.badges).toEqual([{ nodeId: 'f', text: '+46 relationships not drawn' }])
    expect(scene.conclusion).toBe('Hub: 0 incoming, 70 outgoing; 46 not drawn, the table lists what was returned. Click a node to explore from it.')
  })
})
