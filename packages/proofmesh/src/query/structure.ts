// Dead code, import cycles, entry points and hubs, answered from the resolved relationships of a sealed snapshot (#34, FR940 to FR949).
// Every query reads the snapshot only: manifests are read from the captured file content, never from the working tree.
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { EvidenceStore } from '../evidence/store.js'
import { isTestPath } from './tests.js'

/** Relationship types by which one symbol uses another. `contains` and `overrides` are structure, not use. */
export const USE_TYPES = ['calls', 'references', 'inherits', 'implements', 'imports', 'injects', 'renders', 'uses_hook', 'uses_context', 'provides_context'] as const
/** Relationship types by which a framework, not code, reaches a symbol: a route, a job, a handler or a registration. */
const FRAMEWORK_TYPES = ['exposes', 'runs', 'handles', 'registered_as', 'dispatches_to', 'consumes', 'listens_on'] as const
const marks = (n: number) => Array(n).fill('?').join(', ')
const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]) }
const prefixLike = (p: string | undefined) => (p ? `${p.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : '%')
/** A symbol nested in another symbol of its file (a member, a local); a namespace or module does not count as nesting. */
const NESTED_SQL = "exists (select 1 from symbol t where t.file_id = s.file_id and t.id <> s.id and t.kind not in ('module', 'namespace', 'project', 'package') and t.start_byte <= s.start_byte and t.end_byte >= s.end_byte and (t.start_byte < s.start_byte or t.end_byte > s.end_byte))"

// ---------- package manifests ----------
export type ManifestEntry = { kind: 'main' | 'bin' | 'exports'; manifest: string; line: number; target: string; file: string | null }

/** The entry files the indexed package.json files name in main, module, types, exports and bin, mapped to indexed files where one matches. */
export function manifestEntries(db: Database.Database, store: EvidenceStore): ManifestEntry[] {
  const indexed = new Set((db.prepare("select path from file where disposition = 'indexed'").all() as Array<{ path: string }>).map((f) => f.path))
  const out: ManifestEntry[] = []
  for (const m of db.prepare("select path, content_hash from file where disposition = 'indexed' and (path = 'package.json' or path like '%/package.json') order by path").all() as Array<{ path: string; content_hash: string }>) {
    const text = store.read(m.content_hash)?.toString('utf8')
    let json: Record<string, unknown>
    try { json = JSON.parse(text ?? '') } catch { continue }
    const lines = (text ?? '').split('\n')
    const lineOf = (key: string) => Math.max(1, lines.findIndex((l) => l.includes(`"${key}"`)) + 1)
    const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [])
    const dir = path.posix.dirname(m.path)
    const add = (kind: ManifestEntry['kind'], key: string) => {
      for (const target of [...new Set(strings(json[key]))]) out.push({ kind, manifest: m.path, line: lineOf(key), target, file: resolveEntry(indexed, dir, target) })
    }
    for (const key of ['main', 'module', 'types', 'typings']) add('main', key)
    add('exports', 'exports')
    add('bin', 'bin')
  }
  return out
}

/** The indexed file a manifest path names: as written, as its TypeScript source (.js to .ts), or its index file. No dist-to-src guess. */
function resolveEntry(indexed: Set<string>, dir: string, target: string): string | null {
  if (target.includes('*')) return null
  const p = path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, target)).replace(/^\.\//, '')
  const stem = p.replace(/\.d\.ts$|\.[cm]?jsx?$/, '')
  return [p, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`, `${p}/index.ts`, `${p}/index.js`].find((c) => indexed.has(c)) ?? null
}

// ---------- the file import graph ----------
type ImportEdge = { from: string; to: string; line: number; kind: string; inferred: boolean }

