import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { inferredSql } from './basis.js'
import { isTestPath } from './tests.js'

type Graph = Map<number, number>[]
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
function add<K>(counts: Map<K, number>, key: K, n: number) {
  counts.set(key, (counts.get(key) ?? 0) + n)
}
function mostCommon(counts: Map<string, number>) {
  return [...counts].sort(([a, x], [b, y]) => y - x || compare(a, b))[0]?.[0]
}

/** Each undirected link appears twice, including both ends of a contracted self-loop. */
function communities(initial: Graph, resolution: number) {
  let graph = initial
  let members = graph.map((_, i) => [i])
  for (;;) {
    const degree = graph.map(neighbors => [...neighbors.values()].reduce((sum, w) => sum + w, 0))
    const total = degree.reduce((sum, d) => sum + d, 0)
    if (!total) return members
    const volume = degree.slice()
    const owner = graph.map((_, i) => i)
    let moved: boolean
    do {
      moved = false
      for (const [i, neighbors] of graph.entries()) {
        const previous = owner[i]!, d = degree[i]!
        const adjacent = new Map<number, number>()
        for (const [j, w] of neighbors) if (j !== i) add(adjacent, owner[j]!, w)
        volume[previous] = volume[previous]! - d
        const gain = (c: number) => (adjacent.get(c) ?? 0) - resolution * (volume[c]! / total) * d
        let best = previous, score = gain(previous)
        for (const c of adjacent.keys()) {
          const next = gain(c)
          if (next > score + 1e-10 || (next === score && best !== previous && c < best)) {
            best = c
            score = next
          }
        }
        owner[i] = best
        volume[best] = volume[best]! + d
        if (best !== previous) moved = true
      }
    } while (moved)
    const ids = new Map<number, number>()
    const compact = owner.map(c => {
      if (!ids.has(c)) ids.set(c, ids.size)
      return ids.get(c)!
    })
    if (ids.size === graph.length) return members
    const folded: Graph = Array.from(ids, () => new Map())
    const joined: number[][] = Array.from(ids, () => [])
    for (const [i, neighbors] of graph.entries()) {
      const c = compact[i]!
      for (const m of members[i]!) joined[c]!.push(m)
      for (const [j, w] of neighbors) add(folded[c]!, compact[j]!, w)
    }
    graph = folded
    members = joined
  }
}

type CodeFile = { id: string; path: string; key: string; symbols: number }
type Member = { path: string; internal_degree: number; generated?: boolean }
type Cluster = { id: string; label: string; files: number; symbols: number; internal_edges: number; external_edges: number; cohesion: number }
type Link = { src: string; dst: string; weight: number }
type Options = { resolution?: number; observed_only?: boolean; include_tests?: boolean }
const types = "('imports','calls','references','inherits','implements')"

