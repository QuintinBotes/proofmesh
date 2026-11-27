// Change review's model (FR1810 to FR1816): an impact_completeness answer as the rows a reviewer reads, the gate, and the marks the
// Terrain draws. It only arranges what the tool says; every status is the tool's. Pure, no DOM, so it is testable.
import type { GalaxyData } from './galaxyData'
import { cellRect, type Rect, type Terrain, type View } from './terrainModel'
import { plural } from './plural'

export type Hop = { name: string; key?: string; path: string; line: number; assertion_id?: string }
export type Test = { key?: string; name: string; path: string; line: number; evidence: string; depth: number; basis: string; changed: boolean }
export type Dependent = { id: string; key?: string; name: string; path: string; line: number; relation: string; via: string | null; basis: string; status: 'changed' | 'tested' | 'neither'; test: Test | null; chain: Hop[] }
export type Changed = { id: string; key: string; name: string; path: string; line: number; change: 'added' | 'modified' | 'deleted'; status: 'tested' | 'neither'; test: Test | null; dependents: Dependent[] }
export type Totals = { changed_symbols: number; dependents: number; changed: number; tested: number; neither: number; by_basis: { observed: number; inferred: number } }
export type Side = { commit: string | null; snapshot_id: string | null }
export type Completeness = { base: Side; head: Side; pending: Array<{ commit: string | null; job_id: string }>; changed: Changed[]; totals: Totals }

/** A base and head as a link names them: `?change=<base>..<head>`, or `?change=<base>` for the working tree (FR1812). */
export type Range = { base: string; head: string | null }
export function parseRange(text: string | null): Range | null {
  const t = text?.trim()
  if (!t) return null
  const at = t.indexOf('..')
  if (at < 0) return { base: t, head: null }
  const base = t.slice(0, at), head = t.slice(at + 2)
  return base ? { base, head: head || null } : null
}
export const rangeText = (r: Range) => (r.head ? `${r.base}..${r.head}` : r.base)
/** A side in words: its commit shortened, or `working tree`. */
export const sideText = (s: Side) => (s.commit ? s.commit.slice(0, 12) : 'working tree')

/** One row of the list: a changed symbol, or one of its dependents; `snapshot` is where its ids are, the base's for a deleted symbol's. */
export type Row = { id: string; changed: Changed; dependent: Dependent | null; snapshot: string }
export function reviewRows(d: Completeness): Row[] {
  return d.changed.flatMap((c, i) => {
    const snapshot = (c.change === 'deleted' ? d.base.snapshot_id : d.head.snapshot_id) ?? ''
    return [{ id: `${i}`, changed: c, dependent: null, snapshot }, ...c.dependents.map((x, j) => ({ id: `${i}.${j}`, changed: c, dependent: x, snapshot }))]
  })
}

const testText = (t: Test) => `${t.name} ${t.path}:${t.line} ${t.evidence} depth=${t.depth}${t.changed ? ' (test changed)' : ''}`
/** What a row says of itself, as impact_completeness's lean rows do: its status, its test, and what it reaches the change through. */
export function rowWords(r: Row): string {
  const x = r.dependent ?? r.changed
  const status = x.test ? `tested: ${testText(x.test)}` : x.status
  return r.dependent ? [status, ...(r.dependent.via ? [`(via ${r.dependent.via})`] : []), ...(r.dependent.basis === 'inferred' ? ['inferred'] : [])].join(' ') : `${r.changed.change}, ${status}`
}
/** A row's name and site: a dependent at the site that names the change, a changed symbol at its declaration. */
export const rowTitle = (r: Row) => (r.dependent ? `${r.dependent.relation} ${r.dependent.name} ${r.dependent.path}:${r.dependent.line}` : `${r.changed.name} ${r.changed.path}:${r.changed.line}`)

