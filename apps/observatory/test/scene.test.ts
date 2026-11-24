import { beforeAll, describe, expect, it } from 'vitest'
import { FRAMEWORK_TYPES, glyph, toScene, type TraceEnvelope } from '../src/scene'
import { visible } from '../src/visible'
import { fixtureRepo, indexedDataDir, symbolId, tool } from '../../../packages/proofmesh/test/helpers.js'

let d: string
let id: (qn: string) => string
const trace = (s: string, t: string, depth?: number) => {
  const source = id(s), target = id(t)
  const env = tool(d, 'trace_paths', { source_id: source, target_id: target, ...(depth ? { limits: { max_depth: depth } } : {}) }) as unknown as TraceEnvelope
  return { scene: toScene(env, source, target), source, target }
}
beforeAll(async () => {
  ;({ dataDir: d } = await indexedDataDir())
  id = (qn) => symbolId(d, qn)
})

describe('AC27 envelope to scene', () => {
  it('a found path becomes three nodes and two resolved edges, in search order', () => {
    const { scene } = trace('packages/api/src/handler:handleInvoice', 'packages/format/src/currency:formatAmount')
    expect(scene.nodes.map((n) => [n.qualifiedName, n.role, n.depth])).toEqual([
      ['packages/api/src/handler:handleInvoice', 'source', 0],
      ['packages/billing/src/invoice:invoiceTotal', 'path', 1],
      ['packages/format/src/currency:formatAmount', 'target', 2],
    ])
    expect(scene.nodes.map((n) => n.x)).toEqual([...scene.nodes.map((n) => n.x)].sort((a, b) => a - b))
    expect(scene.edges.map((e) => [e.style, e.depth])).toEqual([['resolved', 1], ['resolved', 2]])
    expect(scene.badges).toEqual([])
    expect(scene.conclusion).toBe('Path found: 2 steps.')
  })

  it('a depth-limited search shows the edge it explored, a horizon badge, and an unreached target, with no invented edges', () => {
    const { scene } = trace('packages/api/src/handler:handleInvoice', 'packages/format/src/currency:formatAmount', 1)
    expect(scene.nodes.map((n) => [n.qualifiedName, n.role])).toEqual([
      ['packages/api/src/handler:handleInvoice', 'source'],
      ['packages/billing/src/invoice:invoiceTotal', 'horizon'],
      ['packages/format/src/currency:formatAmount', 'unreached-target'],
    ])
    expect(scene.edges.map((e) => [e.style, scene.nodes.find((n) => n.id === e.source)!.label, scene.nodes.find((n) => n.id === e.target)!.label])).toEqual([['explored', 'handleInvoice', 'invoiceTotal']])
    expect(scene.badges.map((b) => b.text)).toEqual(['+1 unexplored · stopped by max_depth'])
    expect(scene.conclusion).toContain('this is not evidence that no path exists')
  })

  it('an unresolved boundary becomes a frayed stub from the calling symbol', () => {
    const { scene, source } = trace('packages/api/src/handler:dispatch', 'packages/legacy/src/format:formatAmount')
    expect(scene.stubs.map((s) => [s.fromId === source, s.reason, s.line])).toEqual([[true, 'dynamic_element_access', 11]])
    expect(scene.edges.map((e) => e.style)).toEqual(['unresolved'])
    expect(scene.conclusion).toBe('No resolved path. Unresolved call sites in the explored region could lead to the target.')
  })

  it('A11 B14 labels on a traced path never collide: columns leave room for a label, and stubs sit between rows', () => {
    // The shape of a trace in a large repository: one source, a column of eight explored neighbours and the target, two boundaries from the source.
    const neighbours = Array.from({ length: 8 }, (_, i) => `n${i}`)
    const env = {
      data: {
        conclusion: 'path_found', paths: [{ nodes: ['s', 't'], assertions: ['a0'] }],
        search: { levels: [{ depth: 1 }], stopped_by: null, horizon: [], explored: neighbours.map((n, i) => ({ from: 's', to: n, assertion_id: `x${i}`, depth: 1 })) },
        boundaries: [
          { assertion_id: 'b0', reason: 'dependency_missing', path: 'p', line: 69, from_id: 's' }, { assertion_id: 'b1', reason: 'ambiguous', path: 'p', line: 63, from_id: 's' },
          { assertion_id: 'b2', reason: 'unknown_name', path: 'p', line: 3, from_id: 'n0' }, { assertion_id: 'b3', reason: 'unknown_name', path: 'p', line: 4, from_id: 'n0' },
          { assertion_id: 'b4', reason: 'untyped_receiver', path: 'p', line: 5, from_id: 'n1' },
        ],
        nodes: Object.fromEntries(['s', 't', ...neighbours].map((n) => [n, { kind: 'method', name: `${n}WithAVeryLongMethodNameAsync`, qualified_name: n, path: 'p', start_line: 1 }])),
      },
      limits: { applied: { max_depth: 6 } },
    } as unknown as TraceEnvelope
    const nodes = toScene(env, 's', 't').nodes
    expect(nodes.filter((n) => n.role === 'stub')).toHaveLength(5)
    for (const a of nodes) for (const b of nodes) {
      if (a === b) continue
      expect(Math.abs(a.x - b.x) >= 3 || Math.abs(a.y - b.y) >= 0.4, `${a.label} and ${b.label} overlap`).toBe(true)
    }
  })

  it('FR058 explored symbols beyond what is drawn are counted on a badge and in the conclusion, never dropped silently', () => {
    const neighbours = Array.from({ length: 45 }, (_, i) => `n${i}`)
    const env = {
      data: {
        conclusion: 'no_path_within_bounds', paths: [],
        search: { levels: [{ depth: 1 }], stopped_by: 'max_depth', horizon: [], explored: neighbours.map((n, i) => ({ from: 's', to: n, assertion_id: `x${i}`, depth: 1 })) },
        boundaries: [], nodes: Object.fromEntries(['s', 't', ...neighbours].map((n) => [n, { kind: 'method', name: n, qualified_name: n, path: 'p', start_line: 1 }])),
      },
      limits: { applied: { max_depth: 1 } },
    } as unknown as TraceEnvelope
    const scene = toScene(env, 's', 't')
    expect(scene.nodes.filter((n) => n.role === 'explored')).toHaveLength(40)
    expect(scene.badges).toEqual([{ nodeId: 's', text: '+5 explored symbols not drawn' }])
    expect(scene.conclusion).toBe('No path within depth 1. The search stopped at the depth limit; this is not evidence that no path exists. 5 explored symbols are not drawn.')
  })

  it('makes bidirectional and invisible characters visible', () => {
    expect(visible('a‮b​c')).toBe('a⟨U+202E⟩b⟨U+200B⟩c')
  })
})

