// The Terrain's model (FR1400 to FR1407): which cell each area is, the bundles between areas, and what a given zoom draws and
// labels. Pure, no DOM, so it is testable; Terrain.tsx draws what it returns.
import { areaFog, areaLabel, shortName, type GalaxyArea, type GalaxyData } from './galaxyData'
import { MIN_SITES } from './share'
import { plural } from './plural'

/** The frame's side in layout units: cells and positions are 0 to 65536 on each axis. */
export const FRAME = 65536
/** A cell this many pixels or more on both sides shows its label (FR1404). */
export const LABEL_PX = 40
/** An area with more than this share of its calls unresolved is hatched (FR1405). */
export const HATCH_SHARE = 0.04
/** At most this many bundles are drawn between areas at rest, plus every inferred one (FR1402). */
export const DRAWN_BUNDLES = 12

/** A directed pair of areas and the relationships from one to the other, by basis and type. */
export type Pair = { from: number; to: number; observed: number; inferred: number; types: Array<{ type: string; observed: number; inferred: number }> }
export type Terrain = {
  /** Each area's cell, or -1 for an area with no symbols, which has none and is drawn as a ghost. */
  areaCell: Int32Array
  /** Each cell's area, or -1 for the root and directories above the areas. */
  cellArea: Int32Array
  /** Each cell's depth below its area (the area's cell is 0), or -1 above the areas. */
  cellDepth: Int16Array
  isFile: Uint8Array
  /** Each cell's path; a directory's own files share their directory's path. */
  paths: string[]
  pairs: Pair[]
}

export function terrainOf(d: GalaxyData): Terrain {
  const { parent, names } = d.cells
  const n = parent.length
  const paths: string[] = new Array(n), kids = new Uint32Array(n), own = new Int32Array(n).fill(-1)
  for (let i = 0; i < n; i++) {
    const p = parent[i]!
    paths[i] = p < 0 ? '' : names[i] ? (paths[p] ? `${paths[p]}/${names[i]}` : names[i]!) : paths[p]!
    if (p >= 0) { kids[p]!++; if (!names[i]) own[p] = i }
  }
  const byPath = new Map<string, number>()
  for (let i = 0; i < n; i++) if (names[i] || parent[i]! < 0) byPath.set(paths[i]!, i)
  // An area of fewer than two directories holds only the files directly in it: its directory's own files when it also has subdirectories.
  const areaCell = new Int32Array(d.areas.length).fill(-1)
  d.areas.forEach((a, k) => {
    if (!a.count) return
    const path = a.name === '(root)' ? '' : a.name
    const at = byPath.get(path)
    if (at === undefined) return
    areaCell[k] = path.split('/').length < 2 && own[at]! >= 0 ? own[at]! : at
  })
  const cellArea = new Int32Array(n).fill(-1), cellDepth = new Int16Array(n).fill(-1), isFile = new Uint8Array(n)
  areaCell.forEach((c, k) => { if (c >= 0) { cellArea[c] = k; cellDepth[c] = 0 } })
  for (let i = 0; i < n; i++) {
    if (!kids[i]) isFile[i] = 1
    const p = parent[i]!
    if (cellArea[i]! < 0 && p >= 0 && cellArea[p]! >= 0) { cellArea[i] = cellArea[p]!; cellDepth[i] = cellDepth[p]! + 1 }
  }
  const byPair = new Map<number, Pair>()
  for (const [from, to, type, basis, count] of d.bundles) {
    const key = from * d.areas.length + to
    let p = byPair.get(key)
    if (!p) byPair.set(key, (p = { from, to, observed: 0, inferred: 0, types: [] }))
    let t = p.types.find((x) => x.type === d.relTypes[type])
    if (!t) p.types.push((t = { type: d.relTypes[type]!, observed: 0, inferred: 0 }))
    if (basis) { p.inferred += count; t.inferred += count } else { p.observed += count; t.observed += count }
  }
  const pairs = [...byPair.values()].sort((a, b) => b.observed + b.inferred - a.observed - a.inferred || a.from - b.from || a.to - b.to)
  for (const p of pairs) p.types.sort((a, b) => b.observed + b.inferred - a.observed - a.inferred || (a.type < b.type ? -1 : 1))
  return { areaCell, cellArea, cellDepth, isFile, paths, pairs }
}

