import type Database from 'better-sqlite3'
import { assertionKey, cmp, nodeKey } from './order.js'

export type TraceOptions = {
  source: string
  target: string
  types: string[]
  resolutions: string[]
  maxDepth: number
  maxRows: number
  deadline: number
  /** Where a node or assertion sits, so ties between paths break on location rather than id; the id itself when omitted. */
  rank?: (id: string) => string
}

export type Level = { depth: number; frontier: number; expanded_edges: number }
export type TraceResult = {
  paths: Array<{ nodes: string[]; assertions: string[] }>
  levels: Level[]
  stopped_by: null | 'max_depth' | 'max_rows' | 'timeout'
  horizon: Array<{ id: string; unexplored_edges: number }>
  expanded: string[]
  explored: Array<{ from: string; to: string; assertion_id: string; depth: number }>
  explored_truncated: boolean
}

/** Minimal graph access, so the same search runs over SQLite and over the in-memory test oracle. */
export interface EdgeSource {
  outEdges(nodes: string[], types: string[], resolutions: string[]): Array<{ src: string; dst: string; assertion_id: string }>
}

/** Relationship types a path follows in both directions: a call to an interface or virtual member may dispatch to any implementation. */
export const DISPATCH_TYPES = ['implements', 'overrides'] as const
export class SqliteEdges implements EdgeSource {
  /** `extra` adds edges the `edge` table does not hold, such as candidate calls, for the nodes of a level. */
  constructor(private readonly db: Database.Database, private readonly extra?: (nodes: string[]) => Array<{ src: string; dst: string; assertion_id: string }>) {}
  outEdges(nodes: string[], types: string[], resolutions: string[]) {
    const out: Array<{ src: string; dst: string; assertion_id: string }> = []
    const tp = types.map(() => '?').join(','), rp = resolutions.map(() => '?').join(',')
    const dispatch = types.filter((t) => (DISPATCH_TYPES as readonly string[]).includes(t))
    for (let i = 0; i < nodes.length; i += 500) {
      const chunk = nodes.slice(i, i + 500), cp = chunk.map(() => '?').join(',')
      out.push(...(this.db.prepare(`select src, dst, assertion_id from edge where src in (${cp}) and type in (${tp}) and resolution in (${rp})`).all(...chunk, ...types, ...resolutions) as typeof out))
      // The implementation reached from the member it implements or overrides: the edge read backwards.
      if (dispatch.length) out.push(...(this.db.prepare(`select dst as src, src as dst, assertion_id from edge where dst in (${cp}) and type in (${dispatch.map(() => '?').join(',')}) and resolution in (${rp})`).all(...chunk, ...dispatch, ...resolutions) as typeof out))
    }
    if (this.extra) out.push(...this.extra(nodes))
    const n = (id: string) => nodeKey(this.db, id), a = (id: string) => assertionKey(this.db, id)
    return out.sort((x, y) => cmp(n(x.src), n(y.src)) || cmp(n(x.dst), n(y.dst)) || cmp(a(x.assertion_id), a(y.assertion_id)) || cmp(x.src, y.src) || cmp(x.dst, y.dst) || cmp(x.assertion_id, y.assertion_id))
  }
}

/** Level-synchronous breadth-first search for all shortest paths, with budgets checked between levels. */
export function trace(edges: EdgeSource, o: TraceOptions): TraceResult {
  const levels: Level[] = []
  const parents = new Map<string, Array<{ from: string; assertion: string }>>()
  const seen = new Set<string>([o.source])
  const expanded: string[] = []
  const explored: TraceResult['explored'] = []
  let exploredTruncated = false
  let frontier = [o.source]
  let found = o.source === o.target
  let stopped: TraceResult['stopped_by'] = null
  let depth = 0
  while (!found && frontier.length) {
    if (depth >= o.maxDepth) { stopped = 'max_depth'; break }
    if (Date.now() > o.deadline) { stopped = 'timeout'; break }
    const out = edges.outEdges(frontier, o.types, o.resolutions)
    expanded.push(...frontier)
    depth++
    levels.push({ depth, frontier: frontier.length, expanded_edges: out.length })
    const next: string[] = []
    const discoveredNow = new Set<string>()
    for (const e of out) {
      if (seen.has(e.dst) && !discoveredNow.has(e.dst)) continue
      if (!discoveredNow.has(e.dst)) { discoveredNow.add(e.dst); next.push(e.dst); seen.add(e.dst) }
      if (explored.length < 500) explored.push({ from: e.src, to: e.dst, assertion_id: e.assertion_id, depth })
      else exploredTruncated = true
      const list = parents.get(e.dst) ?? []
      list.push({ from: e.src, assertion: e.assertion_id })
      parents.set(e.dst, list)
    }
    if (discoveredNow.has(o.target)) found = true
    frontier = next
  }
  const paths: TraceResult['paths'] = []
  if (found) {
    const build = (node: string, nodes: string[], assertions: string[]) => {
      if (paths.length > o.maxRows) return
      if (node === o.source) { paths.push({ nodes: [node, ...nodes], assertions: [...assertions] }); return }
      for (const p of parents.get(node) ?? []) build(p.from, [node, ...nodes], [p.assertion, ...assertions])
    }
    build(o.target, [], [])
    const rank = o.rank ?? ((id: string) => id)
    const route = (p: TraceResult['paths'][number]) => `${p.nodes.map(rank).join('>')}|${p.assertions.map(rank).join('>')}`
    paths.sort((a, b) => cmp(route(a), route(b)) || cmp(a.nodes.join('>'), b.nodes.join('>')) || cmp(a.assertions.join('>'), b.assertions.join('>')))
    if (paths.length > o.maxRows) { paths.length = o.maxRows; stopped = 'max_rows' }
  }
  const horizon = stopped === 'max_depth' || stopped === 'timeout'
    ? [...frontier].sort((a, b) => cmp((o.rank ?? ((id: string) => id))(a), (o.rank ?? ((id: string) => id))(b)) || cmp(a, b)).map((id) => ({ id, unexplored_edges: edges.outEdges([id], o.types, o.resolutions).length }))
    : []
  return { paths, levels, stopped_by: stopped, horizon, expanded, explored, explored_truncated: exploredTruncated }
}
