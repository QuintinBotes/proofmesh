// Time (FR1761 to FR1765): what one step between neighbouring snapshots draws on the Terrain, from compare_snapshots alone. Pure, no
// DOM, so it is testable; Terrain.tsx draws the marks and TimeStrip.tsx the strip.
import type { SnapshotInfo } from './api'
import type { CompareData } from './diff'
import { shortName, type GalaxyData } from './galaxyData'
import { plural } from './plural'

/**
 * lines: only the declaration's line range changed (#7); members: a container whose body changed with a member that was added, removed
 * or changed. Neither is ringed as changed.
 */
export type MarkChange = 'added' | 'removed' | 'changed' | 'members' | 'lines' | 'moved'
/** Said in words and in the list, never drawn as a mark (FR1762). */
export const UNDRAWN = new Set<MarkChange>(['members', 'lines'])
/** x, y in layout units; from is where a moved symbol was; index is the head galaxy's point, null for a removed symbol. */
export type Mark = { change: MarkChange; name: string; x: number; y: number; from?: [number, number]; index: number | null; title: string }

/** Each name's first point. shortcut: a name two symbols share (overloads) marks the first; split by kind when that matters. */
function points(g: GalaxyData): Map<string, number> {
  const at = new Map<string, number>()
  g.names.forEach((n, i) => { if (!at.has(n)) at.set(n, i) })
  return at
}

const declared = (what: string[] | undefined) => (what ?? []).filter((w) => w === 'body' || w === 'signature')

/**
 * How compare_snapshots' changed symbol is drawn: changed when its body or signature changed, unless a member's change explains it.
 * shortcut: a container whose own text changed beside a member's (a decorator, an extends clause) is said as members; compare the
 * container's text without its members' when that matters.
 */
function kindOf(c: CompareData, s: { qualified_name: string; what?: string[] }): MarkChange {
  if (!declared(s.what).length) return 'lines'
  const inner = `${s.qualified_name}.`
  const moved = (x: { qualified_name: string; what?: string[] }) => x.qualified_name.startsWith(inner)
  return c.symbols.added.some(moved) || c.symbols.removed.some(moved) || c.symbols.changed.some((x) => moved(x) && declared(x.what).length) ? 'members' : 'changed'
}
const SAID: Record<'changed' | 'members' | 'lines', (what: string[]) => string> = {
  changed: (what) => `changed (${what.join(', ')})`, members: () => 'changed through its members', lines: () => 'moved lines, its declaration unchanged',
}

/** The marks of the step from base to head: added and changed where they are in head, removed where they were in base (FR1762). */
export function marks(base: GalaxyData, head: GalaxyData, c: CompareData): Mark[] {
  const was = points(base), now = points(head), out: Mark[] = []
  const put = (change: MarkChange, g: GalaxyData, i: number | undefined, name: string, words: string, from?: [number, number]) => {
    if (i === undefined) return
    out.push({ change, name, x: g.positions[i * 2]!, y: g.positions[i * 2 + 1]!, ...(from ? { from } : {}), index: g === head ? i : null, title: `${shortName(name)}: ${words}` })
  }
  // A module has no point of its own: an added, removed or changed file is marked amid its symbols.
  const file = (g: GalaxyData, s: { qualified_name: string; kind: string }, words: string, change: MarkChange) => {
    const inside = s.kind === 'module' ? g.names.flatMap((n, i) => (n.startsWith(`${s.qualified_name}:`) ? [i] : [])) : []
    if (!inside.length) return
    const mean = (axis: number) => Math.round(inside.reduce((t, i) => t + g.positions[i * 2 + axis]!, 0) / inside.length)
    out.push({ change, name: s.qualified_name, x: mean(0), y: mean(1), index: null, title: `${shortName(s.qualified_name)}: ${words}` })
  }
  for (const s of c.symbols.added) { const i = now.get(s.qualified_name); if (i === undefined) file(head, s, 'added, a new file', 'added'); else put('added', head, i, s.qualified_name, 'added') }
  for (const s of c.symbols.removed) { const i = was.get(s.qualified_name); if (i === undefined) file(base, s, 'removed, a file shown where it was', 'removed'); else put('removed', base, i, s.qualified_name, 'removed, shown where it was') }
  for (const s of c.symbols.changed) {
    const k = kindOf(c, s) as keyof typeof SAID, i = now.get(s.qualified_name)
    if (i === undefined) file(head, s, SAID[k](declared(s.what)), k); else put(k, head, i, s.qualified_name, SAID[k](declared(s.what)))
  }
  for (const p of c.symbols.paired ?? []) {
    const from = was.get(p.base.qualified_name)
    const words = [p.base.path !== p.head.path && `moved from ${p.base.path}`, shortName(p.base.qualified_name) !== shortName(p.head.qualified_name) && `renamed from ${shortName(p.base.qualified_name)}`].filter(Boolean).join(', ')
    put('moved', head, now.get(p.head.qualified_name), p.head.qualified_name, words || `moved from ${p.base.qualified_name}`, from === undefined ? undefined : [base.positions[from * 2]!, base.positions[from * 2 + 1]!])
  }
  return out
}

/** The step's counts as compare_snapshots gives them, its changed split into changed declarations, containers and moved lines. */
export function stepCounts(c: CompareData): Record<MarkChange, number> {
  const kinds = c.symbols.changed.map((s) => kindOf(c, s))
  const changed = kinds.filter((k) => k === 'changed').length, members = kinds.filter((k) => k === 'members').length
  return { added: c.symbols.counts.added, removed: c.symbols.counts.removed, changed, members, lines: c.symbols.counts.changed - changed - members, moved: c.symbols.paired?.length ?? 0 }
}

/** The snapshot one step older (-1) or newer (1) than id in a list newest first, or null at an end. */
export function neighbour(list: SnapshotInfo[], id: string, dir: -1 | 1): string | null {
  const k = list.findIndex((s) => s.id === id)
  return k < 0 ? null : list[k - dir]?.id ?? null
}

/** A snapshot's symbols and the share of its relationships left unresolved, for its row in the strip. */
export function shareText(s: SnapshotInfo): string {
  if (s.symbols == null || s.relationships == null || s.unresolved == null) return 'counts unavailable'
  const share = s.relationships ? (s.unresolved / s.relationships) * 100 : 0
  return `${plural(s.symbols, 'symbol')} · ${share.toLocaleString('en', { maximumFractionDigits: 1 })}% unresolved`
}

/** The snapshot a link names, or, when it is no longer listed, the oldest one listed: retention (gc) retires the oldest first (FR1765). */
export function linked(list: SnapshotInfo[], id: string): { id: string | null; gone: boolean } {
  return list.some((s) => s.id === id) ? { id, gone: false } : { id: list.at(-1)?.id ?? null, gone: true }
}
