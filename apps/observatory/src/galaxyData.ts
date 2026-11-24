import { MIN_SITES } from './share'
// Parses the binary galaxy the server builds (see packages/proofmesh/src/query/galaxy.ts). No DOM, so it is testable.
export type GalaxyArea = {
  name: string; count: number
  files: { indexed: number; unsupported: number; excluded: number; failed: number; pending: number }
  calls: { sites: number; unresolved: number }; gaps: Array<[string, number]>
}
export type GalaxyData = {
  snapshotId: string; n: number; links: Uint32Array; degree: Uint32Array; area: Uint16Array; kind: Uint8Array
  kinds: string[]; areas: GalaxyArea[]; names: string[]
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
    snapshotId: h.snapshot_id, n: h.nodes, kinds: h.kinds, areas: h.areas,
    links: new Uint32Array(buf, base + h.offsets.links, h.links * 2),
    degree: new Uint32Array(buf, base + h.offsets.degree, h.nodes),
    area: new Uint16Array(buf, base + h.offsets.area, h.nodes),
    kind: new Uint8Array(buf, base + h.offsets.kind, h.nodes),
    names: h.nodes ? new TextDecoder().decode(new Uint8Array(buf, base + h.offsets.names, h.names_bytes)).split('\n') : [],
  }
}

const lowered = new WeakMap<GalaxyData, { text: string; starts: Int32Array }>()
/**
 * Indices of points whose qualified name contains the text, case-insensitively, in ascending order. The names are lowered and joined
 * once per galaxy, so a query is one native substring scan of that text, each hit mapped to its name by binary search (NFR005).
 */
export function matchIndices(d: GalaxyData, text: string): number[] {
  const q = text.trim().toLowerCase()
  if (q.length < 2) return []
  let index = lowered.get(d)
  if (!index) {
    const starts = new Int32Array(d.n)
    let at = 0
    for (let i = 0; i < d.n; i++) { starts[i] = at; at += d.names[i]!.length + 1 }
    index = { text: d.names.map((n) => n.toLowerCase()).join('\n'), starts }
    lowered.set(d, index)
  }
  const { text: all, starts } = index
  const out: number[] = []
  for (let at = all.indexOf(q); at >= 0;) {
    let lo = 0, hi = d.n - 1
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid]! <= at) lo = mid; else hi = mid - 1 }
    out.push(lo)
    // Skip the rest of this name, so a name that holds the text twice is listed once.
    at = lo + 1 < d.n ? all.indexOf(q, starts[lo + 1]!) : -1
  }
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

/** How far from its area's centre a new symbol may start. */
export const JITTER = 6
/** Bump when the seeding changes, so layouts settled from the old seeds are not reused (B18). */
const LAYOUT_VERSION = 1
const fnv = (h: number, x: number) => Math.imul(h ^ x, 16777619) >>> 0
const hashText = (h: number, s: string) => { for (let i = 0; i < s.length; i++) h = fnv(h, s.charCodeAt(i)); return h }

/** A settled layout's cache key: the snapshot, and a hash of everything the seed positions are made from (A11, B18). */
export function layoutKey(d: GalaxyData): string {
  let h = hashText(2166136261, `${LAYOUT_VERSION}|${d.n}|${d.areas.map((a) => `${a.name}:${a.count}`).join(',')}`)
  for (let i = 0; i < d.n; i++) h = fnv(h, d.area[i]!)
  return `${d.snapshotId}:${h.toString(16).padStart(8, '0')}`
}

/** One hash per symbol name, kept beside a settled layout so the next snapshot can find its symbols in it. */
export function nameHashes(d: GalaxyData): Uint32Array {
  return Uint32Array.from(d.names, (name) => hashText(2166136261, name))
}

/**
 * Seeds a new snapshot's layout from the last settled one: a symbol whose name is in it keeps its place, a new symbol starts
 * at the centre of its area's kept symbols, and only an area with none kept falls back to the seed. The picture stays put
 * across snapshots, and positions carry no meaning either way (FR068), so a rare hash collision costs nothing but a place.
 */
export function warmStart(d: GalaxyData, previous: { names: Uint32Array; positions: Float32Array } | null, seed: Float32Array): { positions: Float32Array; reused: number } {
  if (!previous) return { positions: seed, reused: 0 }
  const at = new Map<number, number>()
  previous.names.forEach((h, i) => at.set(h, i))
  const names = nameHashes(d), positions = new Float32Array(d.n * 2), kept = new Uint8Array(d.n)
  const sum = new Float64Array(d.areas.length * 3)
  let reused = 0
  for (let i = 0; i < d.n; i++) {
    const j = at.get(names[i]!)
    if (j === undefined) continue
    const x = previous.positions[j * 2]!, y = previous.positions[j * 2 + 1]!, a = d.area[i]! * 3
    positions[i * 2] = x; positions[i * 2 + 1] = y; kept[i] = 1; reused++
    sum[a] = sum[a]! + x; sum[a + 1] = sum[a + 1]! + y; sum[a + 2] = sum[a + 2]! + 1
  }
  for (let i = 0; i < d.n; i++) {
    if (kept[i]) continue
    const a = d.area[i]! * 3, m = sum[a + 2]!
    if (!m) { positions[i * 2] = seed[i * 2]!; positions[i * 2 + 1] = seed[i * 2 + 1]!; continue }
    // A small deterministic offset, so new symbols of one area never share a point the simulation cannot push apart (B13).
    const t = ((Math.imul(i + 1, 2654435761) >>> 0) % 6283) / 1000, r = JITTER * (((Math.imul(i + 7, 40503) >>> 0) % 1000) / 1000)
    positions[i * 2] = sum[a]! / m + r * Math.cos(t)
    positions[i * 2 + 1] = sum[a + 1]! / m + r * Math.sin(t)
  }
  return { positions, reused }
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

const SPACE = 4096

/** Deterministic seed (B13): areas on a sunflower spiral, sized by their counts; points scattered inside their area. */
export function seeds(d: GalaxyData): Float32Array {
  const pos = new Float32Array(d.n * 2)
  const centres = d.areas.map((a, i) => {
    const r = 140 * Math.sqrt(i + 0.5), t = i * 2.39996
    return { x: SPACE / 2 + r * Math.cos(t), y: SPACE / 2 + r * Math.sin(t), spread: 18 + 6 * Math.sqrt(a.count) }
  })
  for (let i = 0; i < d.n; i++) {
    const c = centres[d.area[i]!]!
    const h1 = Math.imul(i + 1, 2654435761) >>> 0, h2 = Math.imul(i + 7, 40503) >>> 0
    const r = c.spread * Math.sqrt((h1 % 10007) / 10007), t = ((h2 % 10009) / 10009) * Math.PI * 2
    pos[i * 2] = c.x + r * Math.cos(t)
    pos[i * 2 + 1] = c.y + r * Math.sin(t)
  }
  return pos
}


/** Label boxes as drawn: centred on their point, about 7.2 px per character plus padding, one line high. */
const box = (l: { name: string; x: number; y: number }) => ({ half: l.name.length * 3.6 + 8, x: l.x, y: l.y })
/** Keeps labels in order and drops any that would overlap one already kept, so names never pile up (B14). */
export function placeLabels<T extends { name: string; x: number; y: number }>(candidates: T[]): T[] {
  const placed: T[] = []
  for (const c of candidates) {
    const b = box(c)
    if (placed.some((q) => { const p = box(q); return Math.abs(p.y - b.y) < 18 && Math.abs(p.x - b.x) < p.half + b.half })) continue
    placed.push(c)
  }
  return placed
}
