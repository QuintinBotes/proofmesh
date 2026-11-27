import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { ProofmeshError } from '../core/errors.js'
import { Catalog, noSnapshot } from '../meshstore/catalog.js'
import { openSnapshot } from '../meshstore/snapshot.js'

/**
 * The whole snapshot as one compact binary for the Galaxy view: every symbol except file modules, its area (the first
 * three directories of its file), kind and number of resolved relationships, the distinct resolved links between
 * symbols as index pairs, and the qualified names. Layout: u32 header length, the JSON header, padding to four bytes,
 * then the sections at the header's offsets. Built once per snapshot and gzipped.
 */
export type FileCounts = { indexed: number; unsupported: number; excluded: number; failed: number; pending: number }
/** An area with its coverage (FR059): files by disposition, call sites and unresolved calls, and the commonest reasons files were not analysed. */
export type GalaxyArea = { name: string; count: number; files: FileCounts; calls: { sites: number; unresolved: number }; gaps: Array<[string, number]> }
export type GalaxyHeader = {
  snapshot_id: string; nodes: number; links: number; areas: GalaxyArea[]; kinds: string[]
  /** The analysed files, sorted, for the Observatory's command palette. */
  files: string[]
  offsets: { links: number; degree: number; area: number; kind: number; names: number }; names_bytes: number
}

const memo = new Map<string, { gz: Buffer; ids: string[] }>()

export function areaOf(path: string): string {
  const dirs = path.split('/').slice(0, -1)
  return dirs.length ? dirs.slice(0, 3).join('/') : '(root)'
}

/** The Galaxy of a repository's current snapshot, or of a published one Replay pins (FR010); the repository is named when several are registered (A11). */
export function galaxyFor(dataDir: string, opts: { snapshotId?: string; repositoryId?: string } = {}): { gz: Buffer; ids: string[] } {
  const catalog = Catalog.open(dataDir)
  try {
    const repo = catalog.resolveRepository(opts.repositoryId)
    const snapshot = opts.snapshotId ? catalog.snapshot(opts.snapshotId) : catalog.currentSnapshot(repo.id)
    if (opts.snapshotId && snapshot?.repository_id !== repo.id) throw new ProofmeshError('NOT_FOUND', `no snapshot ${opts.snapshotId} for this repository`)
    if (!snapshot) throw noSnapshot(catalog, repo.id)
    const hit = memo.get(snapshot.id)
    if (hit) return hit
    // A sealed snapshot never changes, so its galaxy is built once and kept beside it in the data directory.
    // The version in the name retires galaxies built in an older layout.
    const cache = path.join(dataDir, 'cache'), gzFile = path.join(cache, `galaxy-v3-${snapshot.id}.bin.gz`), idsFile = path.join(cache, `galaxy-v3-${snapshot.id}.ids.json`)
    if (fs.existsSync(gzFile) && fs.existsSync(idsFile)) {
      const stored = { gz: fs.readFileSync(gzFile), ids: JSON.parse(fs.readFileSync(idsFile, 'utf8')) as string[] }
      memo.set(snapshot.id, stored)
      return stored
    }
    const db = openSnapshot(catalog, snapshot)
    try {
      const rows = db.prepare("select s.id, s.kind, s.qualified_name, f.path from symbol s join file f on f.id = s.file_id where s.kind <> 'module' order by s.id").all() as Array<{ id: string; kind: string; qualified_name: string; path: string }>
      const n = rows.length
      const index = new Map(rows.map((r, i) => [r.id, i]))
      const byArea = new Map<string, GalaxyArea & { gapCounts: Map<string, number> }>()
      const areaAt = (p: string) => {
        const name = areaOf(p)
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
      rows.forEach((r, i) => { area[i] = areaIndex.get(areaOf(r.path))!; kind[i] = kindIndex.get(r.kind)! })
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
      const names = Buffer.from(rows.map((r) => r.qualified_name.replace(/\n/g, ' ')).join('\n'), 'utf8')
      const sections = [Buffer.from(new Uint32Array(pairs).buffer), Buffer.from(degree.buffer), Buffer.from(area.buffer), Buffer.from(kind.buffer), names]
      const offsets: number[] = []
      let at = 0
      for (const s of sections) { offsets.push(at); at += s.length; at += (4 - (at % 4)) % 4 }
      const header: GalaxyHeader = {
        snapshot_id: snapshot.id, nodes: n, links: pairs.length / 2, areas, kinds, names_bytes: names.length,
        files: db.prepare("select path from file where disposition = 'indexed' order by path").pluck().all() as string[],
        offsets: { links: offsets[0]!, degree: offsets[1]!, area: offsets[2]!, kind: offsets[3]!, names: offsets[4]! },
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