/** The summary line, in impact_completeness's words (FR113). */
export const summaryText = (t: Totals) => `${plural(t.changed_symbols, 'changed symbol')}; ${plural(t.dependents, 'dependent')}: ${t.changed} changed, ${t.tested} tested, ${t.neither} neither${t.by_basis.inferred ? `; ${t.by_basis.inferred} inferred` : ''}`
/** The gate fails while any dependent is neither changed nor tested, as `proofmesh completeness` exits 1 (FR114). */
export const gate = (t: Totals) => (t.neither ? { passing: false, text: `failing: ${plural(t.neither, 'dependent')} neither changed nor tested` } : { passing: true, text: 'passing: every dependent is changed or tested' })

/** A chain hop in words: the hop, how it reaches the next, and where; the last hop is the change itself. */
export function hopText(hops: Hop[], i: number, relation: string): string {
  const h = hops[i]!, next = hops[i + 1]
  return next ? `${h.name} ${i === 0 ? relation : '→'} ${next.name} at ${h.path}:${h.line}` : `${h.name}, changed, declared at ${h.path}:${h.line}`
}

/** What a mark stands for (FR1814): a changed symbol by its change, a dependent by its status. */
export type MarkKind = 'modified' | 'added' | 'deleted' | 'changed' | 'tested' | 'neither'
export const MARK_WORDS: Record<MarkKind, string> = {
  modified: 'changed symbol: filled dot with a ring', added: 'added symbol: filled dot', deleted: 'removed symbol: cross at its old place',
  changed: 'dependent changed: solid ring', tested: 'dependent tested: double ring', neither: 'dependent neither: dashed ring',
}
export type Mark = { kind: MarkKind; row: Row; title: string } & ({ point: number; base?: boolean } | { cell: number })

/**
 * The marks for the rows (FR1814): each at its symbol's point in head, a deleted symbol's at its point in base, a file row at its
 * file's cell or, for a file with no symbols on the map, its nearest directory's. `head` and `base` are the points of each row's key,
 * by row id, from /api/v1/galaxy/points. Rows that have no place are counted, never dropped from the list.
 */
export function marksOf(rows: Row[], t: Terrain, head: Map<string, number>, base: Map<string, number>): { marks: Mark[]; unplaced: number } {
  const marks: Mark[] = []
  let unplaced = 0
  const cellOf = (path: string) => {
    const parts = path.split('/')
    for (let k = parts.length; k > 0; k--) { const c = t.paths.indexOf(parts.slice(0, k).join('/')); if (c >= 0) return c }
    return -1
  }
  for (const r of rows) {
    const kind: MarkKind = r.dependent ? r.dependent.status : r.changed.change
    const title = `${rowTitle(r)}: ${rowWords(r)}`
    const deleted = !r.dependent && r.changed.change === 'deleted'
    const point = (deleted ? base : head).get(r.id) ?? -1
    if (point >= 0) { marks.push({ kind, row: r, title, point, ...(deleted ? { base: true } : {}) }); continue }
    // An importing file, or a changed module (whose name is its path), has no point: it is drawn at its file's cell.
    const file = r.dependent ? r.dependent.relation === 'imports' : r.changed.name === r.changed.path
    const cell = file && !deleted ? cellOf((r.dependent ?? r.changed).path) : -1
    if (cell >= 0) marks.push({ kind, row: r, title, cell })
    else unplaced++
  }
  return { marks, unplaced }
}

/** Where a mark sits on screen: its point, or its cell's centre. `base` holds the base snapshot's points for deleted symbols. */
export function markAt(m: Mark, head: GalaxyData, base: GalaxyData | null, v: View): { x: number; y: number } | null {
  if ('cell' in m) { const q: Rect = cellRect(head, v, m.cell); return { x: q.left + q.width / 2, y: q.top + q.height / 2 } }
  const g = m.base ? base : head
  if (!g) return null
  return { x: g.positions[m.point * 2]! * v.kx + v.bx, y: g.positions[m.point * 2 + 1]! * v.ky + v.by }
}

/** How many rows of each kind of mark, for the legend, so counts by status stay in view however long the list (FR058). */
export function markCounts(rows: Row[]): Record<MarkKind, number> {
  const out: Record<MarkKind, number> = { modified: 0, added: 0, deleted: 0, changed: 0, tested: 0, neither: 0 }
  for (const r of rows) out[r.dependent ? r.dependent.status : r.changed.change]++
  return out
}
