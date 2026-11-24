// compare_snapshots (FR019, FR063): what changed between two sealed snapshots of one repository, each opened read-only (D03).
import type Database from 'better-sqlite3'

type Sym = { qualified_name: string; kind: string; path: string; signature: string | null; start_line: number; end_line: number }
type Side = { snapshot_id: string; published_at: string; symbols: number; relationships: number; unresolved: number }
export type Comparison = {
  base: Side; head: Side
  symbols: { counts: { added: number; removed: number; changed: number }; added: Sym[]; removed: Sym[]; changed: Array<Sym & { what: string[] }> }
  relationships: { added: number; removed: number; by_type: Record<string, { added: number; removed: number }> }
  files: { added: string[]; removed: string[]; changed: string[]; disposition_changes: Array<{ path: string; from: string; to: string }> }
}

const symbolKey = (s: Sym) => `${s.kind}\u0000${s.qualified_name}`

function symbols(db: Database.Database): Map<string, Sym> {
  const rows = db.prepare('select s.qualified_name, s.kind, f.path, s.signature, s.start_line, s.end_line from symbol s join file f on f.id = s.file_id order by s.qualified_name, s.kind').all() as Sym[]
  // shortcut: two declarations with one kind and qualified name (overloads, partial classes) collapse to the last; split by signature when that matters.
  return new Map(rows.map((s) => [symbolKey(s), s]))
}

/** A relationship as a snapshot-independent string: type, source and target by name, and resolution. */
function relationships(db: Database.Database): Map<string, number> {
  const rows = db.prepare(`select a.type, a.resolution,
      coalesce(ss.qualified_name, sf.path) as src,
      coalesce(ts.qualified_name, tf.path, x.module || ':' || x.name, a.reason) as dst
    from assertion a
    left join symbol ss on a.source_kind = 'symbol' and ss.id = a.source_id left join file sf on a.source_kind = 'file' and sf.id = a.source_id
    left join symbol ts on a.target_kind = 'symbol' and ts.id = a.target_id left join file tf on a.target_kind = 'file' and tf.id = a.target_id
    left join external_symbol x on a.target_kind = 'external' and x.id = a.target_id`).all() as Array<{ type: string; resolution: string; src: string; dst: string }>
  const out = new Map<string, number>()
  for (const r of rows) { const k = `${r.type}\u0000${r.src}\u0000${r.dst}\u0000${r.resolution}`; out.set(k, (out.get(k) ?? 0) + 1) }
  return out
}

function side(db: Database.Database, snapshot_id: string, published_at: string): Side {
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n
  return { snapshot_id, published_at, symbols: n('select count(*) n from symbol'), relationships: n('select count(*) n from assertion'), unresolved: n("select count(*) n from assertion where resolution not in ('resolved', 'resolved_external')") }
}

export function compare(base: Database.Database, head: Database.Database, ids: { base: { id: string; published_at: string }; head: { id: string; published_at: string } }, maxRows: number): { data: Comparison; truncated: boolean } {
  const bs = symbols(base), hs = symbols(head)
  const added: Sym[] = [], removed: Sym[] = [], changed: Array<Sym & { what: string[] }> = []
  for (const [k, h] of hs) {
    const b = bs.get(k)
    if (!b) { added.push(h); continue }
    const what = [b.signature !== h.signature && 'signature', (b.start_line !== h.start_line || b.end_line !== h.end_line) && 'range', b.path !== h.path && 'path'].filter((x): x is string => !!x)
    if (what.length) changed.push({ ...h, what })
  }
  for (const [k, b] of bs) if (!hs.has(k)) removed.push(b)

  const br = relationships(base), hr = relationships(head)
  const by_type: Record<string, { added: number; removed: number }> = {}
  const bump = (type: string, field: 'added' | 'removed', n: number) => { (by_type[type] ??= { added: 0, removed: 0 })[field] += n }
  for (const [k, n] of hr) { const d = n - (br.get(k) ?? 0); if (d > 0) bump(k.split('\u0000')[0]!, 'added', d) }
  for (const [k, n] of br) { const d = n - (hr.get(k) ?? 0); if (d > 0) bump(k.split('\u0000')[0]!, 'removed', d) }
  const sum = (field: 'added' | 'removed') => Object.values(by_type).reduce((a, t) => a + t[field], 0)

  type F = { path: string; content_hash: string | null; disposition: string }
  const files = (db: Database.Database) => new Map((db.prepare('select path, content_hash, disposition from file').all() as F[]).map((f) => [f.path, f]))
  const bf = files(base), hf = files(head)
  const fAdded: string[] = [], fChanged: string[] = [], disposition_changes: Comparison['files']['disposition_changes'] = []
  for (const [p, h] of hf) {
    const b = bf.get(p)
    if (!b) { fAdded.push(p); continue }
    if (b.content_hash !== h.content_hash) fChanged.push(p)
    if (b.disposition !== h.disposition) disposition_changes.push({ path: p, from: b.disposition, to: h.disposition })
  }
  const fRemoved = [...bf.keys()].filter((p) => !hf.has(p)).sort()

  const cut = <T>(xs: T[]) => xs.slice(0, maxRows)
  const truncated = [added, removed, changed, fAdded, fRemoved, fChanged, disposition_changes].some((xs) => xs.length > maxRows)
  return {
    truncated,
    data: {
      base: side(base, ids.base.id, ids.base.published_at), head: side(head, ids.head.id, ids.head.published_at),
      symbols: { counts: { added: added.length, removed: removed.length, changed: changed.length }, added: cut(added), removed: cut(removed), changed: cut(changed) },
      relationships: { added: sum('added'), removed: sum('removed'), by_type: Object.fromEntries(Object.entries(by_type).sort()) },
      files: { added: cut(fAdded.sort()), removed: cut(fRemoved), changed: cut(fChanged.sort()), disposition_changes: cut(disposition_changes.sort((a, b) => (a.path < b.path ? -1 : 1))) },
    },
  }
}