/** Resolved imports between indexed files, and imports bound to one candidate module (inferred), with the import's line. */
function importEdges(db: Database.Database): ImportEdge[] {
  const line = '(select e.start_line from assertion_evidence ae join evidence e on e.id = ae.evidence_id where ae.assertion_id = a.id order by e.start_byte limit 1)'
  const resolved = db.prepare(`select fa.path as "from", fb.path as "to", ${line} as line, coalesce(json_extract(a.detail, '$.kind'), 'static') as kind, 0 as inferred
    from assertion a join file fa on fa.id = a.source_id join file fb on fb.id = a.target_id
    where a.type = 'imports' and a.resolution = 'resolved' and a.source_kind = 'file' and a.target_kind = 'file' and fa.id <> fb.id`).all() as ImportEdge[]
  // A syntax-tier import bound to exactly one module is a candidate edge: followed, and marked inferred (#10).
  const candidate = db.prepare(`select fa.path as "from", fb.path as "to", ${line} as line, coalesce(json_extract(a.detail, '$.kind'), 'static') as kind, 1 as inferred
    from assertion a join file fa on fa.id = (case a.source_kind when 'file' then a.source_id else (select file_id from symbol where id = a.source_id) end)
    join assertion_candidate c on c.assertion_id = a.id join symbol m on m.id = c.symbol_id and m.kind = 'module' join file fb on fb.id = m.file_id
    where a.type = 'imports' and a.resolution = 'candidate' and fa.id <> fb.id`).all() as ImportEdge[]
  return [...resolved, ...candidate].map((e) => ({ ...e, inferred: !!e.inferred }))
}

/** Strongly connected components of more than one node (Tarjan), iterative so a deep import chain cannot overflow the stack. */
export function components(nodes: string[], adj: Map<string, string[]>): string[][] {
  const index = new Map<string, number>(), low = new Map<string, number>(), on = new Set<string>(), stack: string[] = [], out: string[][] = []
  let counter = 0
  for (const root of nodes) {
    if (index.has(root)) continue
    const work: Array<[string, number]> = [[root, 0]]
    index.set(root, counter); low.set(root, counter++); stack.push(root); on.add(root)
    while (work.length) {
      const top = work[work.length - 1]!, [v, i] = top, next = adj.get(v) ?? []
      if (i < next.length) {
        top[1]++
        const w = next[i]!
        if (!index.has(w)) { index.set(w, counter); low.set(w, counter++); stack.push(w); on.add(w); work.push([w, 0]) }
        else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!))
        continue
      }
      work.pop()
      if (work.length) { const u = work[work.length - 1]![0]; low.set(u, Math.min(low.get(u)!, low.get(v)!)) }
      if (low.get(v) === index.get(v)) {
        const c: string[] = []
        for (let w: string | undefined; w !== v;) { w = stack.pop()!; on.delete(w); c.push(w) }
        if (c.length > 1) out.push(c.sort())
      }
    }
  }
  return out
}

export type CycleEdge = { cycle: number; from: string; to: string; line: number; kind: string; inferred: boolean }
export type Cycle = { cycle: number; type_only: boolean; inferred: boolean; files: string[]; edges: number }

/**
 * Import cycles among the files under a prefix: each strongly connected set once, with every import between its files. Runtime cycles come
 * first; with type-only imports included, a set that is a cycle only through them is listed apart, marked type_only. A cycle that holds
 * only through an inferred import is marked inferred.
 */
export function findCycles(db: Database.Database, o: { pathPrefix?: string; includeTypeOnly: boolean; includeTests: boolean; isTest: (p: string) => boolean }): { cycles: Cycle[]; edges: CycleEdge[] } {
  const inScope = (p: string) => (!o.pathPrefix || p.startsWith(o.pathPrefix)) && (o.includeTests || !o.isTest(p))
  const all = importEdges(db).filter((e) => inScope(e.from) && inScope(e.to))
  const sccs = (edges: ImportEdge[]) => {
    const adj = new Map<string, string[]>()
    for (const e of edges) push(adj, e.from, e.to)
    return components([...new Set(edges.flatMap((e) => [e.from, e.to]))].sort(), adj)
  }
  const runtime = sccs(all.filter((e) => e.kind !== 'type_only'))
  const key = (c: string[]) => c.join('\n')
  const seen = new Set(runtime.map(key))
  const typed = o.includeTypeOnly ? sccs(all).filter((c) => !seen.has(key(c))) : []
  // The component of each file when inferred imports are left out: a cycle whose files fall apart without them needs one.
  const precise = new Map<string, number>()
  for (const [i, c] of sccs(all.filter((e) => !e.inferred)).entries()) for (const f of c) precise.set(f, i)
  const bySize = (a: string[], b: string[]) => b.length - a.length || (a[0]! < b[0]! ? -1 : 1)
  const cycles: Cycle[] = [], edges: CycleEdge[] = []
  for (const [typeOnly, list] of [[false, runtime.sort(bySize)], [true, typed.sort(bySize)]] as const) {
    for (const files of list) {
      const n = cycles.length + 1, inside = new Set(files)
      const own = all.filter((e) => inside.has(e.from) && inside.has(e.to) && (typeOnly || e.kind !== 'type_only'))
        .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.line - b.line || (a.to < b.to ? -1 : a.to > b.to ? 1 : 0)))
      // One row per import site: a file importing another twice on one line is one edge.
      const unique = own.filter((e, i) => i === 0 || e.from !== own[i - 1]!.from || e.to !== own[i - 1]!.to || e.line !== own[i - 1]!.line)
      const p = precise.get(files[0]!)
      cycles.push({ cycle: n, type_only: typeOnly, inferred: p === undefined || files.some((f) => precise.get(f) !== p), files, edges: unique.length })
      for (const e of unique) edges.push({ cycle: n, from: e.from, to: e.to, line: e.line, kind: e.kind, inferred: e.inferred })
    }
  }
  return { cycles, edges }
}

