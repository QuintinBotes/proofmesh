import { MIN_SITES } from './share'
// Parses the binary galaxy the server builds (see packages/proofmesh/src/query/galaxy.ts). No DOM, so it is testable.
export type GalaxyArea = {
  name: string; count: number
  files: { indexed: number; unsupported: number; excluded: number; failed: number; pending: number }
  calls: { sites: number; unresolved: number }; gaps: Array<[string, number]>
}
export type GalaxyData = {
  snapshotId: string; n: number; links: Uint32Array; degree: Uint32Array; area: Uint16Array; kind: Uint8Array
  /** x, y per symbol, 0 to 65535 within the map's square frame, computed with the snapshot (FR1220). */
  positions: Uint16Array
  kinds: string[]; areas: GalaxyArea[]; names: string[]; files: string[]
  /** The layout's cells, parents first (FR1401): x, y, width and height per cell in the frame's 0 to 65536, its parent (-1 for the root), symbols and path segment ('' for the root and for a directory's own files beside its subdirectories). */
  cells: { rects: Uint16Array; parent: Int32Array; count: Uint32Array; names: string[] }
  /** [from area, to area, type, basis (0 observed, 1 inferred), count] (FR1402); types index relTypes. */
  bundles: Array<[number, number, number, number, number]>; relTypes: string[]
}

/** An unresolved share at or above this draws a ring round the area. */
export const RING_SHARE = 0.2

/**
 * How much of an area the graph cannot see (FR059): files it did not analyse (unsupported, failed, pending), files excluded
 * by rule, and the unresolved share of its calls. haze is the unanalysed share of the files the area should hold, 1 for an
 * area with no symbols at all; ring marks an area whose calls are mostly unknown.
 */
export function areaFog(a: GalaxyArea): { unanalysed: number; excluded: number; unresolvedShare: number | null; haze: number; ring: boolean } {
  const unanalysed = a.files.unsupported + a.files.failed + a.files.pending
  const unresolvedShare = a.calls.sites >= MIN_SITES ? a.calls.unresolved / a.calls.sites : null
  const haze = a.count === 0 ? (unanalysed > 0 ? 1 : 0) : unanalysed / Math.max(1, a.files.indexed + unanalysed)
  return { unanalysed, excluded: a.files.excluded, unresolvedShare, haze, ring: unresolvedShare !== null && unresolvedShare >= RING_SHARE }
}

export function parseGalaxy(buf: ArrayBuffer): GalaxyData {
  const headerLength = new DataView(buf).getUint32(0, true)
  const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headerLength)))
  const base = 4 + headerLength + ((4 - ((4 + headerLength) % 4)) % 4)
  return {
    snapshotId: h.snapshot_id, n: h.nodes, kinds: h.kinds, areas: h.areas, files: h.files ?? [],
    links: new Uint32Array(buf, base + h.offsets.links, h.links * 2),
    degree: new Uint32Array(buf, base + h.offsets.degree, h.nodes),
    area: new Uint16Array(buf, base + h.offsets.area, h.nodes),
    kind: new Uint8Array(buf, base + h.offsets.kind, h.nodes),
    positions: new Uint16Array(buf, base + h.offsets.positions, h.nodes * 2),
    names: h.nodes ? new TextDecoder().decode(new Uint8Array(buf, base + h.offsets.names, h.names_bytes)).split('\n') : [],
    cells: {
      rects: new Uint16Array(buf, base + h.offsets.cell_rects, h.cells * 4), parent: new Int32Array(buf, base + h.offsets.cell_parent, h.cells),
      count: new Uint32Array(buf, base + h.offsets.cell_count, h.cells),
      names: h.cells ? new TextDecoder().decode(new Uint8Array(buf, base + h.offsets.cell_names, h.cell_names_bytes)).split('\n') : [],
    },
    bundles: h.bundles, relTypes: h.relationship_types,
  }
}

export type LoweredNames = { text: string; starts: Int32Array }

