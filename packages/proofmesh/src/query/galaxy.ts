import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { ProofmeshError } from '../core/errors.js'
import { Catalog, noSnapshot } from '../meshstore/catalog.js'
import { openSnapshot } from '../meshstore/snapshot.js'
import { inferredSql } from './basis.js'
import { type LayoutCell, layoutPositions, packCells } from './layout.js'

/**
 * The whole snapshot as one compact binary for the Terrain: every symbol except file modules, its area (the first two
 * directories of its file), kind, number of resolved relationships and position, the distinct resolved links between
 * symbols as index pairs, the qualified names, the layout's cells, and the bundles between areas. Layout: u32 header
 * length, the JSON header, padding to four bytes, then the sections at the header's offsets. Built once per snapshot and gzipped.
 */
export type FileCounts = { indexed: number; unsupported: number; excluded: number; failed: number; pending: number }
/** An area with its coverage (FR059): files by disposition, call sites and unresolved calls, and the commonest reasons files were not analysed. */
export type GalaxyArea = { name: string; count: number; files: FileCounts; calls: { sites: number; unresolved: number }; gaps: Array<[string, number]> }
export type GalaxyHeader = {
  /** The payload's layout; it changes when a section does, and the cache name with it. */
  format: number
  snapshot_id: string; nodes: number; links: number; areas: GalaxyArea[]; kinds: string[]
  /** The analysed files, sorted, for the Observatory's command palette. */
  files: string[]
  /**
   * Resolved relationships between symbols of two areas (FR1402): [from area, to area, type (an index into relationship_types),
   * basis (0 observed, 1 inferred), count], one per area pair, type and basis that has any.
   */
  bundles: Array<[number, number, number, number, number]>; relationship_types: string[]
  /** The layout's cells (FR1401), parents first: each one's box, parent (-1 for the root), symbols and path segment. */
  cells: number
  offsets: { links: number; degree: number; area: number; kind: number; positions: number; names: number; cell_rects: number; cell_parent: number; cell_count: number; cell_names: number }; names_bytes: number; cell_names_bytes: number
}

/** Format 4 added each symbol's position (FR1221); format 5 areas of two directories, the cells and the bundles (FR1401, FR1402); format 6 the strips that hold a file's place when its directory gains a file (FR2621). Bump it when a section or the layout changes, so cached payloads are rebuilt. */
export const GALAXY_FORMAT = 6
const memo = new Map<string, { gz: Buffer; ids: string[] }>()

export function areaOf(path: string, depth = 3): string {
  const dirs = path.split('/').slice(0, -1)
  return dirs.length ? dirs.slice(0, depth).join('/') : '(root)'
}
/** A Terrain area: the first two directories of a file, such as src/driver, or (root) (FR1400). */
export const terrainArea = (path: string) => areaOf(path, 2)

/** The relationships bundles count (FR1402): every resolved one but containment, with its basis, as edges hold them; each row is one assertion. */
export const BUNDLE_SQL = `select e.src, e.dst, e.type, e.assertion_id, ${inferredSql('a')} as inferred from edge e join assertion a on a.id = e.assertion_id where e.resolution = 'resolved' and e.type <> 'contains'`

type Scope = { snapshotId?: string; repositoryId?: string }
/** The snapshot a Galaxy route is about: the repository's current one, or the published one Replay pins (FR010). */
function snapshotOf(catalog: Catalog, opts: Scope) {
  const repo = catalog.resolveRepository(opts.repositoryId)
  const snapshot = opts.snapshotId ? catalog.snapshot(opts.snapshotId) : catalog.currentSnapshot(repo.id)
  if (opts.snapshotId && snapshot?.repository_id !== repo.id) throw new ProofmeshError('NOT_FOUND', `no snapshot ${opts.snapshotId} for this repository`)
  if (!snapshot) throw noSnapshot(catalog, repo.id)
  return snapshot
}