describe('FR016 framework relationships in the Trace view', () => {
  it('an entity-to-table mapping draws as a framework edge labelled with its rule, and the table carries its glyph', async () => {
    const { dataDir } = await indexedDataDir(fixtureRepo('cs-ef'))
    const find = (text: string, kind: string) => (tool(dataDir, 'find_symbols', { text }).data.symbols as Array<{ id: string; kind: string }>).find((x) => x.kind === kind)!.id
    const source = find('Order', 'class'), target = find('Orders', 'table')
    const env = tool(dataDir, 'trace_paths', { source_id: source, target_id: target, types: ['calls', ...FRAMEWORK_TYPES] }) as unknown as TraceEnvelope
    const scene = toScene(env, source, target)
    expect(scene.nodes.map((n) => [n.label, n.role])).toEqual([['Order', 'source'], ['▦ Orders', 'target']])
    expect(scene.edges.map((e) => [e.style, e.label])).toEqual([['framework', 'maps_to · dbset_convention']])
  })

  it('calls alone never cross a framework rule', async () => {
    const { dataDir } = await indexedDataDir(fixtureRepo('cs-ef'))
    const find = (text: string, kind: string) => (tool(dataDir, 'find_symbols', { text }).data.symbols as Array<{ id: string; kind: string }>).find((x) => x.kind === kind)!.id
    const env = tool(dataDir, 'trace_paths', { source_id: find('Order', 'class'), target_id: find('Orders', 'table') }) as unknown as TraceEnvelope
    expect(env.data.conclusion).toBe('no_path_exhaustive')
  })
})

describe('symbol glyphs', () => {
  it('only framework kinds get a glyph; names of Object.prototype members are plain kinds', () => {
    expect([glyph('table'), glyph('constructor'), glyph('toString'), glyph('method'), glyph(undefined)]).toEqual(['▦ ', '', '', '', ''])
  })
})
