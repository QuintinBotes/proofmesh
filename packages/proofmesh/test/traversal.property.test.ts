import Database from 'better-sqlite3'
import fc from 'fast-check'
import { MultiDirectedGraph } from 'graphology'
import { describe, expect, it } from 'vitest'
import { SqliteEdges, trace, type EdgeSource } from '../src/meshstore/traversal.js'

type E = { src: string; dst: string; assertion_id: string }
const memory = (edges: E[]): EdgeSource => ({
  outEdges: (nodes) => edges.filter((e) => nodes.includes(e.src)).sort((a, b) => (a.src + a.dst + a.assertion_id < b.src + b.dst + b.assertion_id ? -1 : 1)),
})

/** Independent oracle: graphology graph, BFS distances, then every shortest path through the distance DAG. */
function reference(edges: E[], source: string, target: string, maxDepth: number) {
  const g = new MultiDirectedGraph()
  for (const e of edges) { g.mergeNode(e.src); g.mergeNode(e.dst); g.addDirectedEdgeWithKey(e.assertion_id, e.src, e.dst) }
  g.mergeNode(source); g.mergeNode(target)
  const dist = new Map<string, number>([[source, 0]])
  let frontier = [source]
  for (let depth = 0; frontier.length && depth < maxDepth && !dist.has(target); depth++) {
    const next: string[] = []
    for (const n of frontier) for (const m of g.outNeighbors(n)) if (!dist.has(m)) { dist.set(m, depth + 1); next.push(m) }
    frontier = next
  }
  const found = dist.has(target)
  const paths: string[][] = []
  const walk = (node: string, acc: string[]) => {
    if (node === source) { paths.push([source, ...acc]); return }
    for (const key of g.inEdges(node)) {
      const prev = g.source(key)
      if (dist.get(prev) === dist.get(node)! - 1) walk(prev, [node, ...acc])
    }
  }
  if (found && source !== target) walk(target, [])
  // FR1500 a frontier node with no out-edge was searched to the end, so only the others are where the depth limit stopped the search.
  const open = found ? [] : frontier.filter((n) => g.outDegree(n) > 0)
  return { found, paths: paths.map((p) => p.join('>')).sort(), horizon: open.sort() }
}

const graphArb = fc.integer({ min: 2, max: 9 }).chain((n) =>
  fc.tuple(
    fc.constant(n),
    fc.array(fc.tuple(fc.integer({ min: 0, max: n - 1 }), fc.integer({ min: 0, max: n - 1 })), { maxLength: 25 }),
    fc.integer({ min: 0, max: n - 1 }), fc.integer({ min: 0, max: n - 1 }), fc.integer({ min: 1, max: 6 }),
  ))

describe('AC17 traversal matches an independent graphology oracle', () => {
  it('on 200 generated graphs: paths, stop reason, and horizon agree', () => {
    fc.assert(fc.property(graphArb, ([, pairs, s, t, depth]) => {
      const edges = pairs.filter(([a, b]) => a !== b).map(([a, b], i) => ({ src: `n${a}`, dst: `n${b}`, assertion_id: `as_${i}` }))
      const got = trace(memory(edges), { source: `n${s}`, target: `n${t}`, types: ['calls'], resolutions: ['resolved'], maxDepth: depth, maxRows: 1000, deadline: Date.now() + 5000 })
      const ref = reference(edges, `n${s}`, `n${t}`, depth)
      if (s === t) return
      // Parallel edges between the same nodes are distinct assertions, so compare node sequences as a set.
      expect([...new Set(got.paths.map((p) => p.nodes.join('>')))].sort()).toEqual([...new Set(ref.paths)])
      expect(got.stopped_by === 'max_depth').toBe(ref.horizon.length > 0)
      expect(got.horizon.map((h) => h.id)).toEqual(ref.horizon)
    }), { numRuns: 200, seed: 7 })
  })

  it('the SQLite edge source returns exactly what the in-memory source returns', () => {
    fc.assert(fc.property(graphArb, ([n, pairs]) => {
      const edges = pairs.filter(([a, b]) => a !== b).map(([a, b], i) => ({ src: `n${a}`, dst: `n${b}`, assertion_id: `as_${i}` }))
      const db = new Database(':memory:')
      db.exec('create table edge (src text, type text, dst text, resolution text, assertion_id text)')
      const ins = db.prepare("insert into edge values (?, 'calls', ?, 'resolved', ?)")
      for (const e of edges) ins.run(e.src, e.dst, e.assertion_id)
      const nodes = Array.from({ length: n }, (_, i) => `n${i}`)
      const key = (e: E) => e.src + '|' + e.dst + '|' + e.assertion_id
      expect(new SqliteEdges(db).outEdges(nodes, ['calls'], ['resolved']).map(key).sort()).toEqual(memory(edges).outEdges(nodes, [], []).map(key).sort())
      db.close()
    }), { numRuns: 50, seed: 11 })
  })

  it('FR020 max_rows truncates paths and reports it', () => {
    const edges = [{ src: 'a', dst: 'b', assertion_id: 'as_1' }, { src: 'a', dst: 'c', assertion_id: 'as_2' }, { src: 'b', dst: 'd', assertion_id: 'as_3' }, { src: 'c', dst: 'd', assertion_id: 'as_4' }]
    const r = trace(memory(edges), { source: 'a', target: 'd', types: ['calls'], resolutions: ['resolved'], maxDepth: 5, maxRows: 1, deadline: Date.now() + 5000 })
    expect(r.paths).toHaveLength(1)
    expect(r.stopped_by).toBe('max_rows')
  })

  it('FR1500 the horizon holds only frontier nodes with an edge left; the others count as expanded, and a frontier with none is no stop', () => {
    const at = (edges: E[]) => trace(memory(edges), { source: 'a', target: 'z', types: ['calls'], resolutions: ['resolved'], maxDepth: 1, maxRows: 10, deadline: Date.now() + 5000 })
    const leaf = at([{ src: 'a', dst: 'b', assertion_id: 'as_1' }])
    expect([leaf.stopped_by, leaf.horizon, leaf.expanded]).toEqual([null, [], ['a', 'b']])
    const mixed = at([{ src: 'a', dst: 'b', assertion_id: 'as_1' }, { src: 'a', dst: 'c', assertion_id: 'as_2' }, { src: 'c', dst: 'd', assertion_id: 'as_3' }])
    expect([mixed.stopped_by, mixed.horizon, mixed.expanded]).toEqual(['max_depth', [{ id: 'c', unexplored_edges: 1 }], ['a', 'b']])
  })

  it('FR020 an expired deadline stops the search with a horizon', () => {
    const edges = [{ src: 'a', dst: 'b', assertion_id: 'as_1' }]
    const r = trace(memory(edges), { source: 'a', target: 'z', types: ['calls'], resolutions: ['resolved'], maxDepth: 5, maxRows: 10, deadline: Date.now() - 1 })
    expect(r.stopped_by).toBe('timeout')
    expect(r.horizon.map((h) => h.id)).toEqual(['a'])
  })
})