// ---------- entry points ----------
export type EntryPoint = { reason: 'not_imported' | 'endpoint' | 'job' | 'main' | 'bin' | 'exports'; path: string; line: number; name: string | null; kind: string | null; id: string | null; manifest?: string; target?: string }

/** Modules nothing in scope imports, then framework entry points (endpoints, jobs) and the entries package manifests name. */
export function findEntryPoints(db: Database.Database, store: EvidenceStore, o: { pathPrefix?: string; includeTests: boolean; isTest: (p: string) => boolean }): EntryPoint[] {
  const inPrefix = (p: string) => !o.pathPrefix || p.startsWith(o.pathPrefix)
  const imported = new Set(importEdges(db).filter((e) => inPrefix(e.from)).map((e) => e.to))
  const modules = (db.prepare("select f.path from file f join symbol s on s.file_id = f.id and s.kind = 'module' where f.disposition = 'indexed' and f.path like ? escape '\\' group by f.id order by f.path").all(prefixLike(o.pathPrefix)) as Array<{ path: string }>)
    .filter((f) => !imported.has(f.path) && (o.includeTests || !o.isTest(f.path)))
    .map((f): EntryPoint => ({ reason: 'not_imported', path: f.path, line: 1, name: null, kind: 'module', id: null }))
  const framework = (db.prepare("select s.id, s.kind, s.name, s.qualified_name, f.path, s.start_line as line from symbol s join file f on f.id = s.file_id where s.kind in ('endpoint', 'job') and f.path like ? escape '\\' order by s.kind, f.path, s.start_line, s.qualified_name, s.id").all(prefixLike(o.pathPrefix)) as Array<{ id: string; kind: 'endpoint' | 'job'; name: string; qualified_name: string; path: string; line: number }>)
    .map((s): EntryPoint => ({ reason: s.kind, path: s.path, line: s.line, name: s.qualified_name, kind: s.kind, id: s.id }))
  const manifests = manifestEntries(db, store).filter((m) => inPrefix(m.file ?? m.manifest))
    .map((m): EntryPoint => ({ reason: m.kind, path: m.file ?? m.manifest, line: m.file ? 1 : m.line, name: m.file ? null : m.target, kind: null, id: null, manifest: m.manifest, target: m.target }))
  return [...modules, ...framework, ...manifests]
}

// ---------- unused ----------
export type UnusedRow = { id: string; kind: string; name: string; qualified_name: string; path: string; line: number; group: 'unused' | 'reachable_only_by' | 'possibly_used'; by?: 'test' | 'framework' | 'public_export'; sites?: number; inferred?: boolean }

/**
 * Symbols under a prefix that nothing in the repository uses through a resolved relationship. One that only test code, a framework
 * registration or a package's public exports reach is listed under reachable_only_by; one an inferred edge or an unresolved call by its
 * name could reach is listed under possibly_used, with the count of such sites.
 */
