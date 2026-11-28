// compare_snapshots (FR019, FR063): what changed between two sealed snapshots of one repository, each opened read-only (D03).
import type Database from 'better-sqlite3'
import { MIN_PAIR_TOKENS } from '../indexer/body-hash.js'

export type Sym = { id: string; name: string; qualified_name: string; kind: string; path: string; stable_key: string; body_hash: string | null; body_tokens: number | null; signature: string | null; start_line: number; end_line: number }
type Pair = { change: 'moved' | 'renamed' | 'moved_renamed'; kind: string; body_hash: string; base: Sym; head: Sym }
type Ambiguous = { kind: string; body_hash: string; removed: Sym[]; added: Sym[] }
type Side = { snapshot_id: string; published_at: string; symbols: number; relationships: number; unresolved: number }
export type Comparison = {
  base: Side; head: Side
  symbols: {
    counts: { added: number; removed: number; changed: number; paired: number; ambiguous: number; too_small: number }
    added: Sym[]; removed: Sym[]; changed: Array<Sym & { what: string[]; base_id: string; base_stable_key: string; base_body_hash: string | null }>
    paired: Pair[]; ambiguous: Ambiguous[]
  }
  relationships: { added: number; removed: number; by_type: Record<string, { added: number; removed: number }> }
  files: { added: string[]; removed: string[]; changed: string[]; disposition_changes: Array<{ path: string; from: string; to: string }> }
}

const symbolKey = (s: Sym) => `${s.kind}\u0000${s.qualified_name}`

/** Whether the snapshot was sealed with body hashes (format 0.7); an older file has no such column and its symbols have none (FR135). */
export const hasBodyHash = (db: Database.Database): boolean => db.prepare("select 1 from pragma_table_info('symbol') where name = 'body_hash'").get() !== undefined

/** The files whose content was unreadable when the snapshot was sealed, so their symbols have no hash (FR135). */
export function unreadableFiles(db: Database.Database): { count: number; paths: string[] } {
  const row = db.prepare("select value from meta where key = 'body_hash_missing'").get() as { value: string } | undefined
  return row ? (JSON.parse(row.value) as { count: number; paths: string[] }) : { count: 0, paths: [] }
}
const unreadableNote = (u: { count: number; paths: string[] }, side: string) =>
  `The content of ${u.paths.join(', ')}${u.count > u.paths.length ? ` and ${u.count - u.paths.length} more` : ''} was unavailable when the ${side} snapshot was sealed, so its symbols there have no body hash and are never paired.`