/** The names lowered and joined by newlines, with where each starts in that text (FR1200). */
export function lowerNames(names: string[]): LoweredNames {
  // Lowering can lengthen a name (İ becomes two code units), so the offsets come from the lowered names.
  const lowered = names.map((n) => n.toLowerCase())
  const starts = new Int32Array(names.length)
  let at = 0
  lowered.forEach((n, i) => { starts[i] = at; at += n.length + 1 })
  return { text: lowered.join('\n'), starts }
}

/** Calls hit with each name number whose lowered name holds q (already lowered), once, in name order: one native substring scan, each hit mapped to its name by binary search. */
export function scanNames({ text: all, starts }: LoweredNames, q: string, hit: (i: number) => void): void {
  for (let at = all.indexOf(q); at >= 0;) {
    let lo = 0, hi = starts.length - 1
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid]! <= at) lo = mid; else hi = mid - 1 }
    hit(lo)
    // Skip the rest of this name, so a name that holds the text twice is listed once.
    at = lo + 1 < starts.length ? all.indexOf(q, starts[lo + 1]!) : -1
  }
}

const lowered = new WeakMap<GalaxyData, LoweredNames>()
/** Indices of points whose qualified name contains the text, case-insensitively, in ascending order; the names are lowered and joined once per galaxy (NFR005). */
export function matchIndices(d: GalaxyData, text: string): number[] {
  const q = text.trim().toLowerCase()
  if (q.length < 2) return []
  let index = lowered.get(d)
  if (!index) lowered.set(d, (index = lowerNames(d.names)))
  const out: number[] = []
  scanNames(index, q, (i) => out.push(i))
  return out
}

/** The short name a label shows: the part after the last separator of a qualified name. */
export const shortName = (qualified: string) => qualified.split(/[.:/]/).pop() || qualified

/** Matches in the order search results read best: exact name, then name prefix, then name substring, then qualified name. */
export function rankMatches(d: GalaxyData, indices: number[], text: string): number[] {
  const q = text.trim().toLowerCase()
  const rank = (i: number) => { const n = shortName(d.names[i]!).toLowerCase(); return n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : 3 }
  return indices.map((i) => [rank(i), d.names[i]!, i] as const).sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map((x) => x[2])
}

const files = (a: GalaxyArea) => a.files.indexed + a.files.unsupported + a.files.excluded + a.files.failed + a.files.pending

/** Areas with no symbols, largest first: up to max drawn one by one, the rest counted together (FR059). */
export function ghostAreas(areas: GalaxyArea[], max: number): { shown: GalaxyArea[]; rest: { areas: number; files: number } } {
  const ghosts = areas.filter((a) => a.count === 0).sort((a, b) => files(b) - files(a) || (a.name < b.name ? -1 : 1))
  const rest = ghosts.slice(max)
  return { shown: ghosts.slice(0, max), rest: { areas: rest.length, files: rest.reduce((n, a) => n + files(a), 0) } }
}

/** The legend's areas: by size, or while searching by matches, at most limit of them; total counts every area it could list (FR058). */
export function legendAreas(d: GalaxyData, matches: number[], limit: number): { shown: Array<{ index: number; name: string; count: number }>; total: number } {
  const counts = matches.length ? new Map<number, number>() : null
  if (counts) for (const i of matches) counts.set(d.area[i]!, (counts.get(d.area[i]!) ?? 0) + 1)
  const all = counts
    ? [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([index, count]) => ({ index, name: d.areas[index]!.name, count }))
    : d.areas.map((a, index) => ({ index, name: a.name, count: a.count })).filter((a) => a.count > 0)
  return { shown: all.slice(0, limit), total: all.length }
}

const GENERIC = new Set(['src', 'lib', 'source', 'sources', 'app', 'main', 'test', 'tests'])
/** An area's label: its last directory, with its parent when that directory is a generic name such as src (B20). */
export function areaLabel(area: string): string {
  const parts = area.split('/')
  const last = parts.pop() ?? area
  return GENERIC.has(last) && parts.length ? `${parts.pop()}/${last}` : last
}