export function findUnused(db: Database.Database, store: EvidenceStore, o: { kinds: string[]; pathPrefix?: string; topLevelOnly: boolean; includeTests: boolean }): { rows: UnusedRow[]; checked: number } {
  const symbolKinds = o.kinds.filter((k) => k !== 'module')
  const candidates = symbolKinds.length ? db.prepare(`select s.id, s.kind, s.name, s.qualified_name, f.path, s.start_line as line, s.start_byte, s.evidence_id from symbol s join file f on f.id = s.file_id
    where s.kind in (${marks(symbolKinds.length)}) and f.disposition = 'indexed' and f.path like ? escape '\\'${o.includeTests ? '' : ' and not pm_is_test(f.path, s.roles)'}${o.topLevelOnly ? ` and not ${NESTED_SQL}` : ''}
    order by f.path, s.start_byte, s.qualified_name, s.id`).all(...symbolKinds, prefixLike(o.pathPrefix)) as Array<Omit<UnusedRow, 'group'> & { start_byte: number; evidence_id: string }> : []
  // Each user of a symbol, and whether that user is test code; a symbol's use of itself (recursion) is no use.
  const users = db.prepare(`select distinct e.src, coalesce(pm_is_test(f.path, s.roles), 0) as test from edge e left join symbol s on s.id = e.src left join file f on f.id = coalesce(s.file_id, e.src)
    where e.dst = ? and e.src <> e.dst and e.resolution = 'resolved' and e.type in (${marks(USE_TYPES.length)})`)
  const framework = db.prepare(`select 1 from edge where (dst = ? or src = ?) and resolution = 'resolved' and type in (${marks(FRAMEWORK_TYPES.length)}) limit 1`)
  // An implementation or override is used when the member it implements is: calls through an interface or base land on it (dispatch).
  const dispatched = db.prepare(`select t.dst from edge t where t.src = ? and t.type in ('implements', 'overrides') and t.resolution = 'resolved'`)
  const candidateSites = db.prepare("select count(distinct a.id) as n from assertion_candidate c join assertion a on a.id = c.assertion_id where c.symbol_id = ? and a.resolution in ('candidate', 'ambiguous')")
  // Unresolved calls name their callee; any but one whose receiver is known to be a missing package could reach a symbol of that name.
  const byName = new Map<string, number>()
  for (const r of db.prepare("select json_extract(detail, '$.callee') as callee, count(*) as n from assertion where type = 'calls' and resolution = 'unresolved' and reason <> 'dependency_missing' and json_extract(detail, '$.callee') is not null group by callee").all() as Array<{ callee: string; n: number }>) {
    const name = String(r.callee).split(/[.:\\]/).pop()!
    byName.set(name, (byName.get(name) ?? 0) + r.n)
  }
  const pub = publicFiles(db, store)
  const declaration = db.prepare('select object_hash, start_byte, end_byte from evidence where id = ?')
  const texts = new Map<string, string>()
  // The modifiers before a declaration's name, read from the captured file.
  const modifiers = (c: { name: string; evidence_id: string }) => {
    const e = declaration.get(c.evidence_id) as { object_hash: string; start_byte: number; end_byte: number } | undefined
    if (!e) return ''
    if (!texts.has(e.object_hash)) texts.set(e.object_hash, store.read(e.object_hash)?.toString('latin1') ?? '')
    const head = texts.get(e.object_hash)!.slice(e.start_byte, Math.min(e.end_byte, e.start_byte + 400))
    const at = head.indexOf(c.name)
    return at >= 0 ? head.slice(0, at) : head
  }
  const usersOf = (id: string) => users.all(id, ...USE_TYPES) as Array<{ src: string; test: number }>
  const rows: UnusedRow[] = []
  for (const { start_byte: _b, evidence_id, ...c } of candidates) {
    let found = usersOf(c.id)
    if (!found.some((u) => !u.test || o.includeTests)) found = [...found, ...(dispatched.all(c.id) as Array<{ dst: string }>).flatMap((d) => usersOf(d.dst))]
    if (found.some((u) => !u.test || o.includeTests)) continue
    if (found.length) rows.push({ ...c, group: 'reachable_only_by', by: 'test' })
    else if (framework.get(c.id, c.id, ...FRAMEWORK_TYPES)) rows.push({ ...c, group: 'reachable_only_by', by: 'framework' })
    else if (pub.has(c.path) && /\bexport\b/.test(modifiers({ name: c.name, evidence_id }))) rows.push({ ...c, group: 'reachable_only_by', by: 'public_export' })
    else {
      const inferred = (candidateSites.get(c.id) as { n: number }).n, named = byName.get(c.name) ?? 0
      rows.push(inferred + named ? { ...c, group: 'possibly_used', sites: inferred + named, ...(inferred ? { inferred: true } : {}) } : { ...c, group: 'unused' })
    }
  }
  const modules = o.kinds.includes('module') ? unusedModules(db, o, pub) : { rows: [], checked: 0 }
  rows.push(...modules.rows)
  const rank = (r: UnusedRow) => (r.group === 'unused' ? 0 : r.group === 'reachable_only_by' ? 1 : 2)
  rows.sort((a, b) => rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || (a.qualified_name < b.qualified_name ? -1 : a.qualified_name > b.qualified_name ? 1 : 0)))
  return { rows, checked: candidates.length + modules.checked }
}