export function symbols(db: Database.Database): Map<string, Sym> {
  const rows = db.prepare(`select s.id, s.name, s.qualified_name, s.kind, f.path, s.stable_key, ${hasBodyHash(db) ? 's.body_hash, s.body_tokens' : 'null as body_hash, null as body_tokens'}, s.signature, s.start_line, s.end_line from symbol s join file f on f.id = s.file_id order by s.qualified_name, s.kind, f.path, s.start_line, s.start_byte, s.id`).all() as Sym[]
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

export function side(db: Database.Database, snapshot_id: string, published_at: string): Side {
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n
  return { snapshot_id, published_at, symbols: n('select count(*) n from symbol'), relationships: n('select count(*) n from assertion'), unresolved: n("select count(*) n from assertion where resolution not in ('resolved', 'resolved_external')") }
}

const NOT_PAIRED = `Pairing needs exactly one removed and one added symbol of the same kind and body hash, and at least ${MIN_PAIR_TOKENS} tokens of normalised text, in files that differ or inside containers that differ (moved), under names that differ (renamed) or both; any other match is listed as ambiguous with its candidates, and a symbol with no hash is never paired.`
const NO_HASHES = 'A snapshot sealed before body hashes existed has none, so nothing it holds is paired and no body change is reported; index it again to compute them.'
const TOO_SMALL = (n: number) => `${n} match${n === 1 ? '' : 'es'} below ${MIN_PAIR_TOKENS} tokens were not paired: a body that small is the same text under many names.`

/** The name's own container: the qualified name without its last segment. */
const container = (s: Sym) => (s.qualified_name.endsWith(s.name) ? s.qualified_name.slice(0, -s.name.length) : s.qualified_name)

/** Removed and added symbols of one kind and hash: one on each side is a pair, any other count an ambiguous entry (FR133, FR134). */
export function pairUp(added: Sym[], removed: Sym[]): { paired: Pair[]; ambiguous: Ambiguous[]; tooSmall: number; left: { added: Set<Sym>; removed: Set<Sym> } } {
  const group = (xs: Sym[]) => { const m = new Map<string, Sym[]>(); for (const x of xs) if (x.body_hash) { const k = `${x.kind}\u0000${x.body_hash}`; m.set(k, [...(m.get(k) ?? []), x]) } return m }
  const gone = group(removed), came = group(added)
  const paired: Pair[] = [], ambiguous: Ambiguous[] = []
  let tooSmall = 0
  for (const [k, rs] of [...gone].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const as = came.get(k)
    if (!as) continue
    const b = rs[0]!, h = as[0]!
    if ((b.body_tokens ?? 0) < MIN_PAIR_TOKENS) { tooSmall++; continue }
    // A module's name is its file's, so a moved file is `moved` whatever it is now called; a symbol that changed container is moved too.
    const isModule = b.kind === 'module'
    const moved = b.path !== h.path || (!isModule && container(b) !== container(h)), renamed = !isModule && b.name !== h.name
    if (rs.length === 1 && as.length === 1 && (moved || renamed)) paired.push({ change: moved && renamed ? 'moved_renamed' : moved ? 'moved' : 'renamed', kind: b.kind, body_hash: b.body_hash!, base: b, head: h })
    else ambiguous.push({ kind: b.kind, body_hash: b.body_hash!, removed: rs, added: as })
  }
  const taken = new Set(paired.flatMap((p) => [p.base, p.head]))
  const order = (a: Sym, b: Sym) => (a.qualified_name < b.qualified_name ? -1 : a.qualified_name > b.qualified_name ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : a.start_line - b.start_line || (a.id < b.id ? -1 : 1))
  paired.sort((x, y) => order(x.base, y.base))
  ambiguous.sort((x, y) => order(x.removed[0]!, y.removed[0]!))
  return { paired, ambiguous, tooSmall, left: { added: new Set(added.filter((x) => !taken.has(x))), removed: new Set(removed.filter((x) => !taken.has(x))) } }
}

export function compare(base: Database.Database, head: Database.Database, ids: { base: { id: string; published_at: string }; head: { id: string; published_at: string } }, maxRows: number): { data: Comparison; truncated: boolean; limitations: string[] } {
  const bs = symbols(base), hs = symbols(head)
  const unhashed = !hasBodyHash(base) || !hasBodyHash(head)
  const matched: Sym[] = [], unmatched: Sym[] = [], changed: Comparison['symbols']['changed'] = []
  for (const [k, h] of hs) {
    const b = bs.get(k)
    if (!b) { matched.push(h); continue }
    // A module's text is its file's, already listed under files.changed, so only a declaration's body change is a symbol's.
    const what = [b.signature !== h.signature && 'signature', (b.start_line !== h.start_line || b.end_line !== h.end_line) && 'range', b.path !== h.path && 'path', h.kind !== 'module' && b.body_hash && h.body_hash && b.body_hash !== h.body_hash && 'body'].filter((x): x is string => !!x)
    if (what.length) changed.push({ ...h, what, base_id: b.id, base_stable_key: b.stable_key, base_body_hash: b.body_hash })
  }
  for (const [k, b] of bs) if (!hs.has(k)) unmatched.push(b)
  const { paired, ambiguous, tooSmall, left } = pairUp(matched, unmatched)
  const added = matched.filter((x) => left.added.has(x)), removed = unmatched.filter((x) => left.removed.has(x))

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
  const truncated = [added, removed, changed, paired, ambiguous, fAdded, fRemoved, fChanged, disposition_changes].some((xs) => xs.length > maxRows)
  return {
    truncated,
    limitations: [unhashed ? NO_HASHES : NOT_PAIRED, ...(tooSmall ? [TOO_SMALL(tooSmall)] : []), ...(hasBodyHash(base) && unreadableFiles(base).count ? [unreadableNote(unreadableFiles(base), 'base')] : []), ...(hasBodyHash(head) && unreadableFiles(head).count ? [unreadableNote(unreadableFiles(head), 'head')] : [])],
    data: {
      base: side(base, ids.base.id, ids.base.published_at), head: side(head, ids.head.id, ids.head.published_at),
      symbols: { counts: { added: added.length, removed: removed.length, changed: changed.length, paired: paired.length, ambiguous: ambiguous.length, too_small: tooSmall }, added: cut(added), removed: cut(removed), changed: cut(changed), paired: cut(paired), ambiguous: cut(ambiguous) },
      relationships: { added: sum('added'), removed: sum('removed'), by_type: Object.fromEntries(Object.entries(by_type).sort()) },
      files: { added: cut(fAdded.sort()), removed: cut(fRemoved), changed: cut(fChanged.sort()), disposition_changes: cut(disposition_changes.sort((a, b) => (a.path < b.path ? -1 : 1))) },
    },
  }
}