/** A stroke the Terrain draws: one basis of one pair. */
export type Stroke = { pair: Pair; basis: 'observed' | 'inferred'; count: number }
/**
 * The bundles drawn (FR1402): at rest the DRAWN_BUNDLES strongest observed ones and every inferred one; while the pointer rests on an
 * area, every bundle into or out of it as well. Each pair is one solid stroke for its observed relationships and one dashed for its inferred.
 */
export function drawnStrokes(pairs: Pair[], hover: number | null): Stroke[] {
  const strongest = new Set(pairs.filter((p) => p.observed).sort((a, b) => b.observed - a.observed || a.from - b.from || a.to - b.to).slice(0, DRAWN_BUNDLES))
  const out: Stroke[] = []
  for (const p of pairs) {
    const touched = hover !== null && (p.from === hover || p.to === hover)
    if (p.observed && (strongest.has(p) || touched)) out.push({ pair: p, basis: 'observed', count: p.observed })
    if (p.inferred) out.push({ pair: p, basis: 'inferred', count: p.inferred })
  }
  return out
}

/** A bundle in words, with its direction and each basis's count, for its tooltip and its row in the lists (FR057). */
export function pairText(d: GalaxyData, p: Pair): string {
  const counts = [p.observed ? `${p.observed.toLocaleString('en')} observed` : '', p.inferred ? `${p.inferred.toLocaleString('en')} inferred` : ''].filter(Boolean).join(', ')
  return `${d.areas[p.from]!.name} → ${d.areas[p.to]!.name}: ${counts} (${p.types.map((t) => `${t.type} ${(t.observed + t.inferred).toLocaleString('en')}`).join(', ')})`
}

/** Whether an area is hatched for unresolved calls, and whether it holds files the graph could not analyse (FR1405). */
export function coverageOf(a: GalaxyArea): { hatched: boolean; ghost: boolean; text: string } {
  const f = areaFog(a)
  const hatched = a.calls.sites >= MIN_SITES ? a.calls.unresolved / a.calls.sites > HATCH_SHARE : false
  const parts = [
    ...(hatched ? [`${Math.round((a.calls.unresolved / a.calls.sites) * 100)}% of ${a.calls.sites.toLocaleString('en')} calls unresolved`] : []),
    ...(f.unanalysed ? [`${f.unanalysed.toLocaleString('en')} file${f.unanalysed === 1 ? '' : 's'} not analysed`] : []),
    ...(f.excluded ? [`${f.excluded.toLocaleString('en')} excluded`] : []),
  ]
  const why = a.gaps.map(([reason, k]) => `${reason} ${k.toLocaleString('en')}`).join(', ')
  return { hatched, ghost: f.unanalysed > 0, text: parts.length ? `${a.name}: ${parts.join(', ')}${why ? ` (${why})` : ''}` : '' }
}

/** Layout units to screen pixels: x * kx + bx, y * ky + by. A negative k flips that axis. */
export type View = { kx: number; bx: number; ky: number; by: number; width: number; height: number }
export type Rect = { left: number; top: number; width: number; height: number }
export const toScreen = (v: View, x: number, y: number, w: number, h: number): Rect => {
  const x0 = x * v.kx + v.bx, x1 = (x + w) * v.kx + v.bx, y0 = y * v.ky + v.by, y1 = (y + h) * v.ky + v.by
  return { left: Math.min(x0, x1), top: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) }
}
export const cellRect = (d: GalaxyData, v: View, c: number) => { const r = d.cells.rects; return toScreen(v, r[c * 4]!, r[c * 4 + 1]!, r[c * 4 + 2]!, r[c * 4 + 3]!) }

export type Label = { key: string; kind: 'area' | 'dir' | 'file' | 'symbol'; text: string; title: string; left: number; top: number; width: number; height: number; index: number }
const CHAR_PX = 7, LINE_PX = 16
/** The symbols' cell side on screen, about: the frame shared by every symbol, less the margins between groups. */
export const symbolSide = (d: GalaxyData, v: View) => (d.n ? (Math.abs(v.kx) * FRAME * 0.85) / Math.sqrt(d.n) : 0)