/** Files no other file imports and none of whose symbols another file uses; tests and manifest entries are listed apart. */
function unusedModules(db: Database.Database, o: { pathPrefix?: string; includeTests: boolean }, pub: Set<string>): { rows: UnusedRow[]; checked: number } {
  const edges = importEdges(db).filter((e) => e.from !== e.to)
  const importers = new Map<string, string[]>()
  for (const e of edges) push(importers, e.to, e.from)
  const usedFrom = db.prepare(`select distinct f.path from symbol d join edge e on e.dst = d.id and e.resolution = 'resolved' and e.type in (${marks(USE_TYPES.length)})
    join symbol s on s.id = e.src join file f on f.id = s.file_id where d.file_id = ? and s.file_id <> d.file_id`)
  const out: UnusedRow[] = []
  let checked = 0
  for (const m of db.prepare(`select s.id, s.kind, s.name, s.qualified_name, f.path, s.start_line as line, f.id as file_id from symbol s join file f on f.id = s.file_id
    where s.kind = 'module' and f.disposition = 'indexed' and f.path like ? escape '\\' order by f.path`).all(prefixLike(o.pathPrefix)) as Array<Omit<UnusedRow, 'group'> & { file_id: string }>) {
    const { file_id, ...row } = m
    if (!o.includeTests && isTestPath(m.path)) continue
    checked++
    const from = [...(importers.get(m.path) ?? []), ...(usedFrom.all(file_id, ...USE_TYPES) as Array<{ path: string }>).map((r) => r.path)]
    if (from.some((p) => o.includeTests || !isTestPath(p))) continue
    out.push(from.length ? { ...row, group: 'reachable_only_by', by: 'test' } : pub.has(m.path) ? { ...row, group: 'reachable_only_by', by: 'public_export' } : { ...row, group: 'unused' })
  }
  return { rows: out, checked }
}

/** The files a package's public surface holds: the entries its manifest names, and what they re-export, transitively. */
function publicFiles(db: Database.Database, store: EvidenceStore): Set<string> {
  const entries = manifestEntries(db, store).filter((m) => m.kind !== 'bin' && m.file).map((m) => m.file!)
  const reexports = new Map<string, string[]>()
  for (const e of importEdges(db)) if (e.kind === 're_export') push(reexports, e.from, e.to)
  const seen = new Set(entries), queue = [...entries]
  while (queue.length) for (const to of reexports.get(queue.pop()!) ?? []) if (!seen.has(to)) { seen.add(to); queue.push(to) }
  return seen
}

// ---------- hubs ----------
export type Hub = { id: string; kind: string; name: string; qualified_name: string; path: string; line: number; fan_in: number; fan_out: number; betweenness?: number }

/**
 * The most depended-on symbols: by fan_in (distinct symbols that use one through a resolved relationship), fan_out (distinct symbols one
 * uses) or betweenness (shortest use paths through one, Brandes; sampled from evenly spaced sources on a large graph).
 */