function partition(db: Database.Database, resolution: number, observed: boolean, includeTests: boolean) {
  const files = (db.prepare(`select f.id, f.path, coalesce(min(case when s.kind='module' then s.stable_key end), f.path) as key,
    count(case when s.kind<>'module' then 1 end) as symbols from file f left join symbol s on s.file_id=f.id
    where f.disposition='indexed' group by f.id order by key, f.path`).all() as CodeFile[]).filter(f => includeTests || !isTestPath(f.path))
  const nodes = new Map(files.map((f, i) => [f.id, i]))
  const symbols = db.prepare('select id, file_id, kind, qualified_name as name, stable_key from symbol').all() as Array<{ id: string; file_id: string; kind: string; name: string; stable_key: string }>
  const byId = new Map(symbols.map(s => [s.id, s]))
  const symbolDegree = new Map<string, number>()
  const graph: Graph = files.map(() => new Map())
  const counts: Graph = files.map(() => new Map())
  const sql = `select a.source_id as src, a.target_id as dst, case when ${inferredSql()} then 1 else 2 end as weight
    from assertion a where a.resolution='resolved' and a.type in ${types}
    ${observed ? '' : `union all select a.source_id, c.symbol_id, 1 from assertion_candidate c join assertion a on a.id=c.assertion_id
      where a.resolution in ('candidate','ambiguous') and a.type in ${types}`}`
  for (const { src, dst, weight } of db.prepare(sql).iterate() as Iterable<Link>) {
    if (observed && weight === 1) continue
    const a = nodes.get(byId.get(src)?.file_id ?? src), b = nodes.get(byId.get(dst)?.file_id ?? dst)
    if (a === undefined || b === undefined || a === b) continue
    for (const key of [src, dst]) if (byId.has(key)) add(symbolDegree, key, weight)
    add(graph[a]!, b, weight); add(graph[b]!, a, weight)
    add(counts[a]!, b, 1); add(counts[b]!, a, 1)
  }
  const degrees = graph.map(m => m.size).sort((a, b) => b - a)
  const threshold = Math.max(30, degrees[Math.max(0, Math.ceil(files.length / 100) - 1)] ?? 0)
  const tiny = files.length < 20
  const shared = files.flatMap((f, i) => graph[i]!.size >= threshold ? [{ path: f.path, degree: graph[i]!.size }] : [])
  const retained = files.map((_, i) => i).filter(i => graph[i]!.size < threshold)
  const local = new Map(retained.map((i, j) => [i, j]))
  const trimmed = retained.map(i => new Map([...graph[i]!].filter(([j]) => local.has(j)).map(([j, w]) => [local.get(j)!, w])))
  const sets = tiny ? (files.length ? [retained] : []) : communities(trimmed, resolution).map(group => group.map(j => retained[j]!))
  const clusters: Cluster[] = []
  const byPath = new Map<string, Cluster>()
  const members = new Map<string, Member[]>()
  const boundaries = new Map<string, Map<string, number>>()
  const leaders = new Map<number, typeof symbols[number]>()
  for (const s of symbols) {
    const i = nodes.get(s.file_id)
    if (i === undefined || s.kind === 'module') continue
    const prev = leaders.get(i)
    const score = symbolDegree.get(s.id) ?? 0
    if (!prev || score > (symbolDegree.get(prev.id) ?? 0) || (score === (symbolDegree.get(prev.id) ?? 0) && compare(s.stable_key, prev.stable_key) < 0)) leaders.set(i, s)
  }
  for (const set of sets) {
    set.sort((a, b) => a - b)
    const id = createHash('sha256').update(JSON.stringify([files[set[0]!]!.key, resolution])).digest('hex')
    const parts = new Map<string, number>()
    const groupSymbols = set.flatMap(i => leaders.has(i) ? [leaders.get(i)!] : [])
    groupSymbols.sort((a, b) => (symbolDegree.get(b.id) ?? 0) - (symbolDegree.get(a.id) ?? 0) || compare(a.stable_key, b.stable_key))
    for (const i of set) for (const p of new Set(files[i]!.path.split('/').slice(0, -1))) add(parts, p, 1)
    const label = [mostCommon(parts), groupSymbols[0]?.name].filter(Boolean).join(' / ') || files[set[0]!]!.path
    const cluster = { id, label, files: set.length, symbols: 0, internal_edges: 0, external_edges: 0, cohesion: 0 }
    clusters.push(cluster)
    boundaries.set(id, new Map())
    members.set(id, [])
    for (const i of set) {
      const f = files[i]!
      byPath.set(f.path, cluster)
      cluster.symbols += f.symbols
    }
  }
  for (const i of retained) {
    const f = files[i]!, c = byPath.get(f.path)!
    let internal = 0
    for (const [j, n] of counts[i]!) {
      const other = byPath.get(files[j]!.path)
      if (other === c) {
        internal += n
        if (i < j) c.internal_edges += n
      } else {
        c.external_edges += n
        add(boundaries.get(c.id)!, other?.id ?? 'shared', n)
      }
    }
    members.get(c.id)!.push({ path: f.path, internal_degree: internal })
  }
  for (const c of clusters) {
    c.cohesion = c.internal_edges / (c.internal_edges + c.external_edges || 1)
    members.get(c.id)!.sort((a, b) => b.internal_degree - a.internal_degree || compare(a.path, b.path))
  }
  clusters.sort((a, b) => b.files - a.files || compare(a.id, b.id))
  return { clusters, byPath, members, boundaries, shared, tiny, singletons: clusters.filter(c => c.files === 1).length }
}

const cache = new Map<string, ReturnType<typeof partition>>()
export function fileClusters(db: Database.Database, snapshot: string, options: Options = {}) {
  const { resolution = 1, observed_only = false, include_tests = true } = options
  const key = JSON.stringify([db.name, snapshot, resolution, observed_only, include_tests])
  let result = cache.get(key)
  if (!result) {
    result = partition(db, resolution, observed_only, include_tests)
    if (cache.size >= 8) cache.delete(cache.keys().next().value!)
    cache.set(key, result)
  }
  return result
}