/**
 * The labels a view shows (FR1404): every area, then every other directory and file, whose cell is LABEL_PX or more on both sides,
 * at its top left; then, once a symbol's cell is that large, the visible symbols' names under their points. A label that would overlap
 * one already placed, or an area too small, is left to the tooltip and the table. Areas come first, largest first.
 */
export function labels(d: GalaxyData, t: Terrain, v: View, max = 400): Label[] {
  const placed: Label[] = []
  const free = (l: Label) => !placed.some((q) => l.left < q.left + q.width && q.left < l.left + l.width && l.top < q.top + q.height && q.top < l.top + l.height)
  const onScreen = (r: Rect) => r.left < v.width && r.top < v.height && r.left + r.width > 0 && r.top + r.height > 0
  const tryCell = (c: number, kind: Label['kind'], text: string, title: string, index: number) => {
    const r = cellRect(d, v, c)
    if (r.width < LABEL_PX || r.height < LABEL_PX || !onScreen(r)) return
    // A label may run past a narrow cell, but never over another label. An area's name and count take a line each when one line is wider than its cell.
    const lines = kind === 'area' && text.length * CHAR_PX + 8 > r.width - 8 ? text.split(' ') : [text]
    const l = { key: `c${c}`, kind, text, title, left: r.left + 4, top: r.top + 3, width: Math.max(...lines.map((x) => x.length)) * CHAR_PX + 8, height: lines.length * LINE_PX, index }
    // Where the top left is taken, such as by the area a first file starts in, the bottom left of a cell tall enough is tried.
    const low = { ...l, top: r.top + r.height - l.height - 3 }
    const at = free(l) ? l : low.top > l.top + l.height && free(low) ? low : null
    if (at) placed.push(at)
  }
  // An area's label is its name and count; its name never holds a space, which would split it, as a path segment may.
  d.areas.forEach((a, k) => { const c = t.areaCell[k]!; if (c >= 0) tryCell(c, 'area', `${areaLabel(a.name).replace(/ /g, '\u00a0')} ${a.count.toLocaleString('en')}`, a.name, k) })
  const inner: number[] = []
  for (let c = 0; c < t.cellArea.length; c++) if (t.cellDepth[c]! > 0 && d.cells.names[c]) inner.push(c)
  // Larger cells first, so a directory is named before the files in it.
  const area = (c: number) => d.cells.rects[c * 4 + 2]! * d.cells.rects[c * 4 + 3]!
  inner.sort((a, b) => area(b) - area(a) || a - b)
  for (const c of inner) {
    if (placed.length >= max) return placed
    tryCell(c, t.isFile[c] ? 'file' : 'dir', d.cells.names[c]!, t.paths[c]!, c)
  }
  const side = symbolSide(d, v)
  if (side < LABEL_PX) return placed
  for (let i = 0; i < d.n && placed.length < max; i++) {
    const x = d.positions[i * 2]! * v.kx + v.bx, y = d.positions[i * 2 + 1]! * v.ky + v.by
    if (x < 0 || y < 0 || x > v.width || y > v.height) continue
    const text = shortName(d.names[i]!)
    // Under the symbol's point, whose radius is an eighth of its cell.
    const w = text.length * CHAR_PX + 8
    const l = { key: `s${i}`, kind: 'symbol' as const, text, title: d.names[i]!, left: x - w / 2, top: y + side * 0.125 + 3, width: w, height: LINE_PX, index: i }
    if (free(l)) placed.push(l)
  }
  return placed
}

/** The Terrain's one-line summary: the areas, how many bundles are drawn of how many in all (FR1402), and areas holding only files the graph cannot see, never counted as empty (FR059). */
export function terrainSummary(g: GalaxyData, pairs: Pair[], drawn: number): string {
  const seen = g.areas.filter((a) => a.count > 0).length, hidden = g.areas.length - seen
  return `${plural(g.n, 'symbol')} in ${plural(seen, 'area')}; ${drawn} of ${plural(pairs.length, 'bundle')} between areas drawn${hidden ? `; ${hidden} more area${hidden === 1 ? ' holds' : 's hold'} files the graph cannot see` : ''}. Search, zoom into an area, or open a bundle.`
}