export type BundleEnd = { id: string; qualified_name: string; path: string; start_line: number }
export type BundleRow = { assertion_id: string; type: string; basis: 'observed' | 'inferred'; source: BundleEnd; target: BundleEnd; site: { path: string; start_line: number } | null }
export type Bundle = { from: string; to: string; total: number; by_basis: { observed: number; inferred: number }; rows: BundleRow[]; next_offset: number | null }

/**
 * The relationships one bundle stands for (FR1403): every relationship the Galaxy payload counts from area `from` to area `to`, observed
 * first, then by source and target name, each with its call site; a page of them from offset, with the total and the count by basis.
 */
export function galaxyBundle(dataDir: string, opts: Scope, from: string, to: string, page: { offset: number; limit: number }): Bundle {
  const catalog = Catalog.open(dataDir)
  try {
    const db = openSnapshot(catalog, snapshotOf(catalog, opts))
    try {
      const prefix = (a: string) => (a === '(root)' ? '' : `${a}/`)
      const pf = prefix(from), pt = prefix(to)
      const all = (db.prepare(`select b.assertion_id, b.type, b.inferred, s.id as sid, s.qualified_name as sq, sf.path as sp, s.start_line as sl, t.id as tid, t.qualified_name as tq, tf.path as tp, t.start_line as tl
        from (${BUNDLE_SQL}) b join symbol s on s.id = b.src join file sf on sf.id = s.file_id join symbol t on t.id = b.dst join file tf on tf.id = t.file_id
        where s.kind <> 'module' and t.kind <> 'module' and substr(sf.path, 1, ?) = ? and substr(tf.path, 1, ?) = ?`).all(pf.length, pf, pt.length, pt) as Array<{ assertion_id: string; type: string; inferred: number; sid: string; sq: string; sp: string; sl: number; tid: string; tq: string; tp: string; tl: number }>)
        .filter((r) => from !== to && terrainArea(r.sp) === from && terrainArea(r.tp) === to)
        .sort((x, y) => x.inferred - y.inferred || (x.sq < y.sq ? -1 : x.sq > y.sq ? 1 : 0) || (x.tq < y.tq ? -1 : x.tq > y.tq ? 1 : 0) || (x.assertion_id < y.assertion_id ? -1 : 1))
      const site = db.prepare('select f.path, e.start_line from assertion_evidence ae join evidence e on e.id = ae.evidence_id join file f on f.id = e.file_id where ae.assertion_id = ? order by f.path, e.start_byte limit 1')
      const rows = all.slice(page.offset, page.offset + page.limit).map((r) => ({
        assertion_id: r.assertion_id, type: r.type, basis: r.inferred ? 'inferred' as const : 'observed' as const,
        source: { id: r.sid, qualified_name: r.sq, path: r.sp, start_line: r.sl }, target: { id: r.tid, qualified_name: r.tq, path: r.tp, start_line: r.tl },
        site: (site.get(r.assertion_id) as { path: string; start_line: number } | undefined) ?? null,
      }))
      const inferred = all.filter((r) => r.inferred).length
      return { from, to, total: all.length, by_basis: { observed: all.length - inferred, inferred }, rows, next_offset: page.offset + page.limit < all.length ? page.offset + page.limit : null }
    } finally { db.close() }
  } finally { catalog.close() }
}

