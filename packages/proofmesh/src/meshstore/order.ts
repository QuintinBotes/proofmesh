import type Database from 'better-sqlite3'

// Ids are built from where a repository is checked out, so a tie broken on an id lists rows differently in two checkouts (issue 70).
// These keys use only what the repository holds: its relative path, then position, then name, then kind.
export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const pad = (n: number | null): string => String(n ?? 0).padStart(10, '0')
const SEP = '\u0000'

type Memo = { node: Map<string, string>; assertion: Map<string, string>; evidence: Map<string, string> }
const memo = new WeakMap<Database.Database, Memo>()
const of = (db: Database.Database): Memo => {
  let m = memo.get(db)
  if (!m) memo.set(db, (m = { node: new Map(), assertion: new Map(), evidence: new Map() }))
  return m
}
/** A bare edge table, as the traversal tests build, holds no locations; its keys are the ids. */
const located = new WeakMap<Database.Database, boolean>()
const hasLocations = (db: Database.Database): boolean => {
  let v = located.get(db)
  if (v === undefined) located.set(db, (v = db.prepare("select 1 from sqlite_master where type = 'table' and name = 'symbol'").get() !== undefined))
  return v
}
const cached = (db: Database.Database, map: Map<string, string>, id: string, make: () => string): string => {
  if (!hasLocations(db)) return id
  let k = map.get(id)
  if (k === undefined) map.set(id, (k = make()))
  return k
}

/** Where a symbol, file or external symbol sits, as a string that sorts by path, position, name, kind. */
export const nodeKey = (db: Database.Database, id: string): string => cached(db, of(db).node, id, () => {
  const s = db.prepare('select f.path, s.start_byte, s.qualified_name, s.kind from symbol s join file f on f.id = s.file_id where s.id = ?').get(id) as { path: string; start_byte: number; qualified_name: string; kind: string } | undefined
  if (s) return [s.path, pad(s.start_byte), s.qualified_name, s.kind].join(SEP)
  const f = db.prepare('select path from file where id = ?').get(id) as { path: string } | undefined
  if (f) return [f.path, pad(0), '', 'file'].join(SEP)
  const x = db.prepare('select module, name from external_symbol where id = ?').get(id) as { module: string; name: string } | undefined
  return x ? ['￿', x.module, x.name].join(SEP) : `￿${SEP}${id}`
})

/** The site of an evidence row, as a string that sorts by path then position. */
export const evidenceKey = (db: Database.Database, id: string): string => cached(db, of(db).evidence, id, () => {
  const e = db.prepare('select f.path, e.start_byte, e.end_byte from evidence e join file f on f.id = e.file_id where e.id = ?').get(id) as { path: string; start_byte: number; end_byte: number } | undefined
  return e ? [e.path, pad(e.start_byte), pad(e.end_byte)].join(SEP) : `￿${SEP}${id}`
})

/** Where an assertion is made (its first evidence), then its type, then the node on its far side. */
export const assertionKey = (db: Database.Database, id: string): string => cached(db, of(db).assertion, id, () => {
  const e = db.prepare('select f.path, e.start_byte, a.type from assertion a left join assertion_evidence ae on ae.assertion_id = a.id left join evidence e on e.id = ae.evidence_id left join file f on f.id = e.file_id where a.id = ? order by f.path, e.start_byte limit 1').get(id) as { path: string | null; start_byte: number | null; type: string } | undefined
  return e ? [e.path ?? '', pad(e.start_byte), e.type].join(SEP) : ''
})

/** Order ids by key, an id deciding only between two keys that are equal. */
export const byKey = (key: (id: string) => string) => (a: string, b: string): number => cmp(key(a), key(b)) || cmp(a, b)

/** Select columns that give an assertion row its location key; the far side is the target for an outgoing row and the source for an incoming one. */
export const siteColumns = (a: string, far: 'target_id' | 'source_id'): string =>
  `(select f.path from assertion_evidence ae join evidence e on e.id = ae.evidence_id join file f on f.id = e.file_id where ae.assertion_id = ${a}.id order by f.path, e.start_byte limit 1) as _path,
   (select e.start_byte from assertion_evidence ae join evidence e on e.id = ae.evidence_id join file f on f.id = e.file_id where ae.assertion_id = ${a}.id order by f.path, e.start_byte limit 1) as _byte,
   coalesce((select s.qualified_name from symbol s where s.id = ${a}.${far}), (select x.module || ':' || x.name from external_symbol x where x.id = ${a}.${far}), (select p.path from file p where p.id = ${a}.${far}), '') as _far`
export const SITE_ORDER = '_path, _byte, type, _far, id'
export type Sited = { id: string; type: string; _path: string | null; _byte: number | null; _far: string }
export const bySite = (x: Sited, y: Sited): number => cmp(x._path ?? '', y._path ?? '') || (x._byte ?? 0) - (y._byte ?? 0) || cmp(x.type, y.type) || cmp(x._far, y._far) || cmp(x.id, y.id)