export function findHubs(db: Database.Database, o: { top: number; by: 'fan_in' | 'fan_out' | 'betweenness'; kinds?: string[]; pathPrefix?: string; includeTests: boolean; deadline: number }): { hubs: Hub[]; sampled: number | null; timedOut: boolean } {
  const testFilter = o.includeTests ? '' : ' and not pm_is_test(fs.path, ss.roles) and not pm_is_test(fd.path, sd.roles)'
  const pairs = db.prepare(`select distinct e.src, e.dst from edge e join symbol ss on ss.id = e.src join file fs on fs.id = ss.file_id join symbol sd on sd.id = e.dst join file fd on fd.id = sd.file_id
    where e.resolution = 'resolved' and e.src <> e.dst and e.type in (${marks(USE_TYPES.length)})${testFilter}`).all(...USE_TYPES) as Array<{ src: string; dst: string }>
  const fanIn = new Map<string, number>(), fanOut = new Map<string, number>(), adj = new Map<string, string[]>()
  for (const p of pairs) {
    fanIn.set(p.dst, (fanIn.get(p.dst) ?? 0) + 1); fanOut.set(p.src, (fanOut.get(p.src) ?? 0) + 1)
    push(adj, p.src, p.dst)
  }
  let score: Map<string, number>, sampled: number | null = null, timedOut = false
  if (o.by === 'betweenness') ({ score, sampled, timedOut } = betweenness(adj, o.deadline))
  else score = o.by === 'fan_in' ? fanIn : fanOut
  const kinds = o.kinds?.length ? new Set(o.kinds) : null
  const symbol = db.prepare("select s.id, s.kind, s.name, s.qualified_name, f.path, s.start_line as line, pm_is_test(f.path, s.roles) as test from symbol s join file f on f.id = s.file_id where s.id = ?")
  const ranked = [...score].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  const hubs: Hub[] = []
  for (const [id, n] of ranked) {
    if (hubs.length >= o.top) break
    const s = symbol.get(id) as (Omit<Hub, 'fan_in' | 'fan_out'> & { test: number }) | undefined
    if (!s || (kinds && !kinds.has(s.kind)) || (o.pathPrefix && !s.path.startsWith(o.pathPrefix))) continue
    const { test: _t, ...row } = s
    hubs.push({ ...row, fan_in: fanIn.get(id) ?? 0, fan_out: fanOut.get(id) ?? 0, ...(o.by === 'betweenness' ? { betweenness: Math.round(n * 100) / 100 } : {}) })
  }
  // Equal scores are ordered by id inside the query; the answer orders them by name, so it reads the same across snapshots.
  hubs.sort((a, b) => (o.by === 'fan_in' ? b.fan_in - a.fan_in : o.by === 'fan_out' ? b.fan_out - a.fan_out : b.betweenness! - a.betweenness!) || (a.qualified_name < b.qualified_name ? -1 : a.qualified_name > b.qualified_name ? 1 : a.path < b.path ? -1 : 1))
  return { hubs, sampled, timedOut }
}

/** Most sources Brandes' algorithm starts from; a larger graph is sampled at evenly spaced sources and the scores scaled up. */
const MAX_SOURCES = 1000
function betweenness(adj: Map<string, string[]>, deadline: number): { score: Map<string, number>; sampled: number | null; timedOut: boolean } {
  const nodes = [...new Set([...adj.keys(), ...[...adj.values()].flat()])].sort()
  const step = Math.max(1, Math.ceil(nodes.length / MAX_SOURCES)), sources = nodes.filter((_, i) => i % step === 0)
  const score = new Map<string, number>()
  let done = 0
  for (const s of sources) {
    if (Date.now() > deadline) break
    const stack: string[] = [], pred = new Map<string, string[]>(), sigma = new Map([[s, 1]]), dist = new Map([[s, 0]]), queue = [s]
    for (let qi = 0; qi < queue.length; qi++) {
      const v = queue[qi]!
      stack.push(v)
      for (const w of adj.get(v) ?? []) {
        if (!dist.has(w)) { dist.set(w, dist.get(v)! + 1); queue.push(w) }
        if (dist.get(w) === dist.get(v)! + 1) { sigma.set(w, (sigma.get(w) ?? 0) + sigma.get(v)!); push(pred, w, v) }
      }
    }
    const delta = new Map<string, number>()
    while (stack.length) {
      const w = stack.pop()!
      for (const v of pred.get(w) ?? []) delta.set(v, (delta.get(v) ?? 0) + (sigma.get(v)! / sigma.get(w)!) * (1 + (delta.get(w) ?? 0)))
      if (w !== s) score.set(w, (score.get(w) ?? 0) + (delta.get(w) ?? 0) * step)
    }
    done++
  }
  return { score, sampled: step > 1 || done < sources.length ? done : null, timedOut: done < sources.length }
}
