// Pure functions behind the Diff view: what compare_snapshots reports, as tiles, as an ordered table, and as a tint over the Galaxy.
import type { GalaxyData } from './galaxyData'

/** id is the symbol's id in that side's snapshot: the head's for added and changed symbols, so a row opens with no name lookup (FR1301). */
export type ChangedSymbol = { id: string; qualified_name: string; kind: string; path: string; what?: string[] }
export type CompareData = {
  base: { snapshot_id: string; published_at: string; symbols: number; relationships: number; unresolved: number }
  head: { snapshot_id: string; published_at: string; symbols: number; relationships: number; unresolved: number }
  symbols: { counts: { added: number; removed: number; changed: number }; added: ChangedSymbol[]; removed: ChangedSymbol[]; changed: ChangedSymbol[] }
  relationships: { added: number; removed: number; by_type: Record<string, { added: number; removed: number }> }
  files: { added: string[]; removed: string[]; changed: string[]; disposition_changes: Array<{ path: string; from: string; to: string }> }
}
export type Change = 'added' | 'removed' | 'changed'
export type DiffRow = { change: Change; id: string; qualified_name: string; kind: string; path: string; what: string }

/** The summary tiles, in reading order. */
export function tiles(d: CompareData): Array<{ label: string; value: string }> {
  const rel = Object.entries(d.relationships.by_type).filter(([, v]) => v.added || v.removed).sort(([a], [b]) => (a < b ? -1 : 1))
  return [
    { label: 'Symbols added', value: d.symbols.counts.added.toLocaleString('en') },
    { label: 'Symbols removed', value: d.symbols.counts.removed.toLocaleString('en') },
    { label: 'Symbols changed', value: d.symbols.counts.changed.toLocaleString('en') },
    { label: 'Relationships', value: `+${d.relationships.added.toLocaleString('en')} −${d.relationships.removed.toLocaleString('en')}${rel.length ? ` (${rel.map(([t, v]) => `${t} +${v.added} −${v.removed}`).join(', ')})` : ''}` },
    { label: 'Files', value: `${d.files.added.length} added, ${d.files.removed.length} removed, ${d.files.changed.length} changed` },
    { label: 'Unresolved', value: `${d.base.unresolved.toLocaleString('en')} → ${d.head.unresolved.toLocaleString('en')}` },
  ]
}

/** Symbol changes as one table, ordered by path, then name, then change, so the order never depends on the answer's order. */
export function rows(d: CompareData, filter: { kinds?: Set<string>; changes?: Set<Change> } = {}): DiffRow[] {
  const all: DiffRow[] = [
    ...d.symbols.added.map((s) => ({ change: 'added' as const, id: s.id, qualified_name: s.qualified_name, kind: s.kind, path: s.path, what: '' })),
    ...d.symbols.removed.map((s) => ({ change: 'removed' as const, id: s.id, qualified_name: s.qualified_name, kind: s.kind, path: s.path, what: '' })),
    ...d.symbols.changed.map((s) => ({ change: 'changed' as const, id: s.id, qualified_name: s.qualified_name, kind: s.kind, path: s.path, what: (s.what ?? []).join(', ') })),
  ]
  return all
    .filter((r) => (!filter.kinds?.size || filter.kinds.has(r.kind)) && (!filter.changes?.size || filter.changes.has(r.change)))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.qualified_name < b.qualified_name ? -1 : a.qualified_name > b.qualified_name ? 1 : a.change < b.change ? -1 : a.change > b.change ? 1 : 0))
}

export const kinds = (d: CompareData): string[] => [...new Set([...d.symbols.added, ...d.symbols.removed, ...d.symbols.changed].map((s) => s.kind))].sort()

/** For each point of the head snapshot's Galaxy: 0 unchanged, 1 added, 2 changed. Removed symbols are not in the head, so they are listed, not drawn. */
export function overlay(g: GalaxyData, d: CompareData): Uint8Array {
  const at = new Map<string, number>()
  g.names.forEach((n, i) => at.set(n, i))
  const out = new Uint8Array(g.n)
  for (const s of d.symbols.added) { const i = at.get(s.qualified_name); if (i !== undefined) out[i] = 1 }
  for (const s of d.symbols.changed) { const i = at.get(s.qualified_name); if (i !== undefined) out[i] = 2 }
  return out
}

/** The Galaxy's hues for the overlay, by class. */
export const OVERLAY_RGB: Record<number, [number, number, number]> = { 1: [0.43, 0.91, 0.66], 2: [0.95, 0.72, 0.29] }