/** The Galaxy of a repository's current snapshot, or of a published one Replay pins (FR010); the repository is named when several are registered (A11). */
export function galaxyFor(dataDir: string, opts: Scope = {}): { gz: Buffer; ids: string[] } {
  const catalog = Catalog.open(dataDir)
  try {
    const snapshot = snapshotOf(catalog, opts)
    const hit = memo.get(snapshot.id)
    if (hit) return hit
    // A sealed snapshot never changes, so its galaxy is built once and kept beside it in the data directory.
    // The version in the name retires galaxies built in an older layout.
    const cache = path.join(dataDir, 'cache'), gzFile = path.join(cache, `galaxy-v${GALAXY_FORMAT}-${snapshot.id}.bin.gz`), idsFile = path.join(cache, `galaxy-v${GALAXY_FORMAT}-${snapshot.id}.ids.json`)
    if (fs.existsSync(gzFile) && fs.existsSync(idsFile)) {
      const stored = { gz: fs.readFileSync(gzFile), ids: JSON.parse(fs.readFileSync(idsFile, 'utf8')) as string[] }
      memo.set(snapshot.id, stored)
      return stored
    }
    const db = openSnapshot(catalog, snapshot)
    try {
      const rows = db.prepare("select s.id, s.kind, s.qualified_name, s.start_line, s.start_byte, f.path from symbol s join file f on f.id = s.file_id where s.kind <> 'module' order by s.id").all() as Array<{ id: string; kind: string; qualified_name: string; start_line: number; start_byte: number; path: string }>
      const n = rows.length
      const index = new Map(rows.map((r, i) => [r.id, i]))
      const byArea = new Map<string, GalaxyArea & { gapCounts: Map<string, number> }>()
      const areaAt = (p: string) => {
        const name = terrainArea(p)
        let a = byArea.get(name)
        if (!a) byArea.set(name, a = { name, count: 0, files: { indexed: 0, unsupported: 0, excluded: 0, failed: 0, pending: 0 }, calls: { sites: 0, unresolved: 0 }, gaps: [], gapCounts: new Map() })
        return a
      }
      for (const r of rows) areaAt(r.path).count++
      const DISPOSITION: Record<string, keyof FileCounts> = { indexed: 'indexed', unsupported: 'unsupported', excluded_by_rule: 'excluded', failed: 'failed', pending: 'pending' }
      for (const f of db.prepare('select path, disposition, disposition_detail from file').iterate() as Iterable<{ path: string; disposition: string; disposition_detail: string | null }>) {
        const a = areaAt(f.path)
        a.files[DISPOSITION[f.disposition]!]++
        if (f.disposition !== 'indexed') a.gapCounts.set(f.disposition_detail ?? f.disposition, (a.gapCounts.get(f.disposition_detail ?? f.disposition) ?? 0) + 1)
      }
      const callSites = db.prepare(`select f.path as path, count(*) as sites, sum(a.resolution = 'unresolved') as unresolved from assertion a
        join file f on f.id = case a.source_kind when 'file' then a.source_id else (select s.file_id from symbol s where s.id = a.source_id) end
        where a.type = 'calls' group by f.path`).all() as Array<{ path: string; sites: number; unresolved: number }>
      for (const c of callSites) { const a = areaAt(c.path); a.calls.sites += c.sites; a.calls.unresolved += c.unresolved }
      // Areas with symbols come first, largest first; areas the graph cannot see follow, so the coverage gap is listed, not lost.
      const total = (a: GalaxyArea) => Object.values(a.files).reduce((x, y) => x + y, 0)
      const areas: GalaxyArea[] = [...byArea.values()]
        .sort((a, b) => (b.count > 0 ? 1 : 0) - (a.count > 0 ? 1 : 0) || b.count - a.count || total(b) - total(a) || (a.name < b.name ? -1 : 1))
        .map(({ gapCounts, ...a }) => ({ ...a, gaps: [...gapCounts].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, 3) }))
      const areaIndex = new Map(areas.map((a, i) => [a.name, i]))
      const kinds = [...new Set(rows.map((r) => r.kind))].sort()
      const kindIndex = new Map(kinds.map((k, i) => [k, i]))
      const area = new Uint16Array(n), kind = new Uint8Array(n), degree = new Uint32Array(n)
      rows.forEach((r, i) => { area[i] = areaIndex.get(terrainArea(r.path))!; kind[i] = kindIndex.get(r.kind)! })
      const seen = new Set<number>()
      const pairs: number[] = []
      for (const e of db.prepare("select src, dst from edge where resolution = 'resolved' and type <> 'contains'").iterate() as Iterable<{ src: string; dst: string }>) {
        const a = index.get(e.src), b = index.get(e.dst)
        if (a === undefined || b === undefined || a === b) continue
        const key = a * n + b
        if (seen.has(key)) continue
        seen.add(key)
        pairs.push(a, b)
        degree[a] = degree[a]! + 1; degree[b] = degree[b]! + 1
      }
      // Bundles: each relationship between points of two areas, counted by area pair, type and basis (FR1402).
      const types: string[] = [], typeIndex = new Map<string, number>(), counts = new Map<string, number>()
      for (const e of db.prepare(BUNDLE_SQL).iterate() as Iterable<{ src: string; dst: string; type: string; inferred: number }>) {
        const a = index.get(e.src), b = index.get(e.dst)
        if (a === undefined || b === undefined || area[a] === area[b]) continue
        let t = typeIndex.get(e.type)
        if (t === undefined) { typeIndex.set(e.type, t = types.length); types.push(e.type) }
        const key = `${area[a]},${area[b]},${t},${e.inferred ? 1 : 0}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      const bundles = [...counts].map(([k, n]) => [...k.split(',').map(Number), n] as [number, number, number, number, number]).sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || x[3] - y[3])
      const names = Buffer.from(rows.map((r) => r.qualified_name.replace(/\n/g, ' ')).join('\n'), 'utf8')
      // Positions come from the path tree and names alone, so every machine draws the same map (FR1220).
      const cells: LayoutCell[] = []
      const positions = layoutPositions(rows.map((r) => ({ path: r.path, name: r.qualified_name, line: r.start_line, byte: r.start_byte })), cells)
      const { rects, parent, count, cellNames } = packCells(cells)
      const sections = [Buffer.from(new Uint32Array(pairs).buffer), Buffer.from(degree.buffer), Buffer.from(area.buffer), Buffer.from(kind.buffer), Buffer.from(positions.buffer), names, Buffer.from(rects.buffer), Buffer.from(parent.buffer), Buffer.from(count.buffer), Buffer.from(cellNames)]
      const offsets: number[] = []
      let at = 0
      for (const s of sections) { offsets.push(at); at += s.length; at += (4 - (at % 4)) % 4 }
      const header: GalaxyHeader = {
        format: GALAXY_FORMAT, snapshot_id: snapshot.id, nodes: n, links: pairs.length / 2, areas, kinds, names_bytes: names.length,
        files: db.prepare("select path from file where disposition = 'indexed' order by path").pluck().all() as string[],
        bundles, relationship_types: types, cells: cells.length, cell_names_bytes: cellNames.length,
        offsets: { links: offsets[0]!, degree: offsets[1]!, area: offsets[2]!, kind: offsets[3]!, positions: offsets[4]!, names: offsets[5]!, cell_rects: offsets[6]!, cell_parent: offsets[7]!, cell_count: offsets[8]!, cell_names: offsets[9]! },
      }
      const headerBytes = Buffer.from(JSON.stringify(header), 'utf8')
      const parts: Buffer[] = [Buffer.from(new Uint32Array([headerBytes.length]).buffer), headerBytes, Buffer.alloc((4 - ((4 + headerBytes.length) % 4)) % 4)]
      sections.forEach((s, i) => { parts.push(s); const end = offsets[i]! + s.length; const next = i + 1 < sections.length ? offsets[i + 1]! : end; parts.push(Buffer.alloc(next - end)) })
      const result = { gz: zlib.gzipSync(Buffer.concat(parts), { level: 6 }), ids: rows.map((r) => r.id) }
      fs.mkdirSync(cache, { recursive: true })
      fs.writeFileSync(`${idsFile}.tmp`, JSON.stringify(result.ids))
      fs.writeFileSync(`${gzFile}.tmp`, result.gz)
      fs.renameSync(`${idsFile}.tmp`, idsFile)
      fs.renameSync(`${gzFile}.tmp`, gzFile)
      memo.set(snapshot.id, result)
      return result
    } finally {
      db.close()
    }
  } finally {
    catalog.close()
  }
}

